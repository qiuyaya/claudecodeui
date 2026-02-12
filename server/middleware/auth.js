import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import { userDb } from '../database/db.js';
import { IS_PLATFORM } from '../constants/config.js';
import { security } from '../utils/logger.js';

// JWT Secret configuration
const DEV_JWT_SECRET = 'claude-ui-dev-secret-do-not-use-in-production';
const JWT_SECRET = process.env.JWT_SECRET || (process.env.NODE_ENV === 'production' ? null : DEV_JWT_SECRET);

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
const TOKEN_EXPIRY = process.env.TOKEN_EXPIRY || '1h'; // Default: 1 hour (refresh tokens handle longer sessions)
const REFRESH_TOKEN_EXPIRY = '30d'; // 30 days

// Separate secret for refresh tokens
const REFRESH_TOKEN_SECRET = process.env.REFRESH_TOKEN_SECRET || JWT_SECRET;

if (!process.env.REFRESH_TOKEN_SECRET) {
  console.warn('[WARN] REFRESH_TOKEN_SECRET is not set. Falling back to JWT_SECRET.');
  console.warn('  For improved security, set a separate REFRESH_TOKEN_SECRET in your .env file.');
}

// Platform mode configuration
const TRUSTED_PROXIES = process.env.TRUSTED_PROXIES
  ? process.env.TRUSTED_PROXIES.split(',').map(ip => ip.trim())
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
function normalizeIP(ip) {
  if (!ip) return '';
  // Strip IPv6 prefix from IPv4-mapped addresses
  return ip.replace(/^::ffff:/, '');
}

function isInCIDR(ip, cidr) {
  const [range, bits] = cidr.split('/');
  const mask = parseInt(bits, 10);
  if (isNaN(mask) || mask < 0 || mask > 32) return false;

  const ipParts = normalizeIP(ip).split('.').map(Number);
  const rangeParts = normalizeIP(range).split('.').map(Number);

  if (ipParts.length !== 4 || rangeParts.length !== 4) return false;
  if (ipParts.some(p => isNaN(p)) || rangeParts.some(p => isNaN(p))) return false;

  const ipNum = ((ipParts[0] << 24) + (ipParts[1] << 16) + (ipParts[2] << 8) + ipParts[3]) >>> 0;
  const rangeNum = ((rangeParts[0] << 24) + (rangeParts[1] << 16) + (rangeParts[2] << 8) + rangeParts[3]) >>> 0;
  const maskNum = mask === 0 ? 0 : (~0 << (32 - mask)) >>> 0;

  return (ipNum & maskNum) === (rangeNum & maskNum);
}

// Optional API key middleware
const validateApiKey = (req, res, next) => {
  // Skip API key validation if not configured
  if (!process.env.API_KEY) {
    return next();
  }

  const apiKey = req.headers['x-api-key'];

  // Early return if no API key provided (avoid unnecessary crypto operations)
  if (!apiKey) {
    security.authAttempt(false, 'api-key', req.ip, { method: 'api_key', reason: 'missing_key' });
    return res.status(401).json({ error: 'Invalid API key' });
  }

  // Use HMAC to normalize both values to equal-length hashes before timing-safe comparison
  // This prevents leaking length information through early return on length mismatch
  // The random HMAC key is generated per-request to prevent precomputation attacks
  const hmacKey = crypto.randomBytes(32);
  const provided = crypto.createHmac('sha256', hmacKey).update(apiKey).digest();
  const expected = crypto.createHmac('sha256', hmacKey).update(process.env.API_KEY).digest();

  if (!crypto.timingSafeEqual(provided, expected)) {
    security.authAttempt(false, 'api-key', req.ip, { method: 'api_key', reason: 'invalid_key' });
    return res.status(401).json({ error: 'Invalid API key' });
  }

  next();
};

// JWT authentication middleware
const authenticateToken = async (req, res, next) => {
  // Platform mode: Enhanced security validation
  if (IS_PLATFORM) {
    try {
      // Use the actual TCP peer address for proxy validation
      const peerAddress = req.socket.remoteAddress;

      // Validate trusted proxy if configured
      if (TRUSTED_PROXIES.length > 0) {
        const isTrustedProxy = TRUSTED_PROXIES.some(trustedIp => {
          const normalizedPeer = normalizeIP(peerAddress);
          if (trustedIp.includes('/')) {
            return isInCIDR(normalizedPeer, trustedIp);
          }
          return normalizedPeer === normalizeIP(trustedIp);
        });

        if (!isTrustedProxy) {
          console.warn(`[SECURITY] Platform mode: Untrusted proxy IP: ${peerAddress}`);
          return res.status(403).json({
            error: 'Forbidden',
            message: 'Request from untrusted proxy'
          });
        }
      }

      // Validate proxy identity headers
      const proxyUserId = req.headers['x-proxy-user-id'];
      const proxyUsername = req.headers['x-proxy-username'];
      const proxyEmail = req.headers['x-proxy-email'];

      if (!proxyUserId || !proxyUsername) {
        console.error('[SECURITY] Platform mode: Missing required proxy identity headers');
        console.error('  Expected: x-proxy-user-id, x-proxy-username');
        console.error(`  Received: userId=${String(proxyUserId).replace(/[\x00-\x1f\x7f]/g, '')}, username=${String(proxyUsername).replace(/[\x00-\x1f\x7f]/g, '')}`);
        return res.status(401).json({
          error: 'Unauthorized',
          message: 'Missing authentication headers from proxy'
        });
      }

      // Sanitize header values for logging (strip control characters)
      const sanitize = (val) => String(val || '').replace(/[\x00-\x1f\x7f]/g, '');

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
        return res.status(500).json({ error: 'Platform mode: No user found in database' });
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
      return res.status(500).json({ error: 'Platform mode: Authentication failed' });
    }
  }

  // Normal OSS JWT validation
  const authHeader = req.headers['authorization'];
  let token = authHeader && authHeader.split(' ')[1]; // Bearer TOKEN

  if (!token) {
    return res.status(401).json({ error: 'Access denied. No token provided.' });
  }

  try {
    const decoded = jwt.verify(token, JWT_SECRET, { algorithms: ['HS256'] });

    // Verify token type (must be access token)
    if (decoded.type !== 'access') {
      return res.status(401).json({ error: 'Invalid token type' });
    }

    // Verify user still exists and is active
    const user = userDb.getUserById(decoded.userId);
    if (!user) {
      return res.status(401).json({ error: 'Invalid token. User not found.' });
    }

    req.user = user;
    next();
  } catch (error) {
    if (error.name === 'TokenExpiredError') {
      return res.status(401).json({
        error: 'Token expired',
        code: 'TOKEN_EXPIRED'
      });
    }
    console.error('Token verification error:', error);
    return res.status(403).json({ error: 'Invalid token' });
  }
};

// Generate access token (with expiration)
const generateToken = (user) => {
  return jwt.sign(
    {
      userId: user.id,
      username: user.username,
      type: 'access'
    },
    JWT_SECRET,
    { expiresIn: TOKEN_EXPIRY }
  );
};

// Generate refresh token (longer expiration)
const generateRefreshToken = (user) => {
  return jwt.sign(
    {
      userId: user.id,
      username: user.username,
      type: 'refresh'
    },
    REFRESH_TOKEN_SECRET,
    { expiresIn: REFRESH_TOKEN_EXPIRY }
  );
};

// Verify a refresh token and return decoded payload
const verifyRefreshToken = (token) => {
  return jwt.verify(token, REFRESH_TOKEN_SECRET, { algorithms: ['HS256'] });
};

// WebSocket authentication function
const authenticateWebSocket = (token, peerAddress = null) => {
  if (IS_PLATFORM) {
    // In platform mode, verify the connection comes from a trusted proxy
    if (TRUSTED_PROXIES.length > 0 && peerAddress) {
      const normalizedPeer = normalizeIP(peerAddress);
      const isTrusted = TRUSTED_PROXIES.some(trustedIp => {
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
    const decoded = jwt.verify(token, JWT_SECRET, { algorithms: ['HS256'] });
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
