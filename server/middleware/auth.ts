import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import { userDb } from '../database/db.js';
import { IS_PLATFORM } from '../constants/config.js';
import { security } from '../utils/logger.js';
import type { Request, Response, NextFunction } from 'express';
import type { AuthRequest, JwtPayload, User } from '../types/index.js';

const getHeader = (req: Request, name: string): string | undefined => {
  const val = req.headers[name];
  return Array.isArray(val) ? val[0] : val;
};

// JWT Secret configuration
const DEV_JWT_SECRET = 'claude-ui-dev-secret-do-not-use-in-production';
const JWT_SECRET = process.env.JWT_SECRET || (process.env.NODE_ENV === 'production' ? '' : DEV_JWT_SECRET);

if (!JWT_SECRET || (process.env.NODE_ENV === 'production' && JWT_SECRET.length < 32)) {
  console.error('');
  console.error('SECURITY ERROR: JWT_SECRET environment variable is not set or too short');
  console.error('   Minimum length: 32 characters');
  console.error('');
  console.error('   Generate a secure secret with one of these commands:');
  console.error('   openssl rand -base64 32');
  console.error('   node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'base64\'))"');
  console.error('');
  console.error('   Then add it to your .env file:');
  console.error('   JWT_SECRET=your_generated_secret_here');
  console.error('');
  process.exit(1);
}

if (JWT_SECRET === DEV_JWT_SECRET) {
  console.warn('[WARN] Using default JWT_SECRET for development. Do NOT use this in production!');
}

// Token expiry configuration
const TOKEN_EXPIRY: string = process.env.TOKEN_EXPIRY || '1h'; // Default: 1 hour (refresh tokens handle longer sessions)
const REFRESH_TOKEN_EXPIRY = '30d'; // 30 days

// Separate secret for refresh tokens
const REFRESH_TOKEN_SECRET: string = process.env.REFRESH_TOKEN_SECRET || JWT_SECRET;

if (!process.env.REFRESH_TOKEN_SECRET) {
  console.warn('[WARN] REFRESH_TOKEN_SECRET is not set. Falling back to JWT_SECRET.');
  console.warn('  For improved security, set a separate REFRESH_TOKEN_SECRET in your .env file.');
}

// Platform mode configuration
const TRUSTED_PROXIES: string[] = process.env.TRUSTED_PROXIES
  ? process.env.TRUSTED_PROXIES.split(',').map((ip: string) => ip.trim())
  : [];

// Validate Platform mode configuration
if (IS_PLATFORM && TRUSTED_PROXIES.length > 0) {
  console.log('[INFO] Platform mode: Trusted proxies configured:', TRUSTED_PROXIES.join(', '));
}

if (IS_PLATFORM && TRUSTED_PROXIES.length === 0) {
  console.error('[SECURITY] Platform mode requires TRUSTED_PROXIES to be configured');
  console.error('  Set TRUSTED_PROXIES=ip1,ip2 or TRUSTED_PROXIES=10.0.0.0/8');
  // Defer exit to allow error to be seen; only exit if actually in platform mode
  setTimeout(() => process.exit(1), 100);
}

// IP normalization and CIDR helpers
function normalizeIP(ip: string | undefined): string {
  if (!ip) return '';
  // Strip IPv6 prefix from IPv4-mapped addresses
  return ip.replace(/^::ffff:/, '');
}

function isInCIDR(ip: string, cidr: string): boolean {
  const [range, bits] = cidr.split('/');
  const mask = parseInt(bits, 10);
  if (isNaN(mask) || mask < 0 || mask > 32) return false;

  const ipParts = normalizeIP(ip).split('.').map(Number);
  const rangeParts = normalizeIP(range).split('.').map(Number);

  if (ipParts.length !== 4 || rangeParts.length !== 4) return false;
  if (ipParts.some((p: number) => isNaN(p)) || rangeParts.some((p: number) => isNaN(p))) return false;

  const ipNum = ((ipParts[0] << 24) + (ipParts[1] << 16) + (ipParts[2] << 8) + ipParts[3]) >>> 0;
  const rangeNum = ((rangeParts[0] << 24) + (rangeParts[1] << 16) + (rangeParts[2] << 8) + rangeParts[3]) >>> 0;
  const maskNum = mask === 0 ? 0 : (~0 << (32 - mask)) >>> 0;

  return (ipNum & maskNum) === (rangeNum & maskNum);
}

interface DecodedToken {
  userId: number;
  username: string;
  type?: string;
  iat?: number;
  exp?: number;
}

// Optional API key middleware
const validateApiKey = (req: Request, res: Response, next: NextFunction): void => {
  // Skip API key validation if not configured
  const configuredApiKey = process.env.API_KEY;
  if (!configuredApiKey) {
    return next();
  }

  const apiKeyHeader = req.headers['x-api-key'];
  const apiKey = Array.isArray(apiKeyHeader) ? apiKeyHeader[0] : apiKeyHeader;

  // Early return if no API key provided (avoid unnecessary crypto operations)
  if (!apiKey) {
    security.authAttempt(false, 'api-key', req.ip || 'unknown', { method: 'api_key', reason: 'missing_key' });
    res.status(401).json({ error: 'Invalid API key' });
    return;
  }

  // Use HMAC to normalize both values to equal-length hashes before timing-safe comparison
  // This prevents leaking length information through early return on length mismatch
  // The random HMAC key is generated per-request to prevent precomputation attacks
  const hmacKey = crypto.randomBytes(32);
  const provided = crypto.createHmac('sha256', hmacKey).update(apiKey).digest();
  const expected = crypto.createHmac('sha256', hmacKey).update(configuredApiKey).digest();

  if (!crypto.timingSafeEqual(provided, expected)) {
    security.authAttempt(false, 'api-key', req.ip || 'unknown', { method: 'api_key', reason: 'invalid_key' });
    res.status(401).json({ error: 'Invalid API key' });
    return;
  }

  next();
};

// JWT authentication middleware
const authenticateToken = async (req: AuthRequest, res: Response, next: NextFunction): Promise<void> => {
  // Platform mode: Enhanced security validation
  if (IS_PLATFORM) {
    try {
      // Use the actual TCP peer address for proxy validation
      const peerAddress = req.socket.remoteAddress;

      // Validate trusted proxy if configured
      if (TRUSTED_PROXIES.length > 0) {
        const isTrustedProxy = TRUSTED_PROXIES.some((trustedIp: string) => {
          const normalizedPeer = normalizeIP(peerAddress);
          if (trustedIp.includes('/')) {
            return isInCIDR(normalizedPeer, trustedIp);
          }
          return normalizedPeer === normalizeIP(trustedIp);
        });

        if (!isTrustedProxy) {
          console.warn(`[SECURITY] Platform mode: Untrusted proxy IP: ${peerAddress}`);
          res.status(403).json({
            error: 'Forbidden',
            message: 'Request from untrusted proxy'
          });
          return;
        }
      }

      // Validate proxy identity headers
      const proxyUserId = getHeader(req, 'x-proxy-user-id');
      const proxyUsername = getHeader(req, 'x-proxy-username');
      const proxyEmail = getHeader(req, 'x-proxy-email');

      if (!proxyUserId || !proxyUsername) {
        console.error('[SECURITY] Platform mode: Missing required proxy identity headers');
        console.error('  Expected: x-proxy-user-id, x-proxy-username');
        console.error(`  Received: userId=${String(proxyUserId).replace(/[\x00-\x1f\x7f]/g, '')}, username=${String(proxyUsername).replace(/[\x00-\x1f\x7f]/g, '')}`);
        res.status(401).json({
          error: 'Unauthorized',
          message: 'Missing authentication headers from proxy'
        });
        return;
      }

      // Sanitize header values for logging (strip control characters)
      const sanitize = (val: string | undefined): string => String(val || '').replace(/[\x00-\x1f\x7f]/g, '');

      // Audit log
      console.log(`[AUDIT] Platform mode authentication:`, {
        userId: sanitize(proxyUserId),
        username: sanitize(proxyUsername),
        email: sanitize(proxyEmail) || 'N/A',
        ip: peerAddress,
        path: req.path,
        method: req.method
      });

      // Get or create virtual user
      const user = userDb.getFirstUser();
      if (!user) {
        res.status(500).json({ error: 'Platform mode: No user found in database' });
        return;
      }

      // Attach user info from proxy headers
      req.user = {
        ...user,
        platformUserId: proxyUserId,
        platformUsername: proxyUsername,
        platformEmail: proxyEmail
      };

      return next();
    } catch (error) {
      console.error('[ERROR] Platform mode authentication error:', error);
      res.status(500).json({ error: 'Platform mode: Authentication failed' });
      return;
    }
  }

  // Normal OSS JWT validation
  const authHeader = req.headers['authorization'];
  let token = authHeader && authHeader.split(' ')[1]; // Bearer TOKEN

  if (!token) {
    res.status(401).json({ error: 'Access denied. No token provided.' });
    return;
  }

  try {
    const decoded = jwt.verify(token, JWT_SECRET, { algorithms: ['HS256'] }) as DecodedToken;

    // Verify token type (must be access token)
    if (decoded.type !== 'access') {
      res.status(401).json({ error: 'Invalid token type' });
      return;
    }

    // Verify user still exists and is active
    const user = userDb.getUserById(decoded.userId);
    if (!user) {
      res.status(401).json({ error: 'Invalid token. User not found.' });
      return;
    }

    req.user = user;
    next();
  } catch (error) {
    if (error instanceof Error && error.name === 'TokenExpiredError') {
      res.status(401).json({
        error: 'Token expired',
        code: 'TOKEN_EXPIRED'
      });
      return;
    }
    console.error('Token verification error:', error);
    res.status(403).json({ error: 'Invalid token' });
    return;
  }
};

// Generate access token (with expiration)
const generateToken = (user: { id: number; username: string }): string => {
  return jwt.sign(
    {
      userId: user.id,
      username: user.username,
      type: 'access'
    },
    JWT_SECRET,
    { expiresIn: TOKEN_EXPIRY } as jwt.SignOptions
  );
};

// Generate refresh token (longer expiration)
const generateRefreshToken = (user: { id: number; username: string }): string => {
  return jwt.sign(
    {
      userId: user.id,
      username: user.username,
      type: 'refresh'
    },
    REFRESH_TOKEN_SECRET,
    { expiresIn: REFRESH_TOKEN_EXPIRY } as jwt.SignOptions
  );
};

// Verify a refresh token and return decoded payload
const verifyRefreshToken = (token: string): DecodedToken => {
  return jwt.verify(token, REFRESH_TOKEN_SECRET, { algorithms: ['HS256'] }) as DecodedToken;
};

// WebSocket authentication function
const authenticateWebSocket = (token: string | null, peerAddress: string | null = null): DecodedToken | null => {
  if (IS_PLATFORM) {
    // In platform mode, verify the connection comes from a trusted proxy
    if (TRUSTED_PROXIES.length > 0 && peerAddress) {
      const normalizedPeer = normalizeIP(peerAddress);
      const isTrusted = TRUSTED_PROXIES.some((trustedIp: string) => {
        if (trustedIp.includes('/')) {
          return isInCIDR(normalizedPeer, trustedIp);
        }
        return normalizedPeer === normalizeIP(trustedIp);
      });
      if (!isTrusted) {
        security.blocked('websocket', peerAddress, 'Untrusted IP in platform mode');
        return null;
      }
    }
    try {
      const user = userDb.getFirstUser();
      if (user) {
        return { userId: user.id, username: user.username };
      }
      return null;
    } catch (error) {
      console.error('Platform mode WebSocket error:', error);
      return null;
    }
  }

  // Normal OSS JWT validation
  if (!token) {
    return null;
  }

  try {
    const decoded = jwt.verify(token, JWT_SECRET, { algorithms: ['HS256'] }) as DecodedToken;
    if (decoded.type && decoded.type !== 'access') {
      console.warn('[SECURITY] WebSocket auth rejected: non-access token type');
      return null;
    }
    return decoded;
  } catch (error) {
    console.error('WebSocket token verification error:', error);
    return null;
  }
};

export {
  validateApiKey,
  authenticateToken,
  generateToken,
  generateRefreshToken,
  verifyRefreshToken,
  authenticateWebSocket
};
