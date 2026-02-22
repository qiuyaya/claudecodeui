#!/usr/bin/env node
// Load environment variables before other imports execute
import './load-env.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// ANSI color codes for terminal output
const colors = {
    reset: '\x1b[0m',
    bright: '\x1b[1m',
    cyan: '\x1b[36m',
    green: '\x1b[32m',
    yellow: '\x1b[33m',
    blue: '\x1b[34m',
    dim: '\x1b[2m',
};

const c = {
    info: (text) => `${colors.cyan}${text}${colors.reset}`,
    ok: (text) => `${colors.green}${text}${colors.reset}`,
    warn: (text) => `${colors.yellow}${text}${colors.reset}`,
    tip: (text) => `${colors.blue}${text}${colors.reset}`,
    bright: (text) => `${colors.bright}${text}${colors.reset}`,
    dim: (text) => `${colors.dim}${text}${colors.reset}`,
};

import express from 'express';
import { WebSocketServer, WebSocket } from 'ws';
import os from 'os';
import http from 'http';
import cors from 'cors';
import helmet from 'helmet';
import { promises as fsPromises } from 'fs';
import { getProjects, clearProjectDirectoryCache } from './projects.js';
import { queryClaudeSDK, abortClaudeSDKSession, isClaudeSDKSessionActive, getActiveClaudeSDKSessions, resolveToolApproval } from './claude-sdk.js';
import { spawnCursor, abortCursorSession, isCursorSessionActive, getActiveCursorSessions } from './cursor-cli.js';
import { queryCodex, abortCodexSession, isCodexSessionActive, getActiveCodexSessions } from './openai-codex.js';
import gitRoutes from './routes/git.js';
import authRoutes from './routes/auth.js';
import mcpRoutes from './routes/mcp.js';
import cursorRoutes from './routes/cursor.js';
import taskmasterRoutes from './routes/taskmaster.js';
import mcpUtilsRoutes from './routes/mcp-utils.js';
import commandsRoutes from './routes/commands.js';
import settingsRoutes from './routes/settings.js';
import agentRoutes from './routes/agent.js';
import projectsRoutes from './routes/projects.js';
import systemRoutes from './routes/system.js';
import filesystemRoutes from './routes/filesystem.js';
import mediaRoutes from './routes/media.js';
import cliAuthRoutes from './routes/cli-auth.js';
import userRoutes from './routes/user.js';
import codexRoutes from './routes/codex.js';
import { handleShellConnection } from './pty-manager.js';
import { initializeDatabase, refreshTokensDb } from './database/db.js';
import { validateApiKey, authenticateToken, authenticateWebSocket } from './middleware/auth.js';
import { IS_PLATFORM } from './constants/config.js';
import { apiLimiter } from './middleware/rateLimiter.js';
import { errorHandler, notFoundHandler } from './middleware/errorHandler.js';
import { logger } from './utils/logger.js';

// File system watcher for projects folder
let projectsWatcher = null;
let debounceTimer = null;
const connectedClients = new Set();
let isGetProjectsRunning = false; // Flag to prevent reentrant calls

// Broadcast progress to all connected WebSocket clients
function broadcastProgress(progress) {
    const message = JSON.stringify({
        type: 'loading_progress',
        ...progress
    });
    connectedClients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) {
            client.send(message);
        }
    });
}

// Setup file system watcher for Claude projects folder using chokidar
async function setupProjectsWatcher() {
    const chokidar = (await import('chokidar')).default;
    const claudeProjectsPath = path.join(os.homedir(), '.claude', 'projects');

    if (projectsWatcher) {
        clearTimeout(debounceTimer);
        projectsWatcher.close();
    }

    try {
        // Initialize chokidar watcher with optimized settings
        projectsWatcher = chokidar.watch(claudeProjectsPath, {
            ignored: [
                '**/node_modules/**',
                '**/.git/**',
                '**/dist/**',
                '**/build/**',
                '**/*.tmp',
                '**/*.swp',
                '**/.DS_Store'
            ],
            persistent: true,
            ignoreInitial: true, // Don't fire events for existing files on startup
            followSymlinks: false,
            depth: 10, // Reasonable depth limit
            awaitWriteFinish: {
                stabilityThreshold: 100, // Wait 100ms for file to stabilize
                pollInterval: 50
            }
        });

        // Debounce function to prevent excessive notifications
        const debouncedUpdate = async (eventType, filePath) => {
            clearTimeout(debounceTimer);
            debounceTimer = setTimeout(async () => {
                // Prevent reentrant calls
                if (isGetProjectsRunning) {
                    return;
                }

                try {
                    isGetProjectsRunning = true;

                    // Clear project directory cache when files change
                    clearProjectDirectoryCache();

                    // Get updated projects list
                    const updatedProjects = await getProjects(broadcastProgress);

                    // Notify all connected clients about the project changes
                    const updateMessage = JSON.stringify({
                        type: 'projects_updated',
                        projects: updatedProjects,
                        timestamp: new Date().toISOString(),
                        changeType: eventType,
                        changedFile: path.relative(claudeProjectsPath, filePath)
                    });

                    connectedClients.forEach(client => {
                        if (client.readyState === WebSocket.OPEN) {
                            client.send(updateMessage);
                        }
                    });

                } catch (error) {
                    console.error('[ERROR] Error handling project changes:', error);
                } finally {
                    isGetProjectsRunning = false;
                }
            }, 300); // 300ms debounce (slightly faster than before)
        };

        // Set up event listeners
        projectsWatcher
            .on('add', (filePath) => debouncedUpdate('add', filePath))
            .on('change', (filePath) => debouncedUpdate('change', filePath))
            .on('unlink', (filePath) => debouncedUpdate('unlink', filePath))
            .on('addDir', (dirPath) => debouncedUpdate('addDir', dirPath))
            .on('unlinkDir', (dirPath) => debouncedUpdate('unlinkDir', dirPath))
            .on('error', (error) => {
                console.error('[ERROR] Chokidar watcher error:', error);
            })
            .on('ready', () => {
            });

    } catch (error) {
        console.error('[ERROR] Failed to setup projects watcher:', error);
    }
}


const app = express();

// Configure trust proxy for correct client IP detection behind reverse proxies
// This affects req.ip, req.secure, and rate limiter behavior
if (process.env.TRUST_PROXY) {
  const trustProxy = process.env.TRUST_PROXY === 'true' ? true :
                     /^\d+$/.test(process.env.TRUST_PROXY) ? parseInt(process.env.TRUST_PROXY) :
                     process.env.TRUST_PROXY;
  app.set('trust proxy', trustProxy);
}

const server = http.createServer(app);

// Single WebSocket server that handles both paths
const wss = new WebSocketServer({
    server,
    verifyClient: (info) => {
        console.log('WebSocket connection attempt to:', info.req.url);

        // Platform mode: Enhanced security validation
        if (IS_PLATFORM) {
            // Use the actual TCP peer address, not spoofable headers
            const peerAddress = info.req.connection.remoteAddress || info.req.socket.remoteAddress;

            // Validate proxy identity headers
            const proxyUserId = info.req.headers['x-proxy-user-id'];
            const proxyUsername = info.req.headers['x-proxy-username'];

            if (!proxyUserId || !proxyUsername) {
                console.error('[SECURITY] Platform mode WebSocket: Missing proxy identity headers');
                return false;
            }

            // Audit log
            console.log(`[AUDIT] Platform mode WebSocket auth:`, {
                userId: proxyUserId,
                username: proxyUsername,
                ip: peerAddress
            });

            // authenticateWebSocket handles trusted proxy validation internally
            const user = authenticateWebSocket(null, peerAddress);
            if (!user) {
                console.log('[WARN] Platform mode: No user found in database');
                return false;
            }

            // Attach enhanced user info
            info.req.user = {
                ...user,
                platformUserId: proxyUserId,
                platformUsername: proxyUsername
            };

            console.log('[OK] Platform mode WebSocket authenticated for user:', proxyUsername);
            return true;
        }

        // Normal mode: verify token
        // Extract token from Sec-WebSocket-Protocol header (preferred) or Authorization header
        let token = null;

        // Method 1: WebSocket subprotocol (most secure - token not in URL)
        const protocols = info.req.headers['sec-websocket-protocol'];
        if (protocols) {
            const protocolArray = protocols.split(',').map(p => p.trim());
            // Look for protocol starting with "token."
            const tokenProtocol = protocolArray.find(p => p.startsWith('token.'));
            if (tokenProtocol) {
                token = tokenProtocol.substring(6); // Remove "token." prefix
                // Store the protocol name for handshake response
                info.req.selectedProtocol = 'token';
            }
        }

        // Method 2: Authorization header (fallback)
        if (!token) {
            const authHeader = info.req.headers.authorization;
            if (authHeader && authHeader.startsWith('Bearer ')) {
                token = authHeader.substring(7);
            }
        }

        // Security: Do NOT accept token from URL query parameters
        // This prevents tokens from appearing in server logs

        if (!token) {
            console.log('[WARN] WebSocket authentication failed: No token provided');
            return false;
        }

        // Verify token
        const user = authenticateWebSocket(token);
        if (!user) {
            console.log('[WARN] WebSocket authentication failed: Invalid token');
            return false;
        }

        // Store user info in the request for later use
        info.req.user = user;
        console.log('[OK] WebSocket authenticated for user:', user.username);
        return true;
    }
});

// Make WebSocket server available to routes
app.locals.wss = wss;

// HTTPS redirect in production
if (process.env.NODE_ENV === 'production' && process.env.FORCE_HTTPS !== 'false') {
  const appHost = process.env.APP_HOST;
  if (!appHost) {
    console.warn('[WARN] APP_HOST is not set. HTTPS redirect will use req.hostname which may be unsafe.');
    console.warn('  Set APP_HOST in your .env file for production deployments.');
  }
  app.use((req, res, next) => {
    // Check if request is already HTTPS (requires trust proxy to be set)
    if (!req.secure) {
      // Use configured host or fall back to req.hostname (which respects trust proxy)
      const host = appHost || req.hostname;
      return res.redirect(302, `https://${host}${req.url}`);
    }
    next();
  });
}

// Helmet security headers
app.use(helmet({
  // Content Security Policy
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'"], // CodeMirror needs unsafe-inline
      styleSrc: ["'self'", "'unsafe-inline'"],  // Tailwind needs unsafe-inline
      imgSrc: ["'self'", 'data:', 'https:'],
      connectSrc: ["'self'", 'ws:', 'wss:'],
      fontSrc: ["'self'", 'data:'],
      objectSrc: ["'none'"],
      mediaSrc: ["'self'"],
      frameSrc: ["'none'"],
      childSrc: ["'none'"],
      formAction: ["'self'"],
      upgradeInsecureRequests: process.env.NODE_ENV === 'production' && process.env.FORCE_HTTPS !== 'false' ? [] : null
    }
  },
  // HTTP Strict Transport Security
  hsts: process.env.FORCE_HTTPS !== 'false' ? {
    maxAge: 31536000, // 1 year
    includeSubDomains: true,
    preload: true
  } : false,
  // Referrer Policy
  referrerPolicy: {
    policy: 'strict-origin-when-cross-origin'
  },
  // X-Content-Type-Options
  noSniff: true,
  // X-Frame-Options
  frameguard: {
    action: 'deny'
  },
  // X-XSS-Protection is deprecated in modern browsers and can introduce
  // vulnerabilities in older ones. Explicitly disable it.
  xssFilter: false,
  // Hide X-Powered-By
  hidePoweredBy: true,
  // X-DNS-Prefetch-Control
  dnsPrefetchControl: {
    allow: false
  },
  // X-Download-Options
  ieNoOpen: true,
  // X-Permitted-Cross-Domain-Policies
  permittedCrossDomainPolicies: {
    permittedPolicies: 'none'
  }
}));

// Additional custom security headers
app.use((req, res, next) => {
  // Permissions Policy (formerly Feature Policy)
  res.setHeader('Permissions-Policy', 'geolocation=(), microphone=(), camera=(), payment=()');

  next();
});

// Configure CORS with security
const allowedOrigins = process.env.ALLOWED_ORIGINS
  ? process.env.ALLOWED_ORIGINS.split(',').map(o => o.trim())
  : (process.env.NODE_ENV === 'production'
      ? [] // Production: must explicitly configure
      : ['http://localhost:5173', 'http://localhost:3001', 'http://127.0.0.1:5173', 'http://127.0.0.1:3001']); // Development defaults

// Validate production configuration
if (process.env.NODE_ENV === 'production' && allowedOrigins.length === 0 && !IS_PLATFORM) {
  console.warn('');
  console.warn('[WARN] ALLOWED_ORIGINS is not set in production mode.');
  console.warn('   CORS will reject all cross-origin requests.');
  console.warn('   Set the domains that are allowed to access this API:');
  console.warn('   ALLOWED_ORIGINS=https://yourdomain.com,https://www.yourdomain.com');
  console.warn('');
}

// Log CORS configuration
console.log('');
console.log(c.dim('═'.repeat(60)));
console.log(`${c.info('[INFO]')} CORS Configuration:`);
if (allowedOrigins.includes('*')) {
  console.log(`       ${c.warn('⚠️  WARNING:')} Allowing ALL origins (*)`);
  console.log(`       ${c.dim('This is NOT recommended for production!')}`);
} else if (allowedOrigins.length > 0) {
  console.log(`       ${c.ok('Allowed origins:')}`);
  allowedOrigins.forEach(origin => {
    console.log(`       ${c.dim('→')} ${origin}`);
  });
} else if (IS_PLATFORM) {
  console.log(`       ${c.info('Platform mode:')} CORS handled by proxy`);
}
console.log(c.dim('═'.repeat(60)));
console.log('');

app.use(cors({
  origin: (origin, callback) => {
    // Allow requests with no origin (like mobile apps, curl, Postman)
    if (!origin) return callback(null, true);

    // Platform mode: allow all (handled by proxy)
    if (IS_PLATFORM) return callback(null, true);

    // Check if origin is in allowlist or wildcard
    if (allowedOrigins.includes('*') || allowedOrigins.includes(origin)) {
      callback(null, true);
    } else {
      console.warn(`${c.warn('[SECURITY]')} CORS blocked request from origin: ${origin}`);
      callback(new Error('Not allowed by CORS'));
    }
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Api-Key'],
  exposedHeaders: ['X-Total-Count', 'X-Page-Number']
}));

// Request body size limits (reduced from 50MB for security)
const DEFAULT_BODY_LIMIT = process.env.MAX_BODY_SIZE || '10mb';
const FILE_UPLOAD_LIMIT = process.env.MAX_FILE_SIZE || '50mb';

// Concurrent connections limit
let activeConnections = 0;
const MAX_CONCURRENT_CONNECTIONS = parseInt(process.env.MAX_CONNECTIONS) || 100;

// Connection limiter middleware
app.use((req, res, next) => {
  if (activeConnections >= MAX_CONCURRENT_CONNECTIONS) {
    console.warn(`[SECURITY] Max concurrent connections reached: ${activeConnections}`);
    return res.status(503).json({
      error: 'Service temporarily unavailable',
      message: 'Too many concurrent connections. Please try again later.',
      retryAfter: 10
    });
  }

  activeConnections++;

  // Decrement on response finish or close (use flag to prevent double-decrement)
  let cleaned = false;
  const cleanup = () => {
    if (!cleaned) {
      cleaned = true;
      activeConnections--;
    }
  };

  res.on('finish', cleanup);
  res.on('close', cleanup);

  next();
});

app.use(express.json({
  limit: DEFAULT_BODY_LIMIT,
  type: (req) => {
    // Skip multipart/form-data requests (for file uploads like images)
    const contentType = req.headers['content-type'] || '';
    if (contentType.includes('multipart/form-data')) {
      return false;
    }
    return contentType.includes('json');
  }
}));
app.use(express.urlencoded({ limit: DEFAULT_BODY_LIMIT, extended: true }));

// Public health check endpoint (no authentication required, no rate limit)
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString()
  });
});

// Apply rate limiting to all API endpoints
app.use('/api', apiLimiter);

// Optional API key validation (if configured)
app.use('/api', validateApiKey);

// Authentication routes (public)
app.use('/api/auth', authRoutes);

// Projects API Routes (protected)
app.use('/api/projects', authenticateToken, projectsRoutes);

// Git API Routes (protected)
app.use('/api/git', authenticateToken, gitRoutes);

// MCP API Routes (protected)
app.use('/api/mcp', authenticateToken, mcpRoutes);

// Cursor API Routes (protected)
app.use('/api/cursor', authenticateToken, cursorRoutes);

// TaskMaster API Routes (protected)
app.use('/api/taskmaster', authenticateToken, taskmasterRoutes);

// MCP utilities
app.use('/api/mcp-utils', authenticateToken, mcpUtilsRoutes);

// Commands API Routes (protected)
app.use('/api/commands', authenticateToken, commandsRoutes);

// Settings API Routes (protected)
app.use('/api/settings', authenticateToken, settingsRoutes);

// CLI Authentication API Routes (protected)
app.use('/api/cli', authenticateToken, cliAuthRoutes);

// User API Routes (protected)
app.use('/api/user', authenticateToken, userRoutes);

// Codex API Routes (protected)
app.use('/api/codex', authenticateToken, codexRoutes);

// Agent API Routes (uses API key authentication)
app.use('/api/agent', agentRoutes);

// System API Routes (protected)
app.use('/api/system', authenticateToken, systemRoutes);

// Filesystem API Routes (protected)
app.use('/api', authenticateToken, filesystemRoutes);

// Media API Routes (protected)
app.use('/api', authenticateToken, mediaRoutes);

// Serve public files (like api-docs.html)
app.use(express.static(path.join(__dirname, '../public')));

// Static files served after API routes
// Add cache control: HTML files should not be cached, but assets can be cached
app.use(express.static(path.join(__dirname, '../dist'), {
  setHeaders: (res, filePath) => {
    if (filePath.endsWith('.html')) {
      // Prevent HTML caching to avoid service worker issues after builds
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
      res.setHeader('Pragma', 'no-cache');
      res.setHeader('Expires', '0');
    } else if (filePath.match(/\.(js|css|woff2?|ttf|eot|svg|png|jpg|jpeg|gif|ico)$/)) {
      // Cache static assets for 1 year (they have hashed names)
      res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    }
  }
}));

// Project list cache
let projectsCache = null;
let projectsCacheTime = 0;
const PROJECTS_CACHE_TTL = 5 * 60 * 1000; // 5 minutes
let projectsCachePromise = null;

async function getCachedProjects(progressCallback) {
  const now = Date.now();
  if (projectsCache && (now - projectsCacheTime) < PROJECTS_CACHE_TTL) {
    return projectsCache;
  }
  if (projectsCachePromise) return projectsCachePromise;
  projectsCachePromise = getProjects(progressCallback).then(projects => {
    projectsCache = projects;
    projectsCacheTime = Date.now();
    projectsCachePromise = null;
    return projects;
  }).catch(err => {
    projectsCachePromise = null;
    throw err;
  });
  return projectsCachePromise;
}

// Share dependencies with route files via app.locals
app.locals.getCachedProjects = getCachedProjects;
app.locals.broadcastProgress = broadcastProgress;
app.locals.getFileTree = getFileTree;
app.locals.clearProjectsCache = () => {
  projectsCache = null;
  projectsCacheTime = 0;
};

// WebSocket connection handler that routes based on URL path
wss.on('connection', (ws, request) => {
    const url = request.url;
    console.log('[INFO] Client connected to:', url);

    // Note: WebSocket protocol is read-only and set during handshake
    // The selected protocol can be accessed via ws.protocol (getter only)
    // No need to set it here as it's already determined by the handshake

    // Parse URL to get pathname without query parameters
    const urlObj = new URL(url, 'http://localhost');
    const pathname = urlObj.pathname;

    if (pathname === '/shell') {
        handleShellConnection(ws);
    } else if (pathname === '/ws') {
        handleChatConnection(ws);
    } else {
        console.log('[WARN] Unknown WebSocket path:', pathname);
        ws.close();
    }
});

/**
 * WebSocket Writer - Wrapper for WebSocket to match SSEStreamWriter interface
 */
class WebSocketWriter {
  constructor(ws) {
    this.ws = ws;
    this.sessionId = null;
    this.isWebSocketWriter = true;  // Marker for transport detection
  }

  send(data) {
    if (this.ws.readyState === 1) { // WebSocket.OPEN
      // Providers send raw objects, we stringify for WebSocket
      this.ws.send(JSON.stringify(data));
    }
  }

  setSessionId(sessionId) {
    this.sessionId = sessionId;
  }

  getSessionId() {
    return this.sessionId;
  }
}

// Handle chat WebSocket connections
function handleChatConnection(ws) {
    console.log('[INFO] Chat WebSocket connected');

    // Add to connected clients for project updates
    connectedClients.add(ws);

    // Wrap WebSocket with writer for consistent interface with SSEStreamWriter
    const writer = new WebSocketWriter(ws);

    ws.on('message', async (message) => {
        try {
            const data = JSON.parse(message);

            if (data.type === 'claude-command') {
                console.log('[DEBUG] User message:', data.command || '[Continue/Resume]');
                console.log('📁 Project:', data.options?.projectPath || 'Unknown');
                console.log('🔄 Session:', data.options?.sessionId ? 'Resume' : 'New');

                // Use Claude Agents SDK
                await queryClaudeSDK(data.command, data.options, writer);
            } else if (data.type === 'cursor-command') {
                console.log('[DEBUG] Cursor message:', data.command || '[Continue/Resume]');
                console.log('📁 Project:', data.options?.cwd || 'Unknown');
                console.log('🔄 Session:', data.options?.sessionId ? 'Resume' : 'New');
                console.log('🤖 Model:', data.options?.model || 'default');
                await spawnCursor(data.command, data.options, writer);
            } else if (data.type === 'codex-command') {
                console.log('[DEBUG] Codex message:', data.command || '[Continue/Resume]');
                console.log('📁 Project:', data.options?.projectPath || data.options?.cwd || 'Unknown');
                console.log('🔄 Session:', data.options?.sessionId ? 'Resume' : 'New');
                console.log('🤖 Model:', data.options?.model || 'default');
                await queryCodex(data.command, data.options, writer);
            } else if (data.type === 'cursor-resume') {
                // Backward compatibility: treat as cursor-command with resume and no prompt
                console.log('[DEBUG] Cursor resume session (compat):', data.sessionId);
                await spawnCursor('', {
                    sessionId: data.sessionId,
                    resume: true,
                    cwd: data.options?.cwd
                }, writer);
            } else if (data.type === 'abort-session') {
                console.log('[DEBUG] Abort session request:', data.sessionId);
                const provider = data.provider || 'claude';
                let success;

                if (provider === 'cursor') {
                    success = abortCursorSession(data.sessionId);
                } else if (provider === 'codex') {
                    success = abortCodexSession(data.sessionId);
                } else {
                    // Use Claude Agents SDK
                    success = await abortClaudeSDKSession(data.sessionId);
                }

                writer.send({
                    type: 'session-aborted',
                    sessionId: data.sessionId,
                    provider,
                    success
                });
            } else if (data.type === 'claude-permission-response') {
                // Relay UI approval decisions back into the SDK control flow.
                // This does not persist permissions; it only resolves the in-flight request,
                // introduced so the SDK can resume once the user clicks Allow/Deny.
                if (data.requestId) {
                    resolveToolApproval(data.requestId, {
                        allow: Boolean(data.allow),
                        updatedInput: data.updatedInput,
                        message: data.message,
                        rememberEntry: data.rememberEntry
                    });
                }
            } else if (data.type === 'cursor-abort') {
                console.log('[DEBUG] Abort Cursor session:', data.sessionId);
                const success = abortCursorSession(data.sessionId);
                writer.send({
                    type: 'session-aborted',
                    sessionId: data.sessionId,
                    provider: 'cursor',
                    success
                });
            } else if (data.type === 'check-session-status') {
                // Check if a specific session is currently processing
                const provider = data.provider || 'claude';
                const sessionId = data.sessionId;
                let isActive;

                if (provider === 'cursor') {
                    isActive = isCursorSessionActive(sessionId);
                } else if (provider === 'codex') {
                    isActive = isCodexSessionActive(sessionId);
                } else {
                    // Use Claude Agents SDK
                    isActive = isClaudeSDKSessionActive(sessionId);
                }

                writer.send({
                    type: 'session-status',
                    sessionId,
                    provider,
                    isProcessing: isActive
                });
            } else if (data.type === 'get-active-sessions') {
                // Get all currently active sessions
                const activeSessions = {
                    claude: getActiveClaudeSDKSessions(),
                    cursor: getActiveCursorSessions(),
                    codex: getActiveCodexSessions()
                };
                writer.send({
                    type: 'active-sessions',
                    sessions: activeSessions
                });
            }
        } catch (error) {
            console.error('[ERROR] Chat WebSocket error:', error.message);
            writer.send({
                type: 'error',
                error: error.message
            });
        }
    });

    ws.on('close', () => {
        console.log('🔌 Chat client disconnected');
        // Remove from connected clients
        connectedClients.delete(ws);
    });
}

// Serve React app for all other routes (excluding static files)
app.get('*', (req, res) => {
  // Skip requests for static assets (files with extensions)
  if (path.extname(req.path)) {
    return res.status(404).send('Not found');
  }

  // Only serve index.html for HTML routes, not for static assets
  // Static assets should already be handled by express.static middleware above
  const indexPath = path.join(__dirname, '../dist/index.html');

  // Check if dist/index.html exists (production build available)
  if (fs.existsSync(indexPath)) {
    // Set no-cache headers for HTML to prevent service worker issues
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
    res.sendFile(indexPath);
  } else {
    // In development, redirect to Vite dev server only if dist doesn't exist
    res.redirect(`http://localhost:${process.env.VITE_PORT || 5173}`);
  }
});

// Helper function to convert permissions to rwx format
function permToRwx(perm) {
    const r = perm & 4 ? 'r' : '-';
    const w = perm & 2 ? 'w' : '-';
    const x = perm & 1 ? 'x' : '-';
    return r + w + x;
}

async function getFileTree(dirPath, maxDepth = 3, currentDepth = 0, showHidden = true) {
    // Using fsPromises from import
    const items = [];

    try {
        const entries = await fsPromises.readdir(dirPath, { withFileTypes: true });

        for (const entry of entries) {
            // Debug: log all entries including hidden files


            // Skip heavy build directories and VCS directories
            if (entry.name === 'node_modules' ||
                entry.name === 'dist' ||
                entry.name === 'build' ||
                entry.name === '.git' ||
                entry.name === '.svn' ||
                entry.name === '.hg') continue;

            const itemPath = path.join(dirPath, entry.name);
            const item = {
                name: entry.name,
                path: itemPath,
                type: entry.isDirectory() ? 'directory' : 'file'
            };

            // Get file stats for additional metadata
            try {
                const stats = await fsPromises.stat(itemPath);
                item.size = stats.size;
                item.modified = stats.mtime.toISOString();

                // Convert permissions to rwx format
                const mode = stats.mode;
                const ownerPerm = (mode >> 6) & 7;
                const groupPerm = (mode >> 3) & 7;
                const otherPerm = mode & 7;
                item.permissions = ((mode >> 6) & 7).toString() + ((mode >> 3) & 7).toString() + (mode & 7).toString();
                item.permissionsRwx = permToRwx(ownerPerm) + permToRwx(groupPerm) + permToRwx(otherPerm);
            } catch (statError) {
                // If stat fails, provide default values
                item.size = 0;
                item.modified = null;
                item.permissions = '000';
                item.permissionsRwx = '---------';
            }

            if (entry.isDirectory() && currentDepth < maxDepth) {
                // Recursively get subdirectories but limit depth
                try {
                    // Check if we can access the directory before trying to read it
                    await fsPromises.access(item.path, fs.constants.R_OK);
                    item.children = await getFileTree(item.path, maxDepth, currentDepth + 1, showHidden);
                } catch (e) {
                    // Silently skip directories we can't access (permission denied, etc.)
                    item.children = [];
                }
            }

            items.push(item);
        }
    } catch (error) {
        // Only log non-permission errors to avoid spam
        if (error.code !== 'EACCES' && error.code !== 'EPERM') {
            console.error('Error reading directory:', error);
        }
    }

    return items.sort((a, b) => {
        if (a.type !== b.type) {
            return a.type === 'directory' ? -1 : 1;
        }
        return a.name.localeCompare(b.name);
    });
}

// Error Handling Middleware
// Must be added after all routes
app.use(notFoundHandler);
app.use(errorHandler);

// Global error handlers for uncaught exceptions
process.on('uncaughtException', (error) => {
    logger.error('Uncaught Exception', error, {
        type: 'uncaughtException'
    });
    console.error('[FATAL] Uncaught Exception:', error);
    // Give time for logs to write before exiting
    setTimeout(() => {
        process.exit(1);
    }, 1000);
});

process.on('unhandledRejection', (reason, promise) => {
    logger.error('Unhandled Promise Rejection', reason instanceof Error ? reason : new Error(String(reason)), {
        type: 'unhandledRejection',
        promise: String(promise)
    });
    console.error('[ERROR] Unhandled Promise Rejection:', reason);
});

const PORT = process.env.PORT || 3001;
const HOST = process.env.HOST || '0.0.0.0';
// Show localhost in URL when binding to all interfaces (0.0.0.0 isn't a connectable address)
const DISPLAY_HOST = HOST === '0.0.0.0' ? 'localhost' : HOST;

// Initialize database and start server
async function startServer() {
    try {
        // Initialize authentication database
        await initializeDatabase();

        // Schedule periodic cleanup of expired refresh tokens (every 6 hours)
        setInterval(() => {
          try {
            const cleaned = refreshTokensDb.cleanupExpiredTokens();
            if (cleaned > 0) {
              console.log(`[INFO] Cleaned up ${cleaned} expired refresh tokens`);
            }
          } catch (e) {
            console.error('[ERROR] Failed to cleanup expired tokens:', e.message);
          }
        }, 6 * 60 * 60 * 1000);

        // Check if running in production mode (dist folder exists)
        const distIndexPath = path.join(__dirname, '../dist/index.html');
        const isProduction = fs.existsSync(distIndexPath);

        // Log Claude implementation mode
        console.log(`${c.info('[INFO]')} Using Claude Agents SDK for Claude integration`);
        console.log(`${c.info('[INFO]')} Running in ${c.bright(isProduction ? 'PRODUCTION' : 'DEVELOPMENT')} mode`);

        if (!isProduction) {
            console.log(`${c.warn('[WARN]')} Note: Requests will be proxied to Vite dev server at ${c.dim('http://localhost:' + (process.env.VITE_PORT || 5173))}`);
        }

        server.listen(PORT, HOST, async () => {
            const appInstallPath = path.join(__dirname, '..');

            console.log('');
            console.log(c.dim('═'.repeat(63)));
            console.log(`  ${c.bright('Claude Code UI Server - Ready')}`);
            console.log(c.dim('═'.repeat(63)));
            console.log('');
            console.log(`${c.info('[INFO]')} Server URL:  ${c.bright('http://' + DISPLAY_HOST + ':' + PORT)}`);
            console.log(`${c.info('[INFO]')} Installed at: ${c.dim(appInstallPath)}`);
            console.log(`${c.tip('[TIP]')}  Run "cloudcli status" for full configuration details`);
            console.log('');

            // Start watching the projects folder for changes
            await setupProjectsWatcher();
        });
    } catch (error) {
        console.error('[ERROR] Failed to start server:', error);
        process.exit(1);
    }
}

startServer();
