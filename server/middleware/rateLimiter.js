import rateLimit from 'express-rate-limit';

// Authentication rate limiter: 5 attempts per 15 minutes
// Prevents brute force attacks on login/register endpoints
export const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 5, // Maximum 5 requests per window
  message: {
    error: 'Too many authentication attempts from this IP, please try again after 15 minutes',
    retryAfter: 15 * 60 // seconds
  },
  standardHeaders: true, // Return RateLimit-* headers
  legacyHeaders: false, // Disable X-RateLimit-* headers
  // Skip rate limiting in development if explicitly configured
  skip: (req) => {
    return process.env.NODE_ENV === 'development' && process.env.SKIP_RATE_LIMIT === 'true';
  },
  // Custom handler for when limit is exceeded
  handler: (req, res) => {
    console.warn(`[SECURITY] Rate limit exceeded for ${req.ip} on ${req.path}`);
    res.status(429).json({
      error: 'Too many authentication attempts',
      message: 'Please try again after 15 minutes',
      retryAfter: 900 // 15 minutes in seconds
    });
  }
});

// Token refresh rate limiter: 30 attempts per 15 minutes
// More lenient than auth limiter since token refresh is a normal operation
export const refreshLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 30, // Maximum 30 requests per window
  message: {
    error: 'Too many token refresh attempts, please try again later',
    retryAfter: 60
  },
  standardHeaders: true,
  legacyHeaders: false,
  skip: (req) => {
    return process.env.NODE_ENV === 'development' && process.env.SKIP_RATE_LIMIT === 'true';
  },
  handler: (req, res) => {
    console.warn(`[SECURITY] Refresh rate limit exceeded for ${req.ip}`);
    res.status(429).json({
      error: 'Too many token refresh attempts',
      message: 'Please try again later',
      retryAfter: 60
    });
  }
});

// API general rate limiter: 100 requests per minute
// Prevents API abuse and DoS attacks
export const apiLimiter = rateLimit({
  windowMs: 1 * 60 * 1000, // 1 minute
  max: 100, // Maximum 100 requests per window
  message: {
    error: 'Too many requests from this IP, please try again later',
    retryAfter: 60 // seconds
  },
  standardHeaders: true,
  legacyHeaders: false,
  skip: (req) => {
    // Skip rate limiting in development if configured
    return process.env.NODE_ENV === 'development' && process.env.SKIP_RATE_LIMIT === 'true';
  },
  handler: (req, res) => {
    console.warn(`[SECURITY] API rate limit exceeded for ${req.ip} on ${req.path}`);
    res.status(429).json({
      error: 'Too many requests',
      message: 'Please slow down and try again in a minute',
      retryAfter: 60
    });
  }
});
