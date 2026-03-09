import { Router, Request, Response, NextFunction } from 'express';
import bcrypt from 'bcrypt';
import { userDb, db, refreshTokensDb } from '../database/db.js';
import { generateToken, generateRefreshToken, authenticateToken, verifyRefreshToken } from '../middleware/auth.js';
import { authLimiter, refreshLimiter } from '../middleware/rateLimiter.js';
import { security } from '../utils/logger.js';
import type { AuthRequest } from '../types/index.js';

const router = Router();

// Check auth status and setup requirements
router.get('/status', async (req: Request, res: Response) => {
  try {
    const hasUsers = await userDb.hasUsers();
    res.json({
      needsSetup: !hasUsers,
      isAuthenticated: false // Will be overridden by frontend if token exists
    });
  } catch (error) {
    console.error('Auth status error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// User registration (setup) - only allowed if no users exist
router.post('/register', authLimiter, async (req: Request, res: Response) => {
  try {
    const { username, password } = req.body;

    // Validate input
    if (!username || !password) {
      return res.status(400).json({ error: 'Username and password are required' });
    }

    if (username.length < 3 || password.length < 8) {
      return res.status(400).json({ error: 'Username must be at least 3 characters, password at least 8 characters' });
    }

    // Use a transaction to prevent race conditions
    db.prepare('BEGIN').run();
    try {
      // Check if users already exist (only allow one user)
      const hasUsers = userDb.hasUsers();
      if (hasUsers) {
        db.prepare('ROLLBACK').run();
        return res.status(403).json({ error: 'User already exists. This is a single-user system.' });
      }

      // Hash password
      const saltRounds = 12;
      const passwordHash = await bcrypt.hash(password, saltRounds);

      // Create user
      const user = userDb.createUser(username, passwordHash);

      // Generate both access and refresh tokens
      const userWithNumberId = { id: Number(user.id), username: user.username };
      const accessToken = generateToken(userWithNumberId);
      const refreshToken = generateRefreshToken(userWithNumberId);

      // Store refresh token
      refreshTokensDb.storeRefreshToken(Number(user.id), refreshToken);

      db.prepare('COMMIT').run();

      // Update last login (non-fatal, outside transaction)
      userDb.updateLastLogin(Number(user.id));

      res.json({
        success: true,
        user: { id: user.id, username: user.username },
        accessToken,
        refreshToken,
        // Backward compatibility
        token: accessToken
      });
    } catch (error) {
      db.prepare('ROLLBACK').run();
      throw error;
    }

  } catch (error: unknown) {
    console.error('Registration error:', error);
    if ((error as NodeJS.ErrnoException & { code?: string }).code === 'SQLITE_CONSTRAINT_UNIQUE') {
      res.status(409).json({ error: 'Username already exists' });
    } else {
      res.status(500).json({ error: 'Internal server error' });
    }
  }
});

// User login
router.post('/login', authLimiter, async (req: Request, res: Response) => {
  try {
    const { username, password } = req.body;

    // Validate input
    if (!username || !password) {
      return res.status(400).json({ error: 'Username and password are required' });
    }

    // Get user from database
    const user = userDb.getUserByUsername(username);
    if (!user) {
      security.authAttempt(false, username, req.ip as string, { reason: 'user_not_found' });
      return res.status(401).json({ error: 'Invalid username or password' });
    }

    // Verify password
    const isValidPassword = await bcrypt.compare(password, user.password_hash);
    if (!isValidPassword) {
      security.authAttempt(false, username, req.ip as string, { reason: 'invalid_password' });
      return res.status(401).json({ error: 'Invalid username or password' });
    }

    security.authAttempt(true, username, req.ip as string);

    // Generate both access and refresh tokens
    const accessToken = generateToken(user);
    const refreshToken = generateRefreshToken(user);

    // Store refresh token
    refreshTokensDb.storeRefreshToken(user.id, refreshToken);

    // Update last login
    userDb.updateLastLogin(user.id);

    res.json({
      success: true,
      user: { id: user.id, username: user.username },
      accessToken,
      refreshToken,
      // Backward compatibility
      token: accessToken
    });

  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get current user (protected route)
router.get('/user', authenticateToken, (req: Request, res: Response) => {
  res.json({
    user: (req as AuthRequest).user
  });
});

// Refresh access token using refresh token
router.post('/refresh', refreshLimiter, async (req: Request, res: Response) => {
  try {
    const { refreshToken } = req.body;

    if (!refreshToken) {
      return res.status(401).json({ error: 'Refresh token required' });
    }

    // Verify refresh token
    let decoded: { type?: string; userId: number; username?: string };
    try {
      decoded = verifyRefreshToken(refreshToken);
      if (decoded.type !== 'refresh') {
        throw new Error('Invalid token type');
      }
    } catch (error: unknown) {
      if ((error as Error & { name?: string }).name === 'TokenExpiredError') {
        return res.status(401).json({ error: 'Refresh token expired' });
      }
      return res.status(401).json({ error: 'Invalid refresh token' });
    }

    // Validate refresh token in database
    const isValid = refreshTokensDb.validateRefreshToken(refreshToken, decoded.userId);
    if (!isValid) {
      // Check if this token was previously valid but revoked (reuse detection)
      const wasRevoked = refreshTokensDb.isTokenRevoked(refreshToken, decoded.userId);
      if (wasRevoked) {
        // Token reuse detected! Revoke ALL tokens for this user as a security measure
        console.warn(`[SECURITY] Refresh token reuse detected for userId=${decoded.userId}. Revoking all tokens.`);
        security.authAttempt(false, decoded.username || 'unknown', req.ip as string, { reason: 'refresh_token_reuse' });
        refreshTokensDb.revokeAllUserTokens(decoded.userId);
      }
      return res.status(401).json({ error: 'Refresh token revoked or expired' });
    }

    // Get user
    const user = userDb.getUserById(decoded.userId);
    if (!user) {
      return res.status(401).json({ error: 'User not found' });
    }

    // Rotate: revoke old refresh token and issue new ones
    refreshTokensDb.revokeRefreshToken(refreshToken);
    const newAccessToken = generateToken(user);
    const newRefreshToken = generateRefreshToken(user);
    refreshTokensDb.storeRefreshToken(user.id, newRefreshToken);

    res.json({
      success: true,
      accessToken: newAccessToken,
      refreshToken: newRefreshToken,
      // Backward compatibility
      token: newAccessToken
    });

  } catch (error) {
    console.error('Token refresh error:', error);
    res.status(500).json({ error: 'Token refresh failed' });
  }
});

// Logout - revoke refresh token
router.post('/logout', authenticateToken, async (req: Request, res: Response) => {
  try {
    // Revoke all refresh tokens for this user
    refreshTokensDb.revokeAllUserTokens((req as AuthRequest).user!.id);

    res.json({ success: true, message: 'Logged out successfully' });
  } catch (error) {
    console.error('Logout error:', error);
    // Still return success even if revocation fails
    res.json({ success: true, message: 'Logged out successfully' });
  }
});

export default router;
