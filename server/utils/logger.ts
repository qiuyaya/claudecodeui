/**
 * Security and Audit Logging Utility
 * Provides structured logging for security events
 */

import fs from 'fs';
import path from 'path';
import type { SecurityLogger, AuditLogger, AppLogger } from '../types/index.js';

// Log directory (configurable via environment)
const LOG_DIR: string = process.env.LOG_DIR || path.join(process.cwd(), 'logs');

// Ensure log directory exists
try {
  if (!fs.existsSync(LOG_DIR)) {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    console.log(`[INFO] Created log directory: ${LOG_DIR}`);
  }
} catch (error: unknown) {
  console.error(`[ERROR] Failed to create log directory: ${(error as Error).message}`);
}

interface LogEntry {
  timestamp: string;
  level: string;
  category: string;
  message: string;
  metadata: Record<string, unknown>;
}

/**
 * Format log entry as JSON
 */
function formatLogEntry(level: string, category: string, message: string, data: Record<string, unknown> = {}): string {
  return JSON.stringify({
    timestamp: new Date().toISOString(),
    level,
    category,
    message,
    metadata: data
  } as LogEntry) + '\n';
}

/**
 * Write log entry to file
 */
function writeLog(filename: string, entry: string): void {
  const logFile: string = path.join(LOG_DIR, filename);
  fs.appendFile(logFile, entry, (err: NodeJS.ErrnoException | null) => {
    if (err) {
      console.error(`[ERROR] Failed to write to ${filename}:`, err.message);
    }
  });
}

/**
 * Security event logger
 * Logs security-related events like authentication failures, blocked requests, etc.
 */
export const security: SecurityLogger = {
  /**
   * Log authentication attempt
   */
  authAttempt: (success: boolean, username: string, ip: string, details: Record<string, unknown> = {}): void => {
    const entry: string = formatLogEntry(
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
  blocked: (reason: string, ip: string, path: string, details: Record<string, unknown> = {}): void => {
    const entry: string = formatLogEntry(
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
  suspicious: (activity: string, ip: string, details: Record<string, unknown> = {}): void => {
    const entry: string = formatLogEntry(
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
  violation: (violation: string, ip: string, details: Record<string, unknown> = {}): void => {
    const entry: string = formatLogEntry(
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
export const audit: AuditLogger = {
  /**
   * Log user action
   */
  action: (username: string, action: string, resource: string, details: Record<string, unknown> = {}): void => {
    const entry: string = formatLogEntry(
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
  access: (username: string, resource: string, operation: string, details: Record<string, unknown> = {}): void => {
    const entry: string = formatLogEntry(
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
  configChange: (username: string, setting: string, oldValue: unknown, newValue: unknown, details: Record<string, unknown> = {}): void => {
    const entry: string = formatLogEntry(
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
export const logger: AppLogger = {
  info: (message: string, data: Record<string, unknown> = {}): void => {
    const entry: string = formatLogEntry('INFO', 'APP', message, data);
    console.log(entry.trim());
    writeLog('app.log', entry);
  },

  warn: (message: string, data: Record<string, unknown> = {}): void => {
    const entry: string = formatLogEntry('WARN', 'APP', message, data);
    console.warn(entry.trim());
    writeLog('app.log', entry);
  },

  error: (message: string, error: Error | null = null, data: Record<string, unknown> = {}): void => {
    const entry: string = formatLogEntry('ERROR', 'APP', message, {
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
const MAX_LOG_SIZE: number = parseInt(process.env.MAX_LOG_SIZE as string) || 10 * 1024 * 1024; // Default: 10MB
const MAX_LOG_FILES: number = parseInt(process.env.MAX_LOG_FILES as string) || 10; // Default: keep 10 rotated files

/**
 * Rotate log files (to be called periodically)
 * - Rotates files exceeding MAX_LOG_SIZE
 * - Cleans up old rotated files exceeding MAX_LOG_FILES
 */
export function rotateLogs(): void {
  const logFiles: string[] = ['security.log', 'audit.log', 'app.log', 'error.log'];

  logFiles.forEach((filename: string) => {
    const logFile: string = path.join(LOG_DIR, filename);
    try {
      // Rotate if file exceeds max size
      if (fs.existsSync(logFile)) {
        const stats: fs.Stats = fs.statSync(logFile);
        if (stats.size > MAX_LOG_SIZE) {
          const timestamp: string = new Date().toISOString().replace(/[:.]/g, '-');
          const archiveName: string = `${filename}.${timestamp}`;
          fs.renameSync(logFile, path.join(LOG_DIR, archiveName));
          console.log(`[INFO] Rotated log file: ${filename} -> ${archiveName}`);
        }
      }

      // Clean up old rotated files beyond MAX_LOG_FILES
      const rotatedFiles: string[] = fs.readdirSync(LOG_DIR)
        .filter((f: string) => f.startsWith(filename + '.') && f !== filename)
        .sort()
        .reverse(); // Newest first (ISO timestamps sort correctly)

      if (rotatedFiles.length > MAX_LOG_FILES) {
        const toDelete: string[] = rotatedFiles.slice(MAX_LOG_FILES);
        for (const oldFile of toDelete) {
          fs.unlinkSync(path.join(LOG_DIR, oldFile));
          console.log(`[INFO] Deleted old log file: ${oldFile}`);
        }
      }
    } catch (error: unknown) {
      console.error(`[ERROR] Failed to rotate ${filename}:`, (error as Error).message);
    }
  });
}

// Run rotation on startup and then daily
rotateLogs();
setInterval(rotateLogs, 24 * 60 * 60 * 1000).unref();

export default { security, audit, logger, rotateLogs };
