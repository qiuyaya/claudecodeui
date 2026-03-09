import { Router, Request, Response, NextFunction } from 'express';
import { promises as fs } from 'fs';
import fsSync from 'fs';
import path from 'path';
import { spawn, ChildProcess } from 'child_process';
import os from 'os';
import mime from 'mime-types';
import { addProjectManually, getSessions, getSessionMessages, renameProject, deleteSession, deleteProject, extractProjectDirectory } from '../projects.js';
import type { AuthRequest, UserCredential } from '../types/index.js';
import { getErrorMessage, isNodeError } from '../types/index.js';

/** Shape of a Codex JSONL token-usage entry */
interface CodexJsonlEntry {
  type: string;
  payload?: {
    type: string;
    info?: {
      total_token_usage?: {
        total_tokens?: number;
      };
      model_context_window?: number;
    };
  };
}

/** Shape of a Claude JSONL assistant entry with usage info */
interface ClaudeJsonlEntry {
  type: string;
  message?: {
    usage?: {
      input_tokens?: number;
      cache_creation_input_tokens?: number;
      cache_read_input_tokens?: number;
    };
  };
}

const router = Router();

function sanitizeGitError(message: string, token: string | null): string {
  if (!message || !token) return message;
  return message.replace(new RegExp(token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'), '***');
}

// Configure allowed workspace root (defaults to user's home directory)
export const WORKSPACES_ROOT: string = process.env.WORKSPACES_ROOT || os.homedir();

// System-critical paths that should never be used as workspace directories
export const FORBIDDEN_PATHS: string[] = [
  // Unix
  '/',
  '/etc',
  '/bin',
  '/sbin',
  '/usr',
  '/dev',
  '/proc',
  '/sys',
  '/var',
  '/boot',
  '/root',
  '/lib',
  '/lib64',
  '/opt',
  '/tmp',
  '/run',
  // Windows
  'C:\\Windows',
  'C:\\Program Files',
  'C:\\Program Files (x86)',
  'C:\\ProgramData',
  'C:\\System Volume Information',
  'C:\\$Recycle.Bin'
];

/**
 * Validates that a path is safe for workspace operations
 */
export async function validateWorkspacePath(requestedPath: string): Promise<{valid: boolean, resolvedPath?: string, error?: string}> {
  try {
    // Resolve to absolute path
    let absolutePath = path.resolve(requestedPath);

    // Check if path is a forbidden system directory
    const normalizedPath = path.normalize(absolutePath);
    if (FORBIDDEN_PATHS.includes(normalizedPath) || normalizedPath === '/') {
      return {
        valid: false,
        error: 'Cannot use system-critical directories as workspace locations'
      };
    }

    // Additional check for paths starting with forbidden directories
    for (const forbidden of FORBIDDEN_PATHS) {
      if (normalizedPath === forbidden ||
          normalizedPath.startsWith(forbidden + path.sep)) {
        // Exception: /var/tmp and similar user-accessible paths might be allowed
        // but /var itself and most /var subdirectories should be blocked
        if (forbidden === '/var' &&
            (normalizedPath.startsWith('/var/tmp') ||
             normalizedPath.startsWith('/var/folders'))) {
          continue; // Allow these specific cases
        }

        return {
          valid: false,
          error: `Cannot create workspace in system directory: ${forbidden}`
        };
      }
    }

    // Try to resolve the real path (following symlinks)
    let realPath: string;
    try {
      // Check if path exists to resolve real path
      await fs.access(absolutePath);
      realPath = await fs.realpath(absolutePath);
    } catch (error: unknown) {
      if (isNodeError(error) && error.code === 'ENOENT') {
        // Path doesn't exist yet - check parent directory
        let parentPath = path.dirname(absolutePath);
        try {
          const parentRealPath = await fs.realpath(parentPath);

          // Reconstruct the full path with real parent
          realPath = path.join(parentRealPath, path.basename(absolutePath));
        } catch (parentError: unknown) {
          if (isNodeError(parentError) && parentError.code === 'ENOENT') {
            // Parent doesn't exist either - use the absolute path as-is
            // We'll validate it's within allowed root
            realPath = absolutePath;
          } else {
            throw parentError;
          }
        }
      } else {
        throw error;
      }
    }

    // Resolve the workspace root to its real path
    const resolvedWorkspaceRoot = await fs.realpath(WORKSPACES_ROOT);

    // Ensure the resolved path is contained within the allowed workspace root
    if (!realPath.startsWith(resolvedWorkspaceRoot + path.sep) &&
        realPath !== resolvedWorkspaceRoot) {
      return {
        valid: false,
        error: `Workspace path must be within the allowed workspace root: ${WORKSPACES_ROOT}`
      };
    }

    // Additional symlink check for existing paths
    try {
      await fs.access(absolutePath);
      const stats = await fs.lstat(absolutePath);

      if (stats.isSymbolicLink()) {
        // Verify symlink target is also within allowed root
        const linkTarget = await fs.readlink(absolutePath);
        const resolvedTarget = path.resolve(path.dirname(absolutePath), linkTarget);
        const realTarget = await fs.realpath(resolvedTarget);

        if (!realTarget.startsWith(resolvedWorkspaceRoot + path.sep) &&
            realTarget !== resolvedWorkspaceRoot) {
          return {
            valid: false,
            error: 'Symlink target is outside the allowed workspace root'
          };
        }
      }
    } catch (error: unknown) {
      if (!isNodeError(error) || error.code !== 'ENOENT') {
        throw error;
      }
      // Path doesn't exist - that's fine for new workspace creation
    }

    return {
      valid: true,
      resolvedPath: realPath
    };

  } catch (error: unknown) {
    return {
      valid: false,
      error: `Path validation failed: ${getErrorMessage(error)}`
    };
  }
}

/**
 * Create a new workspace
 * POST /api/projects/create-workspace
 *
 * Body:
 * - workspaceType: 'existing' | 'new'
 * - path: string (workspace path)
 * - githubUrl?: string (optional, for new workspaces)
 * - githubTokenId?: number (optional, ID of stored token)
 * - newGithubToken?: string (optional, one-time token)
 */
router.post('/create-workspace', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const { workspaceType, path: workspacePath, githubUrl, githubTokenId, newGithubToken } = req.body;

    // Validate required fields
    if (!workspaceType || !workspacePath) {
      return res.status(400).json({ error: 'workspaceType and path are required' });
    }

    if (!['existing', 'new'].includes(workspaceType)) {
      return res.status(400).json({ error: 'workspaceType must be "existing" or "new"' });
    }

    // Validate path safety before any operations
    const validation = await validateWorkspacePath(workspacePath);
    if (!validation.valid) {
      return res.status(400).json({
        error: 'Invalid workspace path',
        details: validation.error
      });
    }

    const absolutePath = validation.resolvedPath!;

    // Handle existing workspace
    if (workspaceType === 'existing') {
      // Check if the path exists
      try {
        await fs.access(absolutePath);
        const stats = await fs.stat(absolutePath);

        if (!stats.isDirectory()) {
          return res.status(400).json({ error: 'Path exists but is not a directory' });
        }
      } catch (error: unknown) {
        if (isNodeError(error) && error.code === 'ENOENT') {
          return res.status(404).json({ error: 'Workspace path does not exist' });
        }
        throw error;
      }

      // Add the existing workspace to the project list
      const project = await addProjectManually(absolutePath);

      return res.json({
        success: true,
        project,
        message: 'Existing workspace added successfully'
      });
    }

    // Handle new workspace creation
    if (workspaceType === 'new') {
      // Create the directory if it doesn't exist
      await fs.mkdir(absolutePath, { recursive: true });

      // If GitHub URL is provided, clone the repository
      if (githubUrl) {
        let githubToken: string | null = null;

        // Get GitHub token if needed
        if (githubTokenId) {
          // Fetch token from database
          const token = await getGithubTokenById(githubTokenId, req.user!.id);
          if (!token) {
            // Clean up created directory
            await fs.rm(absolutePath, { recursive: true, force: true });
            return res.status(404).json({ error: 'GitHub token not found' });
          }
          githubToken = token.github_token;
        } else if (newGithubToken) {
          githubToken = newGithubToken;
        }

        // Extract repo name from URL for the clone destination
        const normalizedUrl = githubUrl.replace(/\/+$/, '').replace(/\.git$/, '');
        const repoName = normalizedUrl.split('/').pop() || 'repository';
        const clonePath = path.join(absolutePath, repoName);

        // Check if clone destination already exists to prevent data loss
        try {
          await fs.access(clonePath);
          return res.status(409).json({
            error: 'Directory already exists',
            details: `The destination path "${clonePath}" already exists. Please choose a different location or remove the existing directory.`
          });
        } catch (err: unknown) {
          // Directory doesn't exist, which is what we want
        }

        // Clone the repository into a subfolder
        try {
          await cloneGitHubRepository(githubUrl, clonePath, githubToken);
        } catch (error: unknown) {
          // Only clean up if clone created partial data (check if dir exists and is empty or partial)
          try {
            const stats = await fs.stat(clonePath);
            if (stats.isDirectory()) {
              await fs.rm(clonePath, { recursive: true, force: true });
            }
          } catch (cleanupError: unknown) {
            // Directory doesn't exist or cleanup failed - ignore
          }
          throw new Error(`Failed to clone repository: ${getErrorMessage(error)}`);
        }

        // Add the cloned repo path to the project list
        const project = await addProjectManually(clonePath);

        return res.json({
          success: true,
          project,
          message: 'New workspace created and repository cloned successfully'
        });
      }

      // Add the new workspace to the project list (no clone)
      const project = await addProjectManually(absolutePath);

      return res.json({
        success: true,
        project,
        message: 'New workspace created successfully'
      });
    }

  } catch (error: unknown) {
    next(error);
  }
});

/**
 * Helper function to get GitHub token from database
 */
async function getGithubTokenById(tokenId: number, userId: number): Promise<(UserCredential & { github_token: string }) | null> {
  const { db } = await import('../database/db.js');

  const credential = db.prepare(
    'SELECT * FROM user_credentials WHERE id = ? AND user_id = ? AND credential_type = ? AND is_active = 1'
  ).get(tokenId, userId, 'github_token') as UserCredential | undefined;

  // Return in the expected format (github_token field for compatibility)
  if (credential) {
    return {
      ...credential,
      github_token: credential.credential_value
    };
  }

  return null;
}

/**
 * Clone repository with progress streaming (SSE)
 * POST /api/projects/clone-progress
 */
router.post('/clone-progress', async (req: AuthRequest, res: Response) => {
  const { path: workspacePath, githubUrl, githubTokenId, newGithubToken } = req.body;

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const sendEvent = (type: string, data: Record<string, unknown>) => {
    res.write(`data: ${JSON.stringify({ type, ...data })}\n\n`);
  };

  try {
    if (!workspacePath || !githubUrl) {
      sendEvent('error', { message: 'workspacePath and githubUrl are required' });
      res.end();
      return;
    }

    const validation = await validateWorkspacePath(workspacePath);
    if (!validation.valid) {
      sendEvent('error', { message: validation.error });
      res.end();
      return;
    }

    const absolutePath = validation.resolvedPath!;

    await fs.mkdir(absolutePath, { recursive: true });

    let githubToken: string | null = null;
    if (githubTokenId) {
      const token = await getGithubTokenById(parseInt(githubTokenId), req.user!.id);
      if (!token) {
        await fs.rm(absolutePath, { recursive: true, force: true });
        sendEvent('error', { message: 'GitHub token not found' });
        res.end();
        return;
      }
      githubToken = token.github_token;
    } else if (newGithubToken) {
      githubToken = newGithubToken;
    }

    const normalizedUrl = githubUrl.replace(/\/+$/, '').replace(/\.git$/, '');
    const repoName = normalizedUrl.split('/').pop() || 'repository';
    const clonePath = path.join(absolutePath, repoName);

    // Check if clone destination already exists to prevent data loss
    try {
      await fs.access(clonePath);
      sendEvent('error', { message: `Directory "${repoName}" already exists. Please choose a different location or remove the existing directory.` });
      res.end();
      return;
    } catch (err: unknown) {
      // Directory doesn't exist, which is what we want
    }

    let cloneUrl = githubUrl;
    if (githubToken) {
      try {
        const url = new URL(githubUrl);
        url.username = githubToken;
        url.password = '';
        cloneUrl = url.toString();
      } catch (error: unknown) {
        // SSH URL or invalid - use as-is
      }
    }

    sendEvent('progress', { message: `Cloning into '${repoName}'...` });

    const gitProcess = spawn('git', ['clone', '--progress', cloneUrl, clonePath], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        GIT_TERMINAL_PROMPT: '0'
      }
    });

    let lastError = '';

    gitProcess.stdout!.on('data', (data: Buffer) => {
      const message = data.toString().trim();
      if (message) {
        sendEvent('progress', { message });
      }
    });

    gitProcess.stderr!.on('data', (data: Buffer) => {
      const message = data.toString().trim();
      lastError = message;
      if (message) {
        sendEvent('progress', { message });
      }
    });

    gitProcess.on('close', async (code: number | null) => {
      if (code === 0) {
        try {
          const project = await addProjectManually(clonePath);
          sendEvent('complete', { project, message: 'Repository cloned successfully' });
        } catch (error: unknown) {
          sendEvent('error', { message: `Clone succeeded but failed to add project: ${getErrorMessage(error)}` });
        }
      } else {
        const sanitizedError = sanitizeGitError(lastError, githubToken);
        let errorMessage = 'Git clone failed';
        if (lastError.includes('Authentication failed') || lastError.includes('could not read Username')) {
          errorMessage = 'Authentication failed. Please check your credentials.';
        } else if (lastError.includes('Repository not found')) {
          errorMessage = 'Repository not found. Please check the URL and ensure you have access.';
        } else if (lastError.includes('already exists')) {
          errorMessage = 'Directory already exists';
        } else if (sanitizedError) {
          errorMessage = sanitizedError;
        }
        try {
          await fs.rm(clonePath, { recursive: true, force: true });
        } catch (cleanupError: unknown) {
          console.error('Failed to clean up after clone failure:', sanitizeGitError(getErrorMessage(cleanupError), githubToken));
        }
        sendEvent('error', { message: errorMessage });
      }
      res.end();
    });

    gitProcess.on('error', (error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') {
        sendEvent('error', { message: 'Git is not installed or not in PATH' });
      } else {
        sendEvent('error', { message: error.message });
      }
      res.end();
    });

    req.on('close', () => {
      gitProcess.kill();
    });

  } catch (error: unknown) {
    sendEvent('error', { message: getErrorMessage(error) });
    res.end();
  }
});

/**
 * Helper function to clone a GitHub repository
 */
function cloneGitHubRepository(githubUrl: string, destinationPath: string, githubToken: string | null = null): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    let cloneUrl = githubUrl;

    if (githubToken) {
      try {
        const url = new URL(githubUrl);
        url.username = githubToken;
        url.password = '';
        cloneUrl = url.toString();
      } catch (error: unknown) {
        // SSH URL - use as-is
      }
    }

    const gitProcess = spawn('git', ['clone', '--progress', cloneUrl, destinationPath], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        GIT_TERMINAL_PROMPT: '0'
      }
    });

    let stdout = '';
    let stderr = '';

    gitProcess.stdout!.on('data', (data: Buffer) => {
      stdout += data.toString();
    });

    gitProcess.stderr!.on('data', (data: Buffer) => {
      stderr += data.toString();
    });

    gitProcess.on('close', (code: number | null) => {
      if (code === 0) {
        resolve({ stdout, stderr });
      } else {
        let errorMessage = 'Git clone failed';

        if (stderr.includes('Authentication failed') || stderr.includes('could not read Username')) {
          errorMessage = 'Authentication failed. Please check your GitHub token.';
        } else if (stderr.includes('Repository not found')) {
          errorMessage = 'Repository not found. Please check the URL and ensure you have access.';
        } else if (stderr.includes('already exists')) {
          errorMessage = 'Directory already exists';
        } else if (stderr) {
          errorMessage = stderr;
        }

        reject(new Error(errorMessage));
      }
    });

    gitProcess.on('error', (error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') {
        reject(new Error('Git is not installed or not in PATH'));
      } else {
        reject(error);
      }
    });
  });
}

// ── Project CRUD Routes ──

// Get projects list
router.get('/', async (req: Request, res: Response, next: NextFunction) => {
    try {
        const limit = parseInt(req.query.limit as string) || 0;
        const offset = parseInt(req.query.offset as string) || 0;
        const refresh = req.query.refresh === 'true';

        const { getCachedProjects, broadcastProgress } = req.app.locals;
        if (refresh) {
          req.app.locals.clearProjectsCache();
        }

        const projects = await getCachedProjects(broadcastProgress);

        if (limit > 0) {
          const paged = projects.slice(offset, offset + limit);
          res.json({
            projects: paged,
            total: projects.length,
            hasMore: offset + limit < projects.length
          });
        } else {
          res.json(projects);
        }
    } catch (error: unknown) {
        next(error);
    }
});

// Get sessions for a project
router.get('/:projectName/sessions', async (req: Request, res: Response, next: NextFunction) => {
    try {
        const { limit = '5', offset = '0' } = req.query as { limit?: string; offset?: string };
        const result = await getSessions(req.params.projectName, parseInt(limit), parseInt(offset));
        res.json(result);
    } catch (error: unknown) {
        next(error);
    }
});

// Get messages for a specific session
router.get('/:projectName/sessions/:sessionId/messages', async (req: Request, res: Response, next: NextFunction) => {
    try {
        const { projectName, sessionId } = req.params;
        const { limit, offset } = req.query as { limit?: string; offset?: string };

        const parsedLimit = limit ? parseInt(limit, 10) : null;
        const parsedOffset = offset ? parseInt(offset, 10) : 0;

        const result = await getSessionMessages(projectName, sessionId, parsedLimit, parsedOffset);

        if (Array.isArray(result)) {
            res.json({ messages: result });
        } else {
            res.json(result);
        }
    } catch (error: unknown) {
        next(error);
    }
});

// Rename project
router.put('/:projectName/rename', async (req: Request, res: Response, next: NextFunction) => {
    try {
        const { displayName } = req.body;
        await renameProject(req.params.projectName, displayName);
        res.json({ success: true });
    } catch (error: unknown) {
        next(error);
    }
});

// Delete session
router.delete('/:projectName/sessions/:sessionId', async (req: Request, res: Response, next: NextFunction) => {
    try {
        const { projectName, sessionId } = req.params;
        await deleteSession(projectName, sessionId);
        res.json({ success: true });
    } catch (error: unknown) {
        next(error);
    }
});

// Delete project
router.delete('/:projectName', async (req: Request, res: Response, next: NextFunction) => {
    try {
        const { projectName } = req.params;
        const force = req.query.force === 'true';
        const preserveSessions = req.query.preserveSessions === 'true';
        await deleteProject(projectName, force, preserveSessions);
        res.json({ success: true });
    } catch (error: unknown) {
        next(error);
    }
});

// Create project
router.post('/create', async (req: Request, res: Response, next: NextFunction) => {
    try {
        const { path: projectPath } = req.body;

        if (!projectPath || !projectPath.trim()) {
            return res.status(400).json({ error: 'Project path is required' });
        }

        const project = await addProjectManually(projectPath.trim());
        res.json({ success: true, project });
    } catch (error: unknown) {
        next(error);
    }
});

// ── File Operations ──

// Read file content
router.get('/:projectName/file', async (req: Request, res: Response, next: NextFunction) => {
    try {
        const { projectName } = req.params;
        const { filePath } = req.query as { filePath?: string };

        if (!filePath) {
            return res.status(400).json({ error: 'Invalid file path' });
        }

        const projectRoot = await extractProjectDirectory(projectName).catch(() => null);
        if (!projectRoot) {
            return res.status(404).json({ error: 'Project not found' });
        }

        const resolved = path.isAbsolute(filePath)
            ? path.resolve(filePath)
            : path.resolve(projectRoot, filePath);
        const normalizedRoot = path.resolve(projectRoot) + path.sep;
        if (!resolved.startsWith(normalizedRoot)) {
            return res.status(403).json({ error: 'Path must be under project root' });
        }

        const content = await fs.readFile(resolved, 'utf8');
        res.json({ content, path: resolved });
    } catch (error: unknown) {
        if (isNodeError(error) && error.code === 'ENOENT') {
            res.status(404).json({ error: 'File not found' });
        } else if (isNodeError(error) && error.code === 'EACCES') {
            res.status(403).json({ error: 'Permission denied' });
        } else {
            next(error);
        }
    }
});

// Serve binary file content (images, etc.)
router.get('/:projectName/files/content', async (req: Request, res: Response, next: NextFunction) => {
    try {
        const { projectName } = req.params;
        const { path: filePath } = req.query as { path?: string };

        if (!filePath) {
            return res.status(400).json({ error: 'Invalid file path' });
        }

        const projectRoot = await extractProjectDirectory(projectName).catch(() => null);
        if (!projectRoot) {
            return res.status(404).json({ error: 'Project not found' });
        }

        const resolved = path.resolve(filePath);
        const normalizedRoot = path.resolve(projectRoot) + path.sep;
        if (!resolved.startsWith(normalizedRoot)) {
            return res.status(403).json({ error: 'Path must be under project root' });
        }

        try {
            await fs.access(resolved);
        } catch (error: unknown) {
            return res.status(404).json({ error: 'File not found' });
        }

        const mimeType = mime.lookup(resolved) || 'application/octet-stream';
        res.setHeader('Content-Type', mimeType);

        const fileStream = fsSync.createReadStream(resolved);
        fileStream.pipe(res);

        fileStream.on('error', (error: Error) => {
            if (!res.headersSent) {
                next(error);
            }
        });

    } catch (error: unknown) {
        if (!res.headersSent) {
            next(error);
        }
    }
});

// Save file content
router.put('/:projectName/file', async (req: Request, res: Response, next: NextFunction) => {
    try {
        const { projectName } = req.params;
        const { filePath, content } = req.body;

        if (!filePath) {
            return res.status(400).json({ error: 'Invalid file path' });
        }

        if (content === undefined) {
            return res.status(400).json({ error: 'Content is required' });
        }

        const projectRoot = await extractProjectDirectory(projectName).catch(() => null);
        if (!projectRoot) {
            return res.status(404).json({ error: 'Project not found' });
        }

        const resolved = path.isAbsolute(filePath)
            ? path.resolve(filePath)
            : path.resolve(projectRoot, filePath);
        const normalizedRoot = path.resolve(projectRoot) + path.sep;
        if (!resolved.startsWith(normalizedRoot)) {
            return res.status(403).json({ error: 'Path must be under project root' });
        }

        await fs.writeFile(resolved, content, 'utf8');

        res.json({
            success: true,
            path: resolved,
            message: 'File saved successfully'
        });
    } catch (error: unknown) {
        if (isNodeError(error) && error.code === 'ENOENT') {
            res.status(404).json({ error: 'File or directory not found' });
        } else if (isNodeError(error) && error.code === 'EACCES') {
            res.status(403).json({ error: 'Permission denied' });
        } else {
            next(error);
        }
    }
});

// Get file tree for a project
router.get('/:projectName/files', async (req: Request, res: Response, next: NextFunction) => {
    try {
        let actualPath: string;
        try {
            actualPath = await extractProjectDirectory(req.params.projectName);
        } catch (error: unknown) {
            actualPath = (req.params.projectName as string).replace(/-/g, '/');
        }

        try {
            await fs.access(actualPath);
        } catch (e: unknown) {
            return res.status(404).json({ error: `Project path not found: ${actualPath}` });
        }

        const { getFileTree } = req.app.locals;
        const files = await getFileTree(actualPath, 10, 0, true);
        res.json(files);
    } catch (error: unknown) {
        next(error);
    }
});

// Get token usage for a specific session
router.get('/:projectName/sessions/:sessionId/token-usage', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { projectName, sessionId } = req.params;
    const { provider = 'claude' } = req.query as { provider?: string };
    const homeDir = os.homedir();

    const safeSessionId = String(sessionId).replace(/[^a-zA-Z0-9._-]/g, '');
    if (!safeSessionId) {
      return res.status(400).json({ error: 'Invalid sessionId' });
    }

    if (provider === 'cursor') {
      return res.json({
        used: 0,
        total: 0,
        breakdown: { input: 0, cacheCreation: 0, cacheRead: 0 },
        unsupported: true,
        message: 'Token usage tracking not available for Cursor sessions'
      });
    }

    if (provider === 'codex') {
      const codexSessionsDir = path.join(homeDir, '.codex', 'sessions');

      const findSessionFile = async (dir: string): Promise<string | null> => {
        try {
          const entries = await fs.readdir(dir, { withFileTypes: true });
          for (const entry of entries) {
            const fullPath = path.join(dir, entry.name);
            if (entry.isDirectory()) {
              const found = await findSessionFile(fullPath);
              if (found) return found;
            } else if (entry.name.includes(safeSessionId) && entry.name.endsWith('.jsonl')) {
              return fullPath;
            }
          }
        } catch (error: unknown) {
          // Skip directories we can't read
        }
        return null;
      };

      const sessionFilePath = await findSessionFile(codexSessionsDir);

      if (!sessionFilePath) {
        return res.status(404).json({ error: 'Codex session file not found', sessionId: safeSessionId });
      }

      let fileContent: string;
      try {
        fileContent = await fs.readFile(sessionFilePath, 'utf8');
      } catch (error: unknown) {
        if (isNodeError(error) && error.code === 'ENOENT') {
          return res.status(404).json({ error: 'Session file not found' });
        }
        throw error;
      }
      const lines = fileContent.trim().split('\n');
      let totalTokens = 0;
      let contextWindow = 200000;

      for (let i = lines.length - 1; i >= 0; i--) {
        try {
          const entry = JSON.parse(lines[i]) as CodexJsonlEntry;
          if (entry.type === 'event_msg' && entry.payload?.type === 'token_count' && entry.payload?.info) {
            const tokenInfo = entry.payload.info;
            if (tokenInfo.total_token_usage) {
              totalTokens = tokenInfo.total_token_usage.total_tokens || 0;
            }
            if (tokenInfo.model_context_window) {
              contextWindow = tokenInfo.model_context_window;
            }
            break;
          }
        } catch (parseError: unknown) {
          continue;
        }
      }

      return res.json({
        used: totalTokens,
        total: contextWindow
      });
    }

    // Handle Claude sessions (default)
    let projectPath: string;
    try {
      projectPath = await extractProjectDirectory(projectName);
    } catch (error: unknown) {
      return res.status(500).json({ error: 'Failed to determine project path' });
    }

    const encodedPath = projectPath.replace(/[\\/:\s~_]/g, '-');
    const projectDir = path.join(homeDir, '.claude', 'projects', encodedPath);

    const jsonlPath = path.join(projectDir, `${safeSessionId}.jsonl`);

    const rel = path.relative(path.resolve(projectDir), path.resolve(jsonlPath));
    if (rel.startsWith('..') || path.isAbsolute(rel)) {
      return res.status(400).json({ error: 'Invalid path' });
    }

    let fileContent: string;
    try {
      fileContent = await fs.readFile(jsonlPath, 'utf8');
    } catch (error: unknown) {
      if (isNodeError(error) && error.code === 'ENOENT') {
        return res.status(404).json({ error: 'Session file not found' });
      }
      throw error;
    }
    const lines = fileContent.trim().split('\n');

    const parsedContextWindow = parseInt(process.env.CONTEXT_WINDOW as string, 10);
    const contextWindow = Number.isFinite(parsedContextWindow) ? parsedContextWindow : 160000;
    let inputTokens = 0;
    let cacheCreationTokens = 0;
    let cacheReadTokens = 0;

    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const entry = JSON.parse(lines[i]) as ClaudeJsonlEntry;
        if (entry.type === 'assistant' && entry.message?.usage) {
          const usage = entry.message.usage;
          inputTokens = usage.input_tokens || 0;
          cacheCreationTokens = usage.cache_creation_input_tokens || 0;
          cacheReadTokens = usage.cache_read_input_tokens || 0;
          break;
        }
      } catch (parseError: unknown) {
        continue;
      }
    }

    const totalUsed = inputTokens + cacheCreationTokens + cacheReadTokens;

    res.json({
      used: totalUsed,
      total: contextWindow,
      breakdown: {
        input: inputTokens,
        cacheCreation: cacheCreationTokens,
        cacheRead: cacheReadTokens
      }
    });
  } catch (error: unknown) {
    next(error);
  }
});

export default router;
