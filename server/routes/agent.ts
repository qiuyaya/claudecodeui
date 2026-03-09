import express, { Router, Request, Response, NextFunction } from 'express';
import { spawn, ChildProcess } from 'child_process';
import path from 'path';
import os from 'os';
import { promises as fs } from 'fs';
import crypto from 'crypto';
import { userDb, apiKeysDb, githubTokensDb } from '../database/db.js';
import { addProjectManually } from '../projects.js';
import { validateWorkspacePath } from './projects.js';
import { queryClaudeSDK } from '../claude-sdk.js';
import { spawnCursor } from '../cursor-cli.js';
import { queryCodex } from '../openai-codex.js';
import { spawnGemini } from '../gemini-cli.js';
import { Octokit } from '@octokit/rest';
import { CLAUDE_MODELS, CURSOR_MODELS, CODEX_MODELS } from '../../shared/modelConstants.js';
import { IS_PLATFORM } from '../constants/config.js';
import { getSanitizedEnv } from '../utils/env.js';
import type { AuthRequest } from '../types/index.js';
import { logger } from '../utils/logger.js';

const router: Router = express.Router();

/** Shape of streamed messages from SDK/CLI providers */
interface StreamMessageData {
  type?: string;
  sessionId?: string;
  data?: {
    type?: string;
    message?: {
      usage?: {
        input_tokens?: number;
        output_tokens?: number;
        cache_read_input_tokens?: number;
        cache_creation_input_tokens?: number;
      };
    };
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

interface BranchInfo {
  name: string;
  url: string;
}

interface PRInfo {
  number: number;
  url: string;
}

interface WriterInterface {
  send(data: unknown): void;
  end(): void;
  setSessionId(sessionId: string): void;
  getSessionId(): string | null;
  isSSEStreamWriter?: boolean;
}

/**
 * Middleware to authenticate agent API requests.
 */
const validateExternalApiKey = (req: Request, res: Response, next: NextFunction): void => {
  if (IS_PLATFORM) {
    try {
      const user = userDb.getFirstUser();
      if (!user) {
        res.status(500).json({ error: 'Platform mode: No user found in database' });
        return;
      }
      (req as AuthRequest).user = user;
      return next();
    } catch (error: unknown) {
      logger.error('Platform mode error', error instanceof Error ? error : null);
      res.status(500).json({ error: 'Platform mode: Failed to fetch user' });
      return;
    }
  }

  const apiKey: string | undefined = (req.headers['x-api-key'] as string) || (req.query.apiKey as string);

  if (!apiKey) {
    res.status(401).json({ error: 'API key required' });
    return;
  }

  const user = apiKeysDb.validateApiKey(apiKey);

  if (!user) {
    res.status(401).json({ error: 'Invalid or inactive API key' });
    return;
  }

  (req as AuthRequest).user = user;
  next();
};

async function getGitRemoteUrl(repoPath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const gitProcess: ChildProcess = spawn('git', ['config', '--get', 'remote.origin.url'], {
      cwd: repoPath,
      stdio: ['pipe', 'pipe', 'pipe']
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
        resolve(stdout.trim());
      } else {
        reject(new Error(`Failed to get git remote: ${stderr}`));
      }
    });

    gitProcess.on('error', (error: Error) => {
      reject(new Error(`Failed to execute git: ${error.message}`));
    });
  });
}

function normalizeGitHubUrl(url: string): string {
  let normalized = url.replace(/\.git$/, '');
  normalized = normalized.replace(/^git@github\.com:/, 'https://github.com/');
  normalized = normalized.replace(/\/$/, '');
  return normalized.toLowerCase();
}

function parseGitHubUrl(url: string): { owner: string; repo: string } {
  const match = url.match(/github\.com[:/]([^/]+)\/([^/]+?)(?:\.git)?$/);
  if (!match) {
    throw new Error('Invalid GitHub URL format');
  }
  return {
    owner: match[1],
    repo: match[2].replace(/\.git$/, '')
  };
}

function autogenerateBranchName(message: string): string {
  let branchName = message
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');

  if (!branchName) {
    branchName = 'task';
  }

  const timestamp = Date.now().toString(36).slice(-6);
  const suffix = `-${timestamp}`;

  const maxBaseLength = 50 - suffix.length;
  if (branchName.length > maxBaseLength) {
    branchName = branchName.substring(0, maxBaseLength);
  }

  branchName = branchName.replace(/-$/, '').replace(/^-+/, '');

  if (!branchName || branchName.startsWith('-')) {
    branchName = 'task';
  }

  branchName = `${branchName}${suffix}`;

  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(branchName)) {
    return `branch-${timestamp}`;
  }

  return branchName;
}

function validateBranchName(branchName: string): { valid: boolean; error?: string } {
  if (!branchName || branchName.trim() === '') {
    return { valid: false, error: 'Branch name cannot be empty' };
  }

  const invalidPatterns: Array<{ pattern: RegExp; message: string }> = [
    { pattern: /^\./, message: 'Branch name cannot start with a dot' },
    { pattern: /\.$/, message: 'Branch name cannot end with a dot' },
    { pattern: /\.\./, message: 'Branch name cannot contain consecutive dots (..)' },
    { pattern: /\s/, message: 'Branch name cannot contain spaces' },
    { pattern: /[~^:?*[\\\]]/, message: 'Branch name cannot contain special characters: ~ ^ : ? * [ \\' },
    { pattern: /@{/, message: 'Branch name cannot contain @{' },
    { pattern: /\/$/, message: 'Branch name cannot end with a slash' },
    { pattern: /^\//, message: 'Branch name cannot start with a slash' },
    { pattern: /\/\//, message: 'Branch name cannot contain consecutive slashes' },
    { pattern: /\.lock$/, message: 'Branch name cannot end with .lock' }
  ];

  for (const { pattern, message } of invalidPatterns) {
    if (pattern.test(branchName)) {
      return { valid: false, error: message };
    }
  }

  if (/[\x00-\x1F\x7F]/.test(branchName)) {
    return { valid: false, error: 'Branch name cannot contain control characters' };
  }

  return { valid: true };
}

async function getCommitMessages(projectPath: string, limit: number = 5): Promise<string[]> {
  return new Promise((resolve, reject) => {
    const gitProcess: ChildProcess = spawn('git', ['log', `-${limit}`, '--pretty=format:%s'], {
      cwd: projectPath,
      stdio: ['pipe', 'pipe', 'pipe']
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
        const messages = stdout.trim().split('\n').filter((msg: string) => msg.length > 0);
        resolve(messages);
      } else {
        reject(new Error(`Failed to get commit messages: ${stderr}`));
      }
    });

    gitProcess.on('error', (error: Error) => {
      reject(new Error(`Failed to execute git: ${error.message}`));
    });
  });
}

async function createGitHubBranch(octokit: Octokit, owner: string, repo: string, branchName: string, baseBranch: string = 'main'): Promise<void> {
  try {
    const { data: ref } = await octokit.git.getRef({
      owner,
      repo,
      ref: `heads/${baseBranch}`
    });

    const baseSha: string = ref.object.sha;

    await octokit.git.createRef({
      owner,
      repo,
      ref: `refs/heads/${branchName}`,
      sha: baseSha
    });

    logger.info(`Created branch '${branchName}' on GitHub`);
  } catch (error: unknown) {
    const ghError = error as Error & { status?: number };
    if (ghError.status === 422 && ghError.message?.includes('Reference already exists')) {
      logger.info(`Branch '${branchName}' already exists on GitHub`);
    } else {
      throw error;
    }
  }
}

async function createGitHubPR(octokit: Octokit, owner: string, repo: string, branchName: string, title: string, body: string, baseBranch: string = 'main'): Promise<{ number: number; url: string }> {
  const { data: pr } = await octokit.pulls.create({
    owner,
    repo,
    title,
    head: branchName,
    base: baseBranch,
    body
  });

  logger.info(`Created pull request #${pr.number}: ${pr.html_url}`);

  return {
    number: pr.number,
    url: pr.html_url
  };
}

async function cloneGitHubRepo(githubUrl: string, githubToken: string | null = null, projectPath: string): Promise<string> {
  if (!githubUrl || !githubUrl.includes('github.com')) {
    throw new Error('Invalid GitHub URL');
  }

  const cloneDir: string = path.resolve(projectPath);

  try {
    await fs.access(cloneDir);
    try {
      const existingUrl = await getGitRemoteUrl(cloneDir);
      const normalizedExisting = normalizeGitHubUrl(existingUrl);
      const normalizedRequested = normalizeGitHubUrl(githubUrl);

      if (normalizedExisting === normalizedRequested) {
        logger.info('Repository already exists at path with correct URL');
        return cloneDir;
      } else {
        throw new Error(`Directory ${cloneDir} already exists with a different repository (${existingUrl}). Expected: ${githubUrl}`);
      }
    } catch (gitError: unknown) {
      throw new Error(`Directory ${cloneDir} already exists but is not a valid git repository or git command failed`);
    }
  } catch (accessError: unknown) {
    // Directory doesn't exist - proceed with clone
  }

  await fs.mkdir(path.dirname(cloneDir), { recursive: true });

  const cloneUrl: string = githubUrl;
  const cloneEnv: Record<string, string> = getSanitizedEnv();

  if (githubToken) {
    cloneEnv.GIT_CONFIG_COUNT = '1';
    cloneEnv.GIT_CONFIG_KEY_0 = 'http.https://github.com/.extraheader';
    cloneEnv.GIT_CONFIG_VALUE_0 = `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${githubToken}`).toString('base64')}`;
  }

  logger.info('Cloning repository:', { url: githubUrl });
  logger.info('Destination:', { path: cloneDir });

  const abortController = new AbortController();
  const cloneTimeout: ReturnType<typeof setTimeout> = setTimeout(() => {
    abortController.abort();
  }, 60000);

  const gitProcess: ChildProcess = spawn('git', ['clone', '--depth', '1', cloneUrl, cloneDir], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: cloneEnv,
    signal: abortController.signal
  });

  let stdout = '';
  let stderr = '';

  gitProcess.stdout!.on('data', (data: Buffer) => {
    stdout += data.toString();
  });

  gitProcess.stderr!.on('data', (data: Buffer) => {
    stderr += data.toString();
    logger.info('Git stderr:', { output: data.toString() });
  });

  return new Promise((resolve, reject) => {
    gitProcess.on('close', (code: number | null) => {
      clearTimeout(cloneTimeout);
      if (code === 0) {
        logger.info('Repository cloned successfully');
        resolve(cloneDir);
      } else {
        logger.error('Git clone failed', null, { stderr });
        reject(new Error(`Git clone failed: ${stderr}`));
      }
    });

    gitProcess.on('error', (error: Error) => {
      clearTimeout(cloneTimeout);
      if (error.name === 'AbortError') {
        reject(new Error('Git clone timed out after 60 seconds'));
      } else {
        reject(new Error(`Failed to execute git: ${error.message}`));
      }
    });
  });
}

async function cleanupProject(projectPath: string, sessionId: string | null = null): Promise<void> {
  try {
    if (!projectPath.includes('.claude/external-projects')) {
      logger.warn('Refusing to clean up non-external project', { path: projectPath });
      return;
    }

    logger.info('Cleaning up project:', { path: projectPath });
    await fs.rm(projectPath, { recursive: true, force: true });
    logger.info('Project cleaned up');

    if (sessionId) {
      try {
        const sessionPath = path.join(os.homedir(), '.claude', 'sessions', sessionId);
        logger.info('Cleaning up session directory:', { path: sessionPath });
        await fs.rm(sessionPath, { recursive: true, force: true });
        logger.info('Session directory cleaned up');
      } catch (error: unknown) {
        logger.error('Failed to clean up session directory', error instanceof Error ? error : null);
      }
    }
  } catch (error: unknown) {
    logger.error('Failed to clean up project', error instanceof Error ? error : null);
  }
}

/**
 * SSE Stream Writer - Adapts SDK/CLI output to Server-Sent Events
 */
class SSEStreamWriter implements WriterInterface {
  res: Response;
  sessionId: string | null;
  isSSEStreamWriter: boolean;

  constructor(res: Response) {
    this.res = res;
    this.sessionId = null;
    this.isSSEStreamWriter = true;
  }

  send(data: unknown): void {
    if (this.res.writableEnded) {
      return;
    }
    this.res.write(`data: ${JSON.stringify(data)}\n\n`);
  }

  end(): void {
    if (!this.res.writableEnded) {
      this.res.write('data: {"type":"done"}\n\n');
      this.res.end();
    }
  }

  setSessionId(sessionId: string): void {
    this.sessionId = sessionId;
  }

  getSessionId(): string | null {
    return this.sessionId;
  }
}

/**
 * Non-streaming response collector
 */
class ResponseCollector implements WriterInterface {
  messages: unknown[];
  sessionId: string | null;

  constructor() {
    this.messages = [];
    this.sessionId = null;
  }

  send(data: unknown): void {
    this.messages.push(data);

    if (typeof data === 'string') {
      try {
        const parsed = JSON.parse(data) as StreamMessageData;
        if (parsed.sessionId) {
          this.sessionId = parsed.sessionId as string;
        }
      } catch (_e: unknown) {
        // Not JSON, ignore
      }
    } else if (data && (data as StreamMessageData).sessionId) {
      this.sessionId = (data as StreamMessageData).sessionId as string;
    }
  }

  end(): void {
    // Do nothing - we'll collect all messages
  }

  setSessionId(sessionId: string): void {
    this.sessionId = sessionId;
  }

  getSessionId(): string | null {
    return this.sessionId;
  }

  getMessages(): unknown[] {
    return this.messages;
  }

  getAssistantMessages(): unknown[] {
    const assistantMessages: unknown[] = [];

    for (const msg of this.messages) {
      if (msg && (msg as StreamMessageData).type === 'status') {
        continue;
      }

      if (typeof msg === 'string') {
        try {
          const parsed = JSON.parse(msg) as StreamMessageData;
          if (parsed.type === 'claude-response' && parsed.data && parsed.data.type === 'assistant') {
            assistantMessages.push(parsed.data);
          }
        } catch (_e: unknown) {
          // Not JSON, skip
        }
      }
    }

    return assistantMessages;
  }

  getTotalTokens(): { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheCreationTokens: number; totalTokens: number } {
    let totalInput = 0;
    let totalOutput = 0;
    let totalCacheRead = 0;
    let totalCacheCreation = 0;

    for (const msg of this.messages) {
      let data: StreamMessageData | undefined;

      if (typeof msg === 'string') {
        try {
          data = JSON.parse(msg) as StreamMessageData;
        } catch (_e: unknown) {
          continue;
        }
      } else {
        data = msg as StreamMessageData;
      }

      if (data && data.type === 'claude-response' && data.data) {
        const msgData = data.data;
        if (msgData.message && msgData.message.usage) {
          const usage = msgData.message.usage;
          totalInput += usage.input_tokens || 0;
          totalOutput += usage.output_tokens || 0;
          totalCacheRead += usage.cache_read_input_tokens || 0;
          totalCacheCreation += usage.cache_creation_input_tokens || 0;
        }
      }
    }

    return {
      inputTokens: totalInput,
      outputTokens: totalOutput,
      cacheReadTokens: totalCacheRead,
      cacheCreationTokens: totalCacheCreation,
      totalTokens: totalInput + totalOutput + totalCacheRead + totalCacheCreation
    };
  }
}

// ===============================
// External API Endpoint
// ===============================

router.post('/', validateExternalApiKey, async (req: Request, res: Response): Promise<void> => {
  const { githubUrl, projectPath, message, provider = 'claude', model, githubToken, branchName } = req.body;

  const ALLOWED_PERMISSION_MODES: string[] = ['default', 'plan'];
  const requestedMode: string = req.body.permissionMode || 'default';

  if (!ALLOWED_PERMISSION_MODES.includes(requestedMode)) {
    res.status(400).json({ error: `Invalid permission mode. Allowed: ${ALLOWED_PERMISSION_MODES.join(', ')}` });
    return;
  }

  const permissionMode: string = process.env.AGENT_BYPASS_PERMISSIONS === 'true' ? 'bypassPermissions' : requestedMode;
  if (permissionMode === 'bypassPermissions') {
    logger.warn(`[SECURITY] Agent API running with bypassPermissions mode (server-configured)`);
  }

  const stream: boolean = req.body.stream === undefined ? true : (req.body.stream === true || req.body.stream === 'true');
  const cleanup: boolean = req.body.cleanup === undefined ? true : (req.body.cleanup === true || req.body.cleanup === 'true');

  const createBranch: boolean = branchName ? true : (req.body.createBranch === true || req.body.createBranch === 'true');
  const createPR: boolean = req.body.createPR === true || req.body.createPR === 'true';

  if (!githubUrl && !projectPath) {
    res.status(400).json({ error: 'Either githubUrl or projectPath is required' });
    return;
  }

  if (!message || !message.trim()) {
    res.status(400).json({ error: 'message is required' });
    return;
  }

  if (!['claude', 'cursor', 'codex', 'gemini'].includes(provider)) {
    res.status(400).json({ error: 'provider must be "claude", "cursor", "codex", or "gemini"' });
    return;
  }

  if ((createBranch || createPR) && !githubUrl && !projectPath) {
    res.status(400).json({ error: 'createBranch and createPR require either githubUrl or projectPath with a GitHub remote' });
    return;
  }

  let finalProjectPath: string | null = null;
  let writer: SSEStreamWriter | ResponseCollector | null = null;

  try {
    if (githubUrl) {
      const tokenToUse: string | null = githubToken || githubTokensDb.getActiveGithubToken((req as AuthRequest).user!.id);

      let targetPath: string;
      if (projectPath) {
        targetPath = projectPath;
      } else {
        const repoHash = crypto.createHash('md5').update(githubUrl + Date.now()).digest('hex');
        targetPath = path.join(os.homedir(), '.claude', 'external-projects', repoHash);
      }

      finalProjectPath = await cloneGitHubRepo(githubUrl.trim(), tokenToUse, targetPath);
    } else {
      finalProjectPath = path.resolve(projectPath);

      const pathValidation: { valid: boolean; resolvedPath?: string; error?: string } = await validateWorkspacePath(finalProjectPath);
      if (!pathValidation.valid) {
        throw new Error(`Invalid project path: ${pathValidation.error}`);
      }
      finalProjectPath = pathValidation.resolvedPath!;

      try {
        await fs.access(finalProjectPath);
      } catch (error: unknown) {
        throw new Error(`Project path does not exist: ${finalProjectPath}`);
      }
    }

    let project: { path: string; [key: string]: unknown };
    try {
      project = await addProjectManually(finalProjectPath);
      logger.info('Project registered:', { project });
    } catch (error: unknown) {
      if (error instanceof Error && error.message?.includes('Project already configured')) {
        logger.info('Using existing project registration for:', { path: finalProjectPath });
        project = { path: finalProjectPath };
      } else {
        throw error;
      }
    }

    if (stream) {
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      res.setHeader('X-Accel-Buffering', 'no');

      writer = new SSEStreamWriter(res);

      writer.send({
        type: 'status',
        message: githubUrl ? 'Repository cloned and session started' : 'Session started',
        projectPath: finalProjectPath
      });
    } else {
      writer = new ResponseCollector();

      writer.send({
        type: 'status',
        message: githubUrl ? 'Repository cloned and session started' : 'Session started',
        projectPath: finalProjectPath
      });
    }

    if (provider === 'claude') {
      logger.info('Starting Claude SDK session');

      await queryClaudeSDK(message.trim(), {
        projectPath: finalProjectPath,
        cwd: finalProjectPath,
        sessionId: null,
        model: model,
        permissionMode: permissionMode
      }, writer);

    } else if (provider === 'cursor') {
      logger.info('Starting Cursor CLI session');

      await spawnCursor(message.trim(), {
        projectPath: finalProjectPath,
        cwd: finalProjectPath,
        sessionId: null,
        model: model || undefined,
        skipPermissions: true
      }, writer);
    } else if (provider === 'codex') {
      logger.info('Starting Codex SDK session');

      await queryCodex(message.trim(), {
        projectPath: finalProjectPath,
        cwd: finalProjectPath,
        sessionId: null,
        model: model || CODEX_MODELS.DEFAULT,
        permissionMode: permissionMode
      }, writer);
    } else if (provider === 'gemini') {
      logger.info('Starting Gemini CLI session');

      await spawnGemini(message.trim(), {
        projectPath: finalProjectPath,
        cwd: finalProjectPath,
        sessionId: null,
        model: model,
        skipPermissions: true
      }, writer);
    }

    let branchInfo: BranchInfo | { error: string } | null = null;
    let prInfo: PRInfo | { error: string } | null = null;

    if (createBranch || createPR) {
      try {
        logger.info('Starting GitHub branch/PR creation workflow...');

        const tokenToUse: string | null = githubToken || githubTokensDb.getActiveGithubToken((req as AuthRequest).user!.id);

        if (!tokenToUse) {
          throw new Error('GitHub token required for branch/PR creation. Please configure a GitHub token in settings.');
        }

        const octokit = new Octokit({ auth: tokenToUse });

        let repoUrl: string | undefined = githubUrl;
        if (!repoUrl) {
          logger.info('Getting GitHub URL from git remote...');
          try {
            repoUrl = await getGitRemoteUrl(finalProjectPath);
            if (!repoUrl.includes('github.com')) {
              throw new Error('Project does not have a GitHub remote configured');
            }
            logger.info(`Found GitHub remote: ${repoUrl}`);
          } catch (error: unknown) {
            throw new Error(`Failed to get GitHub remote URL: ${(error as Error).message}`);
          }
        }

        const { owner, repo } = parseGitHubUrl(repoUrl);
        logger.info(`Repository: ${owner}/${repo}`);

        const finalBranchName: string = branchName || autogenerateBranchName(message);
        if (branchName) {
          logger.info(`Using provided branch name: ${finalBranchName}`);

          const validation = validateBranchName(finalBranchName);
          if (!validation.valid) {
            throw new Error(`Invalid branch name: ${validation.error}`);
          }
        } else {
          logger.info(`Auto-generated branch name: ${finalBranchName}`);
        }

        if (createBranch) {
          logger.info('Creating local branch...');
          const checkoutProcess: ChildProcess = spawn('git', ['checkout', '-b', finalBranchName], {
            cwd: finalProjectPath,
            stdio: 'pipe'
          });

          await new Promise<void>((resolve, reject) => {
            let stderr = '';
            checkoutProcess.stderr!.on('data', (data: Buffer) => { stderr += data.toString(); });
            checkoutProcess.on('close', (code: number | null) => {
              if (code === 0) {
                logger.info(`Created and checked out local branch '${finalBranchName}'`);
                resolve();
              } else {
                if (stderr.includes('already exists')) {
                  logger.info(`Branch '${finalBranchName}' already exists locally, checking out...`);
                  const checkoutExisting: ChildProcess = spawn('git', ['checkout', finalBranchName], {
                    cwd: finalProjectPath!,
                    stdio: 'pipe'
                  });
                  checkoutExisting.on('close', (checkoutCode: number | null) => {
                    if (checkoutCode === 0) {
                      logger.info(`Checked out existing branch '${finalBranchName}'`);
                      resolve();
                    } else {
                      reject(new Error(`Failed to checkout existing branch: ${stderr}`));
                    }
                  });
                } else {
                  reject(new Error(`Failed to create branch: ${stderr}`));
                }
              }
            });
          });

          logger.info('Pushing branch to remote...');
          const pushProcess: ChildProcess = spawn('git', ['push', '-u', 'origin', finalBranchName], {
            cwd: finalProjectPath,
            stdio: 'pipe'
          });

          await new Promise<void>((resolve, reject) => {
            let stderr = '';
            let stdout = '';
            pushProcess.stdout!.on('data', (data: Buffer) => { stdout += data.toString(); });
            pushProcess.stderr!.on('data', (data: Buffer) => { stderr += data.toString(); });
            pushProcess.on('close', (code: number | null) => {
              if (code === 0) {
                logger.info(`Pushed branch '${finalBranchName}' to remote`);
                resolve();
              } else {
                if (stderr.includes('already exists') || stderr.includes('up-to-date')) {
                  logger.info(`Branch '${finalBranchName}' already exists on remote, using existing branch`);
                  resolve();
                } else {
                  reject(new Error(`Failed to push branch: ${stderr}`));
                }
              }
            });
          });

          branchInfo = {
            name: finalBranchName,
            url: `https://github.com/${owner}/${repo}/tree/${finalBranchName}`
          };
        }

        if (createPR) {
          logger.info('Generating PR title and description...');
          const commitMessages: string[] = await getCommitMessages(finalProjectPath, 5);

          const prTitle: string = commitMessages.length > 0 ? commitMessages[0] : message;

          let prBody = '## Changes\n\n';
          if (commitMessages.length > 0) {
            prBody += commitMessages.map((msg: string) => `- ${msg}`).join('\n');
          } else {
            prBody += `Agent task: ${message}`;
          }
          prBody += '\n\n---\n*This pull request was automatically created by Claude Code UI Agent.*';

          logger.info(`PR Title: ${prTitle}`);

          logger.info('Creating pull request...');
          prInfo = await createGitHubPR(octokit, owner, repo, finalBranchName, prTitle, prBody, 'main');
        }

        if (stream) {
          if (branchInfo) {
            writer!.send({
              type: 'github-branch',
              branch: branchInfo
            });
          }
          if (prInfo) {
            writer!.send({
              type: 'github-pr',
              pullRequest: prInfo
            });
          }
        }

      } catch (error: unknown) {
        logger.error('GitHub branch/PR creation error', error instanceof Error ? error : null);
        const errMsg = error instanceof Error ? error.message : String(error);

        if (stream) {
          writer!.send({
            type: 'github-error',
            error: errMsg
          });
        }
        if (!stream) {
          branchInfo = { error: errMsg };
          prInfo = { error: errMsg };
        }
      }
    }

    if (stream) {
      (writer as SSEStreamWriter).end();
    } else {
      const collector = writer as ResponseCollector;
      const assistantMessages = collector.getAssistantMessages();
      const tokenSummary = collector.getTotalTokens();

      const response: Record<string, unknown> = {
        success: true,
        sessionId: collector.getSessionId(),
        messages: assistantMessages,
        tokens: tokenSummary,
        projectPath: finalProjectPath
      };

      if (branchInfo) {
        response.branch = branchInfo;
      }
      if (prInfo) {
        response.pullRequest = prInfo;
      }

      res.json(response);
    }

    if (cleanup && githubUrl) {
      const sessionIdForCleanup: string | null = writer!.getSessionId();
      setTimeout(() => {
        cleanupProject(finalProjectPath!, sessionIdForCleanup);
      }, 5000);
    }

  } catch (error: unknown) {
    logger.error('External session error', error instanceof Error ? error : null);
    const errMsg = error instanceof Error ? error.message : String(error);

    if (finalProjectPath && cleanup && githubUrl) {
      const sessionIdForCleanup: string | null = writer ? writer.getSessionId() : null;
      cleanupProject(finalProjectPath, sessionIdForCleanup);
    }

    if (stream) {
      if (!writer) {
        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');
        res.setHeader('X-Accel-Buffering', 'no');
        writer = new SSEStreamWriter(res);
      }

      if (!res.writableEnded) {
        writer.send({
          type: 'error',
          error: errMsg,
          message: `Failed: ${errMsg}`
        });
        (writer as SSEStreamWriter).end();
      }
    } else if (!res.headersSent) {
      res.status(500).json({
        success: false,
        error: errMsg
      });
    }
  }
});

export default router;
