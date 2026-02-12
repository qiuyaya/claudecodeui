/**
 * Error Handling Middleware
 * Provides unified error responses and prevents information leakage
 */

/**
 * Sanitize error messages to prevent information leakage
 * @param {Error} error - The error object
 * @param {boolean} isProduction - Whether in production mode
 * @returns {object} Sanitized error response
 */
function sanitizeError(error, isProduction) {
  const sanitized = {
    error: error.message || 'An error occurred'
  };

  // In development, include more details
  if (!isProduction) {
    if (error.stack) {
      sanitized.stack = error.stack;
    }
    if (error.details) {
      sanitized.details = error.details;
    }
  }

  // Sanitize file paths from error messages
  if (sanitized.error) {
    sanitized.error = sanitized.error
      // Remove user home directories
      .replace(/\/Users\/[^\/]+/g, '/home/user')
      .replace(/\/home\/[^\/]+/g, '/home/user')
      .replace(/C:\\Users\\[^\\]+/g, 'C:\\Users\\user')
      // Remove sensitive system paths
      .replace(/\/root\b[^\s]*/g, '[path]')
      .replace(/\/opt\/[^\s]+/g, '[path]')
      .replace(/\/var\/[^\s]+/g, '[path]')
      .replace(/\/srv\/[^\s]+/g, '[path]')
      .replace(/\/etc\/[^\s]+/g, '[path]')
      // Remove potential tokens or keys (look for hex or base64 patterns typical of secrets)
      .replace(/\b[a-fA-F0-9]{32,}\b/g, '[redacted]')
      .replace(/\beyJ[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+\b/g, '[redacted-jwt]');
  }

  // Sanitize stack traces
  if (sanitized.stack) {
    sanitized.stack = sanitized.stack
      .replace(/\/Users\/[^\/]+/g, '/home/user')
      .replace(/\/home\/[^\/]+/g, '/home/user')
      .replace(/C:\\Users\\[^\\]+/g, 'C:\\Users\\user');
  }

  return sanitized;
}

/**
 * Global error handler middleware
 * Catches all errors and returns consistent error responses
 */
export const errorHandler = (err, req, res, next) => {
  const isProduction = process.env.NODE_ENV === 'production';

  // Default to 500 if no status code
  const statusCode = err.statusCode || 500;

  // Log error based on severity
  if (statusCode >= 500) {
    console.error('[ERROR]', {
      message: err.message,
      stack: err.stack,
      url: req.url,
      method: req.method,
      ip: req.ip,
      user: req.user?.username || 'anonymous',
      timestamp: new Date().toISOString()
    });
  } else if (statusCode >= 400) {
    console.warn('[WARN]', {
      message: err.message,
      url: req.url,
      method: req.method,
      ip: req.ip,
      statusCode,
      timestamp: new Date().toISOString()
    });
  }

  // Handle specific error types
  if (err.name === 'UnauthorizedError') {
    return res.status(401).json({
      error: 'Unauthorized',
      message: 'Invalid or expired token'
    });
  }

  if (err.name === 'ValidationError') {
    return res.status(400).json({
      error: 'Validation failed',
      message: err.message,
      details: isProduction ? null : err.details
    });
  }

  // Handle JWT errors
  if (err.name === 'JsonWebTokenError') {
    return res.status(401).json({
      error: 'Invalid token',
      message: 'Authentication token is invalid'
    });
  }

  if (err.name === 'TokenExpiredError') {
    return res.status(401).json({
      error: 'Token expired',
      message: 'Authentication token has expired'
    });
  }

  // Sanitize and return error
  const sanitizedError = sanitizeError(err, isProduction);

  // Generic error message for production
  if (isProduction && statusCode >= 500) {
    sanitizedError.error = 'Internal server error';
    sanitizedError.message = 'An unexpected error occurred. Please try again later.';
  }

  res.status(statusCode).json(sanitizedError);
};

/**
 * 404 Not Found handler
 * Only triggers for /api routes so it doesn't interfere with SPA client-side routing.
 */
export const notFoundHandler = (req, res, next) => {
  // Only handle API routes - let non-API requests fall through to the SPA catch-all
  if (!req.path.startsWith('/api')) {
    return next();
  }

  console.warn('[WARN] 404 Not Found:', {
    url: req.url,
    method: req.method,
    ip: req.ip,
    timestamp: new Date().toISOString()
  });

  if (process.env.NODE_ENV === 'production') {
    res.status(404).json({ error: 'Not found' });
  } else {
    res.status(404).json({
      error: 'Not found',
      message: `Endpoint ${req.method} ${req.path} not found`,
      path: req.path
    });
  }
};
