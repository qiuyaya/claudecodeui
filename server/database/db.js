import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import { encrypt, decrypt, hashApiKey, hashApiKeyLegacy, hashRefreshToken } from '../utils/crypto.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// ANSI color codes for terminal output
const colors = {
    reset: '\x1b[0m',
    bright: '\x1b[1m',
    cyan: '\x1b[36m',
    dim: '\x1b[2m',
};

const c = {
    info: (text) => `${colors.cyan}${text}${colors.reset}`,
    bright: (text) => `${colors.bright}${text}${colors.reset}`,
    dim: (text) => `${colors.dim}${text}${colors.reset}`,
};

// Use DATABASE_PATH environment variable if set, otherwise use default location
const DB_PATH = process.env.DATABASE_PATH || path.join(__dirname, 'auth.db');
const INIT_SQL_PATH = path.join(__dirname, 'init.sql');

// Ensure database directory exists if custom path is provided
if (process.env.DATABASE_PATH) {
  const dbDir = path.dirname(DB_PATH);
  try {
    if (!fs.existsSync(dbDir)) {
      fs.mkdirSync(dbDir, { recursive: true });
      console.log(`Created database directory: ${dbDir}`);
    }
  } catch (error) {
    console.error(`Failed to create database directory ${dbDir}:`, error.message);
    throw error;
  }
}

// As part of 1.19.2 we are introducing a new location for auth.db. The below handles exisitng moving legacy database from install directory to new location
const LEGACY_DB_PATH = path.join(__dirname, 'auth.db');
if (DB_PATH !== LEGACY_DB_PATH && !fs.existsSync(DB_PATH) && fs.existsSync(LEGACY_DB_PATH)) {
  try {
    fs.copyFileSync(LEGACY_DB_PATH, DB_PATH);
    console.log(`[MIGRATION] Copied database from ${LEGACY_DB_PATH} to ${DB_PATH}`);
    for (const suffix of ['-wal', '-shm']) {
      if (fs.existsSync(LEGACY_DB_PATH + suffix)) {
        fs.copyFileSync(LEGACY_DB_PATH + suffix, DB_PATH + suffix);
      }
    }
  } catch (err) {
    console.warn(`[MIGRATION] Could not copy legacy database: ${err.message}`);
  }
}

// Create database connection
const db = new Database(DB_PATH);

// Set restrictive file permissions on database
try {
  fs.chmodSync(DB_PATH, 0o600);
} catch (e) {
  // May fail on Windows or certain filesystems
  console.warn('Could not set database file permissions:', e.message);
}

// Show app installation path prominently
const appInstallPath = path.join(__dirname, '../..');
console.log('');
console.log(c.dim('═'.repeat(60)));
console.log(`${c.info('[INFO]')} App Installation: ${c.bright(appInstallPath)}`);
console.log(`${c.info('[INFO]')} Database: ${c.dim(path.relative(appInstallPath, DB_PATH))}`);
if (process.env.DATABASE_PATH) {
  console.log(`       ${c.dim('(Using custom DATABASE_PATH from environment)')}`);
}
console.log(c.dim('═'.repeat(60)));
console.log('');

const runMigrations = () => {
  try {
    const tableInfo = db.prepare("PRAGMA table_info(users)").all();
    const columnNames = tableInfo.map(col => col.name);

    if (!columnNames.includes('git_name')) {
      console.log('Running migration: Adding git_name column');
      db.exec('ALTER TABLE users ADD COLUMN git_name TEXT');
    }

    if (!columnNames.includes('git_email')) {
      console.log('Running migration: Adding git_email column');
      db.exec('ALTER TABLE users ADD COLUMN git_email TEXT');
    }

    if (!columnNames.includes('has_completed_onboarding')) {
      console.log('Running migration: Adding has_completed_onboarding column');
      db.exec('ALTER TABLE users ADD COLUMN has_completed_onboarding BOOLEAN DEFAULT 0');
    }

    // Check if refresh_tokens table exists
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='refresh_tokens'").all();
    if (tables.length === 0) {
      console.log('Running migration: Creating refresh_tokens table');
      db.exec(`
        CREATE TABLE refresh_tokens (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          user_id INTEGER NOT NULL,
          token_hash TEXT NOT NULL,
          expires_at DATETIME NOT NULL,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          is_revoked BOOLEAN DEFAULT 0,
          FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
        );
        CREATE INDEX idx_refresh_tokens_hash ON refresh_tokens(token_hash);
        CREATE INDEX idx_refresh_tokens_user ON refresh_tokens(user_id);
        CREATE INDEX idx_refresh_tokens_expires ON refresh_tokens(expires_at);
        CREATE INDEX idx_refresh_tokens_revoked ON refresh_tokens(is_revoked);
      `);
    }

    // Check if app_settings table exists (for tracking migration deadlines)
    const settingsTables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='app_settings'").all();
    if (settingsTables.length === 0) {
      console.log('Running migration: Creating app_settings table');
      db.exec(`
        CREATE TABLE app_settings (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL,
          updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );
      `);
    }

    // Record first startup time for migration deadline tracking
    const firstStartup = db.prepare("SELECT value FROM app_settings WHERE key = 'first_startup'").get();
    if (!firstStartup) {
      db.prepare("INSERT INTO app_settings (key, value) VALUES ('first_startup', ?)").run(new Date().toISOString());
    }

    // Create session_names table if it doesn't exist (for existing installations)
    db.exec(`CREATE TABLE IF NOT EXISTS session_names (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      provider TEXT NOT NULL DEFAULT 'claude',
      custom_name TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(session_id, provider)
    )`);
    db.exec('CREATE INDEX IF NOT EXISTS idx_session_names_lookup ON session_names(session_id, provider)');

    console.log('Database migrations completed successfully');
  } catch (error) {
    console.error('Error running migrations:', error.message);
    throw error;
  }
};

// Initialize database with schema
const initializeDatabase = async () => {
  try {
    const initSQL = fs.readFileSync(INIT_SQL_PATH, 'utf8');
    db.exec(initSQL);
    console.log('Database initialized successfully');
    runMigrations();
  } catch (error) {
    console.error('Error initializing database:', error.message);
    throw error;
  }
};

// User database operations
const userDb = {
  hasUsers: () => {
    const row = db.prepare('SELECT COUNT(*) as count FROM users').get();
    return row.count > 0;
  },

  createUser: (username, passwordHash) => {
    const stmt = db.prepare('INSERT INTO users (username, password_hash) VALUES (?, ?)');
    const result = stmt.run(username, passwordHash);
    return { id: result.lastInsertRowid, username };
  },

  getUserByUsername: (username) => {
    return db.prepare('SELECT * FROM users WHERE username = ? AND is_active = 1').get(username);
  },

  // Update last login time (non-fatal — logged but not thrown)
  updateLastLogin: (userId) => {
    try {
      db.prepare('UPDATE users SET last_login = CURRENT_TIMESTAMP WHERE id = ?').run(userId);
    } catch (err) {
      console.warn('Failed to update last login:', err.message);
    }
  },

  getUserById: (userId) => {
    return db.prepare('SELECT id, username, created_at, last_login FROM users WHERE id = ? AND is_active = 1').get(userId);
  },

  getFirstUser: () => {
    return db.prepare('SELECT id, username, created_at, last_login FROM users WHERE is_active = 1 LIMIT 1').get();
  },

  updateGitConfig: (userId, gitName, gitEmail) => {
    db.prepare('UPDATE users SET git_name = ?, git_email = ? WHERE id = ?').run(gitName, gitEmail, userId);
  },

  getGitConfig: (userId) => {
    return db.prepare('SELECT git_name, git_email FROM users WHERE id = ?').get(userId);
  },

  completeOnboarding: (userId) => {
    db.prepare('UPDATE users SET has_completed_onboarding = 1 WHERE id = ?').run(userId);
  },

  hasCompletedOnboarding: (userId) => {
    const row = db.prepare('SELECT has_completed_onboarding FROM users WHERE id = ?').get(userId);
    return row?.has_completed_onboarding === 1;
  }
};

// API Keys database operations
const apiKeysDb = {
  generateApiKey: () => {
    return 'ck_' + crypto.randomBytes(32).toString('hex');
  },

  createApiKey: (userId, keyName) => {
    const apiKey = apiKeysDb.generateApiKey();
    const apiKeyHash = hashApiKey(apiKey);
    const stmt = db.prepare('INSERT INTO api_keys (user_id, key_name, api_key) VALUES (?, ?, ?)');
    const result = stmt.run(userId, keyName, apiKeyHash);
    return { id: result.lastInsertRowid, keyName, apiKey };
  },

  getApiKeys: (userId) => {
    return db.prepare('SELECT id, key_name, api_key, created_at, last_used, is_active FROM api_keys WHERE user_id = ? ORDER BY created_at DESC').all(userId);
  },

  validateApiKey: (apiKey) => {
    const apiKeyHash = hashApiKey(apiKey);
    const query = db.prepare(`
      SELECT u.id, u.username, ak.id as api_key_id
      FROM api_keys ak
      JOIN users u ON ak.user_id = u.id
      WHERE ak.api_key = ? AND ak.is_active = 1 AND u.is_active = 1
    `);

    let row = query.get(apiKeyHash);

    if (!row) {
      const legacyHash = hashApiKeyLegacy(apiKey);
      row = query.get(legacyHash);

      if (row) {
        db.prepare('UPDATE api_keys SET api_key = ? WHERE id = ?').run(apiKeyHash, row.api_key_id);
        console.warn('[SECURITY] Migrated legacy SHA-256 API key to HMAC storage. Please regenerate API keys soon.');
      }
    }

    if (!row) {
      const migrationDeadlineDays = parseInt(process.env.LEGACY_API_KEY_MIGRATION_DAYS) || 30;
      const firstStartup = db.prepare("SELECT value FROM app_settings WHERE key = 'first_startup'").get();

      if (firstStartup) {
        const deadline = new Date(firstStartup.value);
        deadline.setDate(deadline.getDate() + migrationDeadlineDays);

        if (new Date() > deadline) {
          console.warn('[SECURITY] Plaintext API key migration period has expired. Plaintext API keys are no longer accepted.');
          console.warn(`[SECURITY] Migration deadline was: ${deadline.toISOString()}`);
          console.warn('[SECURITY] Please regenerate your API keys from the UI.');
          return row;
        }
      }

      row = query.get(apiKey);

      if (row) {
        db.prepare('UPDATE api_keys SET api_key = ? WHERE id = ?').run(apiKeyHash, row.api_key_id);
        console.warn('[SECURITY] Migrated plaintext API key to HMAC storage.');
        console.warn('[SECURITY] WARNING: Plaintext API key fallback will be removed after the migration period.');
        console.warn('[SECURITY] Please regenerate your API keys from the UI to ensure continued access.');
      }
    }

    if (row) {
      db.prepare('UPDATE api_keys SET last_used = CURRENT_TIMESTAMP WHERE id = ?').run(row.api_key_id);
    }

    return row;
  },

  deleteApiKey: (userId, apiKeyId) => {
    const result = db.prepare('DELETE FROM api_keys WHERE id = ? AND user_id = ?').run(apiKeyId, userId);
    return result.changes > 0;
  },

  toggleApiKey: (userId, apiKeyId, isActive) => {
    const result = db.prepare('UPDATE api_keys SET is_active = ? WHERE id = ? AND user_id = ?').run(isActive ? 1 : 0, apiKeyId, userId);
    return result.changes > 0;
  }
};

// User credentials database operations (for GitHub tokens, GitLab tokens, etc.)
const credentialsDb = {
  createCredential: (userId, credentialName, credentialType, credentialValue, description = null) => {
    const encryptedValue = encrypt(credentialValue);
    const stmt = db.prepare('INSERT INTO user_credentials (user_id, credential_name, credential_type, credential_value, description) VALUES (?, ?, ?, ?, ?)');
    const result = stmt.run(userId, credentialName, credentialType, encryptedValue, description);
    return { id: result.lastInsertRowid, credentialName, credentialType };
  },

  getCredentials: (userId, credentialType = null) => {
    let query = 'SELECT id, credential_name, credential_type, description, created_at, is_active FROM user_credentials WHERE user_id = ?';
    const params = [userId];

    if (credentialType) {
      query += ' AND credential_type = ?';
      params.push(credentialType);
    }

    query += ' ORDER BY created_at DESC';
    return db.prepare(query).all(...params);
  },

  getActiveCredential: (userId, credentialType) => {
    const row = db.prepare('SELECT credential_value FROM user_credentials WHERE user_id = ? AND credential_type = ? AND is_active = 1 ORDER BY created_at DESC LIMIT 1').get(userId, credentialType);
    if (!row?.credential_value) return null;
    try {
      return decrypt(row.credential_value);
    } catch (e) {
      console.warn('Failed to decrypt credential, may be legacy plaintext:', e.message);
      return row.credential_value;
    }
  },

  deleteCredential: (userId, credentialId) => {
    const result = db.prepare('DELETE FROM user_credentials WHERE id = ? AND user_id = ?').run(credentialId, userId);
    return result.changes > 0;
  },

  toggleCredential: (userId, credentialId, isActive) => {
    const result = db.prepare('UPDATE user_credentials SET is_active = ? WHERE id = ? AND user_id = ?').run(isActive ? 1 : 0, credentialId, userId);
    return result.changes > 0;
  }
};

// Refresh tokens database operations
const refreshTokensDb = {
  storeRefreshToken: (userId, token) => {
    const tokenHash = hashRefreshToken(token);
    const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
    const result = db.prepare(
      'INSERT INTO refresh_tokens (user_id, token_hash, expires_at) VALUES (?, ?, ?)'
    ).run(userId, tokenHash, expiresAt.toISOString());
    return { id: result.lastInsertRowid, tokenHash };
  },

  validateRefreshToken: (token, userId) => {
    const tokenHash = hashRefreshToken(token);
    let row = db.prepare(`
      SELECT * FROM refresh_tokens
      WHERE token_hash = ? AND user_id = ? AND is_revoked = 0
      AND datetime(expires_at) > datetime('now')
    `).get(tokenHash, userId);

    if (!row) {
      const legacyHash = crypto.createHash('sha256').update(token).digest('hex');
      row = db.prepare(`
        SELECT * FROM refresh_tokens
        WHERE token_hash = ? AND user_id = ? AND is_revoked = 0
        AND datetime(expires_at) > datetime('now')
      `).get(legacyHash, userId);

      if (row) {
        db.prepare('UPDATE refresh_tokens SET token_hash = ? WHERE id = ?').run(tokenHash, row.id);
        console.warn('[SECURITY] Migrated legacy SHA-256 refresh token to HMAC storage.');
      }
    }

    return row !== undefined;
  },

  revokeRefreshToken: (token) => {
    const tokenHash = hashRefreshToken(token);
    let result = db.prepare('UPDATE refresh_tokens SET is_revoked = 1 WHERE token_hash = ?').run(tokenHash);

    if (result.changes === 0) {
      const legacyHash = crypto.createHash('sha256').update(token).digest('hex');
      result = db.prepare('UPDATE refresh_tokens SET is_revoked = 1 WHERE token_hash = ?').run(legacyHash);
    }

    return result.changes > 0;
  },

  revokeAllUserTokens: (userId) => {
    const result = db.prepare('UPDATE refresh_tokens SET is_revoked = 1 WHERE user_id = ?').run(userId);
    return result.changes;
  },

  isTokenRevoked: (token, userId) => {
    const tokenHash = hashRefreshToken(token);
    let row = db.prepare(`
      SELECT * FROM refresh_tokens
      WHERE token_hash = ? AND user_id = ? AND is_revoked = 1
    `).get(tokenHash, userId);

    if (!row) {
      const legacyHash = crypto.createHash('sha256').update(token).digest('hex');
      row = db.prepare(`
        SELECT * FROM refresh_tokens
        WHERE token_hash = ? AND user_id = ? AND is_revoked = 1
      `).get(legacyHash, userId);
    }

    return row !== undefined;
  },

  cleanupExpiredTokens: () => {
    const result = db.prepare("DELETE FROM refresh_tokens WHERE datetime(expires_at) < datetime('now')").run();
    return result.changes;
  }
};

// Session custom names database operations
const sessionNamesDb = {
  // Set (insert or update) a custom session name
  setName: (sessionId, provider, customName) => {
    db.prepare(`
      INSERT INTO session_names (session_id, provider, custom_name)
      VALUES (?, ?, ?)
      ON CONFLICT(session_id, provider)
      DO UPDATE SET custom_name = excluded.custom_name, updated_at = CURRENT_TIMESTAMP
    `).run(sessionId, provider, customName);
  },

  // Get a single custom session name
  getName: (sessionId, provider) => {
    const row = db.prepare(
      'SELECT custom_name FROM session_names WHERE session_id = ? AND provider = ?'
    ).get(sessionId, provider);
    return row?.custom_name || null;
  },

  // Batch lookup — returns Map<sessionId, customName>
  getNames: (sessionIds, provider) => {
    if (!sessionIds.length) return new Map();
    const placeholders = sessionIds.map(() => '?').join(',');
    const rows = db.prepare(
      `SELECT session_id, custom_name FROM session_names
       WHERE session_id IN (${placeholders}) AND provider = ?`
    ).all(...sessionIds, provider);
    return new Map(rows.map(r => [r.session_id, r.custom_name]));
  },

  // Delete a custom session name
  deleteName: (sessionId, provider) => {
    return db.prepare(
      'DELETE FROM session_names WHERE session_id = ? AND provider = ?'
    ).run(sessionId, provider).changes > 0;
  },
};

// Apply custom session names from the database (overrides CLI-generated summaries)
function applyCustomSessionNames(sessions, provider) {
  if (!sessions?.length) return;
  try {
    const ids = sessions.map(s => s.id);
    const customNames = sessionNamesDb.getNames(ids, provider);
    for (const session of sessions) {
      const custom = customNames.get(session.id);
      if (custom) session.summary = custom;
    }
  } catch (error) {
    console.warn(`[DB] Failed to apply custom session names for ${provider}:`, error.message);
  }
}

// Backward compatibility - keep old names pointing to new system
const githubTokensDb = {
  createGithubToken: (userId, tokenName, githubToken, description = null) => {
    return credentialsDb.createCredential(userId, tokenName, 'github_token', githubToken, description);
  },
  getGithubTokens: (userId) => {
    return credentialsDb.getCredentials(userId, 'github_token');
  },
  getActiveGithubToken: (userId) => {
    return credentialsDb.getActiveCredential(userId, 'github_token');
  },
  deleteGithubToken: (userId, tokenId) => {
    return credentialsDb.deleteCredential(userId, tokenId);
  },
  toggleGithubToken: (userId, tokenId, isActive) => {
    return credentialsDb.toggleCredential(userId, tokenId, isActive);
  }
};

export {
  db,
  initializeDatabase,
  userDb,
  apiKeysDb,
  credentialsDb,
  refreshTokensDb,
  sessionNamesDb,
  applyCustomSessionNames,
  githubTokensDb // Backward compatibility
};