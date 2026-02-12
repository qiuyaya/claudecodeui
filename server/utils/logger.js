/**
 * Security and Audit Logging Utility
 * Provides structured logging for security events
 */

import fs from 'fs';
import path from 'path';

// Log directory (configurable via environment)
const LOG_DIR = process.env.LOG_DIR || path.join(process.cwd(), 'logs');

// Ensure log directory exists
try {
  if (!fs.existsSync(LOG_DIR)) {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    console.log(`[INFO] Created log directory: ${LOG_DIR}`);
  }
} catch (error) {
  console.error(`[ERROR] Failed to create log directory: ${error.message}`);
}

/**
 * Format log entry as JSON
 */
function formatLogEntry(level, category, message, data = {}) {
  return JSON.stringify({
    timestamp: new Date().toISOString(),
    level,
    category,
    message,
    metadata: data
  }) + '\n';
}

/**
 * Write log entry to file
 */
function writeLog(filename, entry) {
  const logFile = path.join(LOG_DIR, filename);
  fs.appendFile(logFile, entry, (err) => {
    if (err) {
      console.error(`[ERROR] Failed to write to ${filename}:`, err.message);
    }
  });
}

/**
 * Security event logger
 * Logs security-related events like authentication failures, blocked requests, etc.
 */
export const security = {
  /**
   * Log authentication attempt
   */
  authAttempt: (success, username, ip, details = {}) => {
    const entry = formatLogEntry(
      success ? 'INFO' : 'WARN',
      'AUTH',
      success ? 'Authentication successful' : 'Authentication failed',
      {
        success,
        username,
        ip,
        ...details
      }
    );

    console.log(entry.trim());
    writeLog('security.log', entry);
  },

  /**
   * Log blocked request
   */
  blocked: (reason, ip, path, details = {}) => {
    const entry = formatLogEntry(
      'WARN',
      'BLOCKED',
      `Request blocked: ${reason}`,
      {
        reason,
        ip,
        path,
        ...details
      }
    );

    console.warn(entry.trim());
    writeLog('security.log', entry);
  },

  /**
   * Log suspicious activity
   */
  suspicious: (activity, ip, details = {}) => {
    const entry = formatLogEntry(
      'WARN',
      'SUSPICIOUS',
      `Suspicious activity detected: ${activity}`,
      {
        activity,
        ip,
        ...details
      }
    );

    console.warn(entry.trim());
    writeLog('security.log', entry);
  },

  /**
   * Log security violation
   */
  violation: (violation, ip, details = {}) => {
    const entry = formatLogEntry(
      'ERROR',
      'VIOLATION',
      `Security violation: ${violation}`,
      {
        violation,
        ip,
        ...details
      }
    );

    console.error(entry.trim());
    writeLog('security.log', entry);
  }
};

/**
 * Audit event logger
 * Logs user actions for audit trail
 */
export const audit = {
  /**
   * Log user action
   */
  action: (username, action, resource, details = {}) => {
    const entry = formatLogEntry(
      'INFO',
      'AUDIT',
      `User action: ${action}`,
      {
        username,
        action,
        resource,
        ...details
      }
    );

    console.log(entry.trim());
    writeLog('audit.log', entry);
  },

  /**
   * Log data access
   */
  access: (username, resource, operation, details = {}) => {
    const entry = formatLogEntry(
      'INFO',
      'ACCESS',
      `Data access: ${operation} on ${resource}`,
      {
        username,
        resource,
        operation,
        ...details
      }
    );

    console.log(entry.trim());
    writeLog('audit.log', entry);
  },

  /**
   * Log configuration change
   */
  configChange: (username, setting, oldValue, newValue, details = {}) => {
    const entry = formatLogEntry(
      'INFO',
      'CONFIG',
      `Configuration changed: ${setting}`,
      {
        username,
        setting,
        oldValue: oldValue ? '[redacted]' : null,
        newValue: newValue ? '[redacted]' : null,
        ...details
      }
    );

    console.log(entry.trim());
    writeLog('audit.log', entry);
  }
};

/**
 * Application logger
 * General purpose logging
 */
export const logger = {
  info: (message, data = {}) => {
    const entry = formatLogEntry('INFO', 'APP', message, data);
    console.log(entry.trim());
    writeLog('app.log', entry);
  },

  warn: (message, data = {}) => {
    const entry = formatLogEntry('WARN', 'APP', message, data);
    console.warn(entry.trim());
    writeLog('app.log', entry);
  },

  error: (message, error = null, data = {}) => {
    const entry = formatLogEntry('ERROR', 'APP', message, {
      error: error ? {
        message: error.message,
        stack: error.stack
      } : null,
      ...data
    });
    console.error(entry.trim());
    writeLog('error.log', entry);
  }
};

// Log rotation configuration
const MAX_LOG_SIZE = parseInt(process.env.MAX_LOG_SIZE) || 10 * 1024 * 1024; // Default: 10MB
const MAX_LOG_FILES = parseInt(process.env.MAX_LOG_FILES) || 10; // Default: keep 10 rotated files

/**
 * Rotate log files (to be called periodically)
 * - Rotates files exceeding MAX_LOG_SIZE
 * - Cleans up old rotated files exceeding MAX_LOG_FILES
 */
export function rotateLogs() {
  const logFiles = ['security.log', 'audit.log', 'app.log', 'error.log'];

  logFiles.forEach(filename => {
    const logFile = path.join(LOG_DIR, filename);
    try {
      // Rotate if file exceeds max size
      if (fs.existsSync(logFile)) {
        const stats = fs.statSync(logFile);
        if (stats.size > MAX_LOG_SIZE) {
          const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
          const archiveName = `${filename}.${timestamp}`;
          fs.renameSync(logFile, path.join(LOG_DIR, archiveName));
          console.log(`[INFO] Rotated log file: ${filename} -> ${archiveName}`);
        }
      }

      // Clean up old rotated files beyond MAX_LOG_FILES
      const rotatedFiles = fs.readdirSync(LOG_DIR)
        .filter(f => f.startsWith(filename + '.') && f !== filename)
        .sort()
        .reverse(); // Newest first (ISO timestamps sort correctly)

      if (rotatedFiles.length > MAX_LOG_FILES) {
        const toDelete = rotatedFiles.slice(MAX_LOG_FILES);
        for (const oldFile of toDelete) {
          fs.unlinkSync(path.join(LOG_DIR, oldFile));
          console.log(`[INFO] Deleted old log file: ${oldFile}`);
        }
      }
    } catch (error) {
      console.error(`[ERROR] Failed to rotate ${filename}:`, error.message);
    }
  });
}

// Run rotation on startup and then daily
rotateLogs();
setInterval(rotateLogs, 24 * 60 * 60 * 1000).unref();

export default { security, audit, logger, rotateLogs };
