import crypto from 'crypto';

// Must match the fallback in server/middleware/auth.js
const DEV_JWT_SECRET = 'claude-ui-dev-secret-do-not-use-in-production';

// Derive encryption key from dedicated ENCRYPTION_KEY or JWT_SECRET (which is already required)
const ENCRYPTION_KEY_SOURCE = process.env.ENCRYPTION_KEY
  || process.env.JWT_SECRET
  || (process.env.NODE_ENV !== 'production' ? DEV_JWT_SECRET : null);

if (!ENCRYPTION_KEY_SOURCE) {
  throw new Error('ENCRYPTION_KEY or JWT_SECRET must be set for encryption functionality');
}

if (!process.env.ENCRYPTION_KEY && !process.env.JWT_SECRET && process.env.NODE_ENV !== 'production') {
  console.warn('[WARN] Using default dev secret for encryption. Do NOT use this in production!');
}

// Derive a 32-byte key using HKDF (proper key derivation function)
const ENCRYPTION_KEY = Buffer.from(
  crypto.hkdfSync('sha256', ENCRYPTION_KEY_SOURCE, 'claudecodeui-salt', 'claudecodeui-encryption', 32)
);

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12;

/**
 * Encrypt a plaintext string using AES-256-GCM
 * @param {string} plaintext - The string to encrypt
 * @returns {string} - Base64-encoded ciphertext (iv:authTag:ciphertext)
 */
export function encrypt(plaintext) {
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, ENCRYPTION_KEY, iv);

  let encrypted = cipher.update(plaintext, 'utf8', 'base64');
  encrypted += cipher.final('base64');

  const authTag = cipher.getAuthTag();

  // Format: base64(iv):base64(authTag):base64(ciphertext)
  return `${iv.toString('base64')}:${authTag.toString('base64')}:${encrypted}`;
}

/**
 * Decrypt a ciphertext string encrypted with AES-256-GCM
 * @param {string} encryptedData - Base64-encoded ciphertext from encrypt()
 * @returns {string} - The decrypted plaintext
 */
export function decrypt(encryptedData) {
  const [ivBase64, authTagBase64, ciphertext] = encryptedData.split(':');

  if (!ivBase64 || !authTagBase64 || !ciphertext) {
    throw new Error('Invalid encrypted data format');
  }

  const iv = Buffer.from(ivBase64, 'base64');
  const authTag = Buffer.from(authTagBase64, 'base64');

  const decipher = crypto.createDecipheriv(ALGORITHM, ENCRYPTION_KEY, iv);
  decipher.setAuthTag(authTag);

  let decrypted = decipher.update(ciphertext, 'base64', 'utf8');
  decrypted += decipher.final('utf8');

  return decrypted;
}

/**
 * Hash an API key using HMAC-SHA256 (one-way, for storage)
 * @param {string} apiKey - The API key to hash
 * @returns {string} - Hex-encoded HMAC-SHA256 hash
 */
export function hashApiKey(apiKey) {
  return crypto.createHmac('sha256', ENCRYPTION_KEY_SOURCE).update(apiKey).digest('hex');
}

/**
 * Legacy hash using plain SHA-256 (for backward compatibility during migration)
 * @param {string} apiKey - The API key to hash
 * @returns {string} - Hex-encoded SHA-256 hash
 */
export function hashApiKeyLegacy(apiKey) {
  return crypto.createHash('sha256').update(apiKey).digest('hex');
}

/**
 * Hash a refresh token using HMAC-SHA256 (one-way, for storage)
 * Uses a different HMAC context than API keys for domain separation
 * @param {string} token - The refresh token to hash
 * @returns {string} - Hex-encoded HMAC-SHA256 hash
 */
export function hashRefreshToken(token) {
  return crypto.createHmac('sha256', ENCRYPTION_KEY_SOURCE).update(`refresh:${token}`).digest('hex');
}
