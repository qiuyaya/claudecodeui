/**
 * Claude SDK Integration
 *
 * This module provides SDK-based integration with Claude using the @anthropic-ai/claude-agent-sdk.
 * It mirrors the interface of claude-cli.js but uses the SDK internally for better performance
 * and maintainability.
 *
 * Key features:
 * - Direct SDK integration without child processes
 * - Session management with abort capability
 * - Options mapping between CLI and SDK formats
 * - WebSocket message streaming
 */

import { query } from '@anthropic-ai/claude-agent-sdk';
import crypto from 'crypto';
import { promises as fs } from 'fs';
import path from 'path';
import os from 'os';
import { CLAUDE_MODELS } from '../shared/modelConstants.js';

interface WsWriter {
  send: (data: Record<string, unknown>) => void;
  setSessionId?: (id: string) => void;
  getSessionId?: () => string | null;
  isSSEStreamWriter?: boolean;
  isWebSocketWriter?: boolean;
  updateWebSocket?: (ws: unknown) => void;
}

interface SdkMessage {
  type: string;
  session_id?: string;
  parent_tool_use_id?: string;
  modelUsage?: Record<string, ModelUsageData>;
  [key: string]: unknown;
}

interface ModelUsageData {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadInputTokens?: number;
  cacheCreationInputTokens?: number;
  cumulativeInputTokens?: number;
  cumulativeOutputTokens?: number;
  cumulativeCacheReadInputTokens?: number;
  cumulativeCacheCreationInputTokens?: number;
  [key: string]: unknown;
}

interface ClaudeConfig {
  mcpServers?: Record<string, unknown>;
  claudeProjects?: Record<string, { mcpServers?: Record<string, unknown>; [key: string]: unknown }>;
  [key: string]: unknown;
}

interface ToolInput {
  command?: string;
  [key: string]: unknown;
}

interface ToolContext {
  signal?: AbortSignal;
  [key: string]: unknown;
}

interface ToolsSettings {
  allowedTools?: string[];
  disallowedTools?: string[];
  skipPermissions?: boolean;
}

interface QueryOptions {
  sessionId?: string;
  cwd?: string;
  toolsSettings?: ToolsSettings;
  permissionMode?: string;
  images?: ImageData[];
  model?: string;
  [key: string]: unknown;
}

interface ImageData {
  data: string;
  [key: string]: unknown;
}

interface SdkOptions {
  cwd?: string;
  permissionMode?: string;
  allowedTools?: string[];
  disallowedTools?: string[];
  tools?: { type: string; preset: string };
  model?: string;
  systemPrompt?: { type: string; preset: string };
  settingSources?: string[];
  resume?: string;
  mcpServers?: Record<string, unknown>;
  canUseTool?: (toolName: string, input: ToolInput | string, context: ToolContext) => Promise<ToolDecisionResult>;
  [key: string]: unknown;
}

interface ToolDecisionResult {
  behavior: 'allow' | 'deny';
  updatedInput?: ToolInput | string;
  message?: string;
}

interface ToolApprovalDecision {
  allow?: boolean;
  cancelled?: boolean;
  message?: string;
  rememberEntry?: string;
  updatedInput?: ToolInput | string;
}

interface WaitForApprovalOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
  onCancel?: (reason: string) => void;
  metadata?: Record<string, unknown>;
}

interface SessionData {
  instance: AsyncIterable<SdkMessage> & { interrupt?: () => Promise<void> };
  startTime: number;
  status: string;
  tempImagePaths: string[];
  tempDir: string | null;
  writer: WsWriter | null;
}

interface TokenBudget {
  used: number;
  total: number;
}

interface PendingApproval {
  requestId: string;
  toolName: string;
  input: ToolInput | string;
  context: ToolContext;
  sessionId: string;
  receivedAt: Date;
}

interface ToolApprovalResolver {
  (decision: ToolApprovalDecision | null): void;
  _sessionId?: string | null;
  _toolName?: string;
  _input?: ToolInput | string;
  _context?: ToolContext;
  _receivedAt?: Date;
}

const activeSessions: Map<string, SessionData> = new Map();
const pendingToolApprovals: Map<string, ToolApprovalResolver> = new Map();

const TOOL_APPROVAL_TIMEOUT_MS: number = parseInt(process.env.CLAUDE_TOOL_APPROVAL_TIMEOUT_MS as string, 10) || 55000;

const TOOLS_REQUIRING_INTERACTION: Set<string> = new Set(['AskUserQuestion']);

function createRequestId(): string {
  if (typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return crypto.randomBytes(16).toString('hex');
}

function waitForToolApproval(requestId: string, options: WaitForApprovalOptions = {}): Promise<ToolApprovalDecision | null> {
  const { timeoutMs = TOOL_APPROVAL_TIMEOUT_MS, signal, onCancel, metadata } = options;

  return new Promise<ToolApprovalDecision | null>(resolve => {
    let settled = false;

    const finalize = (decision: ToolApprovalDecision | null): void => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(decision);
    };

    let timeout: ReturnType<typeof setTimeout> | undefined;

    const cleanup = (): void => {
      pendingToolApprovals.delete(requestId);
      if (timeout) clearTimeout(timeout);
      if (signal && abortHandler) {
        signal.removeEventListener('abort', abortHandler);
      }
    };

    // timeoutMs 0 = wait indefinitely (interactive tools)
    if (timeoutMs > 0) {
      timeout = setTimeout(() => {
        onCancel?.('timeout');
        finalize(null);
      }, timeoutMs);
    }

    const abortHandler = (): void => {
      onCancel?.('cancelled');
      finalize({ cancelled: true });
    };

    if (signal) {
      if (signal.aborted) {
        onCancel?.('cancelled');
        finalize({ cancelled: true });
        return;
      }
      signal.addEventListener('abort', abortHandler, { once: true });
    }

    const resolver: ToolApprovalResolver = (decision: ToolApprovalDecision | null): void => {
      finalize(decision);
    };
    // Attach metadata for getPendingApprovalsForSession lookup
    if (metadata) {
      Object.assign(resolver, metadata);
    }
    pendingToolApprovals.set(requestId, resolver);
  });
}

function resolveToolApproval(requestId: string, decision: ToolApprovalDecision): void {
  const resolver = pendingToolApprovals.get(requestId);
  if (resolver) {
    resolver(decision);
  }
}

// Match stored permission entries against a tool + input combo.
// This only supports exact tool names and the Bash(command:*) shorthand
// used by the UI; it intentionally does not implement full glob semantics,
// introduced to stay consistent with the UI's "Allow rule" format.
function matchesToolPermission(entry: string, toolName: string, input: ToolInput | string): boolean {
  if (!entry || !toolName) {
    return false;
  }

  if (entry === toolName) {
    return true;
  }

  const bashMatch = entry.match(/^Bash\((.+):\*\)$/);
  if (toolName === 'Bash' && bashMatch) {
    const allowedPrefix: string = bashMatch[1];
    let command = '';

    if (typeof input === 'string') {
      command = input.trim();
    } else if (input && typeof input === 'object' && typeof input.command === 'string') {
      command = input.command.trim();
    }

    if (!command) {
      return false;
    }

    return command.startsWith(allowedPrefix);
  }

  return false;
}

/**
 * Maps CLI options to SDK-compatible options format
 */
function mapCliOptionsToSDK(options: QueryOptions = {}): SdkOptions {
  const { sessionId, cwd, toolsSettings, permissionMode, images } = options;

  const sdkOptions: SdkOptions = {};

  // Map working directory
  if (cwd) {
    sdkOptions.cwd = cwd;
  }

  // Map permission mode
  if (permissionMode && permissionMode !== 'default') {
    sdkOptions.permissionMode = permissionMode;
  }

  // Map tool settings
  const settings: ToolsSettings = toolsSettings || {
    allowedTools: [],
    disallowedTools: [],
    skipPermissions: false
  };

  // Handle tool permissions
  if (settings.skipPermissions && permissionMode !== 'plan') {
    // When skipping permissions, use bypassPermissions mode
    sdkOptions.permissionMode = 'bypassPermissions';
  }

  let allowedTools: string[] = [...(settings.allowedTools || [])];

  // Add plan mode default tools
  if (permissionMode === 'plan') {
    const planModeTools: string[] = ['Read', 'Task', 'exit_plan_mode', 'TodoRead', 'TodoWrite', 'WebFetch', 'WebSearch'];
    for (const tool of planModeTools) {
      if (!allowedTools.includes(tool)) {
        allowedTools.push(tool);
      }
    }
  }

  sdkOptions.allowedTools = allowedTools;

  // Use the tools preset to make all default built-in tools available (including AskUserQuestion).
  // This was introduced in SDK 0.1.57. Omitting this preserves existing behavior (all tools available),
  // but being explicit ensures forward compatibility and clarity.
  sdkOptions.tools = { type: 'preset', preset: 'claude_code' };

  sdkOptions.disallowedTools = settings.disallowedTools || [];

  // Map model (default to sonnet)
  // Valid models: sonnet, opus, haiku, opusplan, sonnet[1m]
  sdkOptions.model = options.model || CLAUDE_MODELS.DEFAULT;
  console.log(`Using model: ${sdkOptions.model}`);

  // Map system prompt configuration
  sdkOptions.systemPrompt = {
    type: 'preset',
    preset: 'claude_code'  // Required to use CLAUDE.md
  };

  // Map setting sources for CLAUDE.md loading
  // This loads CLAUDE.md from project, user (~/.config/claude/CLAUDE.md), and local directories
  sdkOptions.settingSources = ['project', 'user', 'local'];

  // Map resume session
  if (sessionId) {
    sdkOptions.resume = sessionId;
  }

  return sdkOptions;
}

/**
 * Adds a session to the active sessions map
 */
function addSession(sessionId: string, queryInstance: SessionData['instance'], tempImagePaths: string[] = [], tempDir: string | null = null, writer: WsWriter | null = null): void {
  activeSessions.set(sessionId, {
    instance: queryInstance,
    startTime: Date.now(),
    status: 'active',
    tempImagePaths,
    tempDir,
    writer
  });
}

/**
 * Removes a session from the active sessions map
 */
function removeSession(sessionId: string): void {
  activeSessions.delete(sessionId);
}

/**
 * Gets a session from the active sessions map
 */
function getSession(sessionId: string): SessionData | undefined {
  return activeSessions.get(sessionId);
}

/**
 * Gets all active session IDs
 */
function getAllSessions(): string[] {
  return Array.from(activeSessions.keys());
}

/**
 * Transforms SDK messages to WebSocket format expected by frontend
 */
function transformMessage(sdkMessage: SdkMessage): SdkMessage & { parentToolUseId?: string } {
  // Extract parent_tool_use_id for subagent tool grouping
  if (sdkMessage.parent_tool_use_id) {
    return {
      ...sdkMessage,
      parentToolUseId: sdkMessage.parent_tool_use_id
    };
  }
  return sdkMessage;
}

/**
 * Extracts token usage from SDK result messages
 */
function extractTokenBudget(resultMessage: SdkMessage): TokenBudget | null {
  if (resultMessage.type !== 'result' || !resultMessage.modelUsage) {
    return null;
  }

  // Get the first model's usage data
  const modelKey: string = Object.keys(resultMessage.modelUsage)[0];
  const modelData: ModelUsageData | undefined = resultMessage.modelUsage![modelKey];

  if (!modelData) {
    return null;
  }

  // Use cumulative tokens if available (tracks total for the session)
  // Otherwise fall back to per-request tokens
  const inputTokens: number = modelData.cumulativeInputTokens || modelData.inputTokens || 0;
  const outputTokens: number = modelData.cumulativeOutputTokens || modelData.outputTokens || 0;
  const cacheReadTokens: number = modelData.cumulativeCacheReadInputTokens || modelData.cacheReadInputTokens || 0;
  const cacheCreationTokens: number = modelData.cumulativeCacheCreationInputTokens || modelData.cacheCreationInputTokens || 0;

  // Total used = input + output + cache tokens
  const totalUsed: number = inputTokens + outputTokens + cacheReadTokens + cacheCreationTokens;

  // Use configured context window budget from environment (default 160000)
  // This is the user's budget limit, not the model's context window
  const contextWindow: number = parseInt(process.env.CONTEXT_WINDOW as string) || 160000;

  console.log(`Token calculation: input=${inputTokens}, output=${outputTokens}, cache=${cacheReadTokens + cacheCreationTokens}, total=${totalUsed}/${contextWindow}`);

  return {
    used: totalUsed,
    total: contextWindow
  };
}

/**
 * Handles image processing for SDK queries
 * Saves base64 images to temporary files and returns modified prompt with file paths
 */
async function handleImages(command: string, images: ImageData[] | undefined, cwd: string | undefined): Promise<{ modifiedCommand: string; tempImagePaths: string[]; tempDir: string | null }> {
  const tempImagePaths: string[] = [];
  let tempDir: string | null = null;

  if (!images || images.length === 0) {
    return { modifiedCommand: command, tempImagePaths, tempDir };
  }

  try {
    // Create temp directory in the project directory
    const workingDir: string = cwd || process.cwd();
    tempDir = path.join(workingDir, '.tmp', 'images', Date.now().toString());
    await fs.mkdir(tempDir, { recursive: true });

    // Save each image to a temp file
    for (const [index, image] of images.entries()) {
      // Extract base64 data and mime type
      const matches: RegExpMatchArray | null = image.data.match(/^data:([^;]+);base64,(.+)$/);
      if (!matches) {
        console.error('Invalid image data format');
        continue;
      }

      const [, mimeType, base64Data] = matches;
      const extension: string = mimeType.split('/')[1] || 'png';
      const filename: string = `image_${index}.${extension}`;
      const filepath: string = path.join(tempDir, filename);

      // Write base64 data to file
      await fs.writeFile(filepath, Buffer.from(base64Data, 'base64'));
      tempImagePaths.push(filepath);
    }

    // Include the full image paths in the prompt
    let modifiedCommand: string = command;
    if (tempImagePaths.length > 0 && command && command.trim()) {
      const imageNote: string = `\n\n[Images provided at the following paths:]\n${tempImagePaths.map((p, i) => `${i + 1}. ${p}`).join('\n')}`;
      modifiedCommand = command + imageNote;
    }

    console.log(`Processed ${tempImagePaths.length} images to temp directory: ${tempDir}`);
    return { modifiedCommand, tempImagePaths, tempDir };
  } catch (error) {
    console.error('Error processing images for SDK:', error);
    return { modifiedCommand: command, tempImagePaths, tempDir };
  }
}

/**
 * Cleans up temporary image files
 */
async function cleanupTempFiles(tempImagePaths: string[], tempDir: string | null): Promise<void> {
  if (!tempImagePaths || tempImagePaths.length === 0) {
    return;
  }

  try {
    // Delete individual temp files
    for (const imagePath of tempImagePaths) {
      await fs.unlink(imagePath).catch((err: Error) =>
        console.error(`Failed to delete temp image ${imagePath}:`, err)
      );
    }

    // Delete temp directory
    if (tempDir) {
      await fs.rm(tempDir, { recursive: true, force: true }).catch((err: Error) =>
        console.error(`Failed to delete temp directory ${tempDir}:`, err)
      );
    }

    console.log(`Cleaned up ${tempImagePaths.length} temp image files`);
  } catch (error) {
    console.error('Error during temp file cleanup:', error);
  }
}

/**
 * Loads MCP server configurations from ~/.claude.json
 */
async function loadMcpConfig(cwd: string | undefined): Promise<Record<string, unknown> | null> {
  try {
    const claudeConfigPath: string = path.join(os.homedir(), '.claude.json');

    // Check if config file exists
    try {
      await fs.access(claudeConfigPath);
    } catch (error) {
      // File doesn't exist, return null
      console.log('No ~/.claude.json found, proceeding without MCP servers');
      return null;
    }

    // Read and parse config file
    let claudeConfig: ClaudeConfig;
    try {
      const configContent: string = await fs.readFile(claudeConfigPath, 'utf8');
      claudeConfig = JSON.parse(configContent);
    } catch (error) {
      console.error('Failed to parse ~/.claude.json:', (error as Error).message);
      return null;
    }

    // Extract MCP servers (merge global and project-specific)
    let mcpServers: Record<string, unknown> = {};

    // Add global MCP servers
    if (claudeConfig.mcpServers && typeof claudeConfig.mcpServers === 'object') {
      mcpServers = { ...claudeConfig.mcpServers };
      console.log(`Loaded ${Object.keys(mcpServers).length} global MCP servers`);
    }

    // Add/override with project-specific MCP servers
    if (claudeConfig.claudeProjects && cwd) {
      const projectConfig = claudeConfig.claudeProjects[cwd];
      if (projectConfig && projectConfig.mcpServers && typeof projectConfig.mcpServers === 'object') {
        mcpServers = { ...mcpServers, ...projectConfig.mcpServers };
        console.log(`Loaded ${Object.keys(projectConfig.mcpServers).length} project-specific MCP servers`);
      }
    }

    // Return null if no servers found
    if (Object.keys(mcpServers).length === 0) {
      console.log('No MCP servers configured');
      return null;
    }

    console.log(`Total MCP servers loaded: ${Object.keys(mcpServers).length}`);
    return mcpServers;
  } catch (error) {
    console.error('Error loading MCP config:', (error as Error).message);
    return null;
  }
}

/**
 * Executes a Claude query using the SDK
 */
async function queryClaudeSDK(command: string, options: QueryOptions = {}, ws: WsWriter): Promise<void> {
  const { sessionId } = options;
  let capturedSessionId: string | undefined = sessionId;
  let sessionCreatedSent = false;
  let tempImagePaths: string[] = [];
  let tempDir: string | null = null;

  try {
    // Map CLI options to SDK format
    const sdkOptions: SdkOptions = mapCliOptionsToSDK(options);

    // Load MCP configuration
    const mcpServers: Record<string, unknown> | null = await loadMcpConfig(options.cwd);
    if (mcpServers) {
      sdkOptions.mcpServers = mcpServers;
    }

    // Handle images - save to temp files and modify prompt
    const imageResult = await handleImages(command, options.images, options.cwd);
    const finalCommand: string = imageResult.modifiedCommand;
    tempImagePaths = imageResult.tempImagePaths;
    tempDir = imageResult.tempDir;

    sdkOptions.canUseTool = async (toolName: string, input: ToolInput | string, context: ToolContext): Promise<ToolDecisionResult> => {
      const requiresInteraction: boolean = TOOLS_REQUIRING_INTERACTION.has(toolName);

      if (!requiresInteraction) {
        if (sdkOptions.permissionMode === 'bypassPermissions') {
          return { behavior: 'allow', updatedInput: input };
        }

        const isDisallowed: boolean = (sdkOptions.disallowedTools || []).some((entry: string) =>
          matchesToolPermission(entry, toolName, input)
        );
        if (isDisallowed) {
          return { behavior: 'deny', message: 'Tool disallowed by settings' };
        }

        const isAllowed: boolean = (sdkOptions.allowedTools || []).some((entry: string) =>
          matchesToolPermission(entry, toolName, input)
        );
        if (isAllowed) {
          return { behavior: 'allow', updatedInput: input };
        }
      }

      const requestId: string = createRequestId();
      ws.send({
        type: 'claude-permission-request',
        requestId,
        toolName,
        input,
        sessionId: capturedSessionId || sessionId || null
      });

      const decision: ToolApprovalDecision | null = await waitForToolApproval(requestId, {
        timeoutMs: requiresInteraction ? 0 : undefined,
        signal: context?.signal,
        metadata: {
          _sessionId: capturedSessionId || sessionId || null,
          _toolName: toolName,
          _input: input,
          _receivedAt: new Date(),
        },
        onCancel: (reason: string) => {
          ws.send({
            type: 'claude-permission-cancelled',
            requestId,
            reason,
            sessionId: capturedSessionId || sessionId || null
          });
        }
      });
      if (!decision) {
        return { behavior: 'deny', message: 'Permission request timed out' };
      }

      if (decision.cancelled) {
        return { behavior: 'deny', message: 'Permission request cancelled' };
      }

      if (decision.allow) {
        if (decision.rememberEntry && typeof decision.rememberEntry === 'string') {
          if (!sdkOptions.allowedTools) {
            sdkOptions.allowedTools = [];
          }
          if (!sdkOptions.allowedTools.includes(decision.rememberEntry)) {
            sdkOptions.allowedTools.push(decision.rememberEntry);
          }
          if (Array.isArray(sdkOptions.disallowedTools)) {
            sdkOptions.disallowedTools = sdkOptions.disallowedTools.filter((entry: string) => entry !== decision.rememberEntry);
          }
        }
        return { behavior: 'allow', updatedInput: decision.updatedInput ?? input };
      }

      return { behavior: 'deny', message: decision.message ?? 'User denied tool use' };
    };

    // Set stream-close timeout for interactive tools (Query constructor reads it synchronously). Claude Agent SDK has a default of 5s and this overrides it
    const prevStreamTimeout: string | undefined = process.env.CLAUDE_CODE_STREAM_CLOSE_TIMEOUT;
    process.env.CLAUDE_CODE_STREAM_CLOSE_TIMEOUT = '300000';

    const queryInstance = query({
      prompt: finalCommand,
      options: sdkOptions as Record<string, unknown>
    }) as unknown as SessionData['instance'];

    // Restore immediately — Query constructor already captured the value
    if (prevStreamTimeout !== undefined) {
      process.env.CLAUDE_CODE_STREAM_CLOSE_TIMEOUT = prevStreamTimeout;
    } else {
      delete process.env.CLAUDE_CODE_STREAM_CLOSE_TIMEOUT;
    }

    // Track the query instance for abort capability
    if (capturedSessionId) {
      addSession(capturedSessionId, queryInstance, tempImagePaths, tempDir, ws);
    }

    // Process streaming messages
    console.log('Starting async generator loop for session:', capturedSessionId || 'NEW');
    for await (const message of queryInstance) {
      // Capture session ID from first message
      if (message.session_id && !capturedSessionId) {

        capturedSessionId = message.session_id;
        addSession(capturedSessionId!, queryInstance, tempImagePaths, tempDir, ws);

        // Set session ID on writer
        if (ws.setSessionId && typeof ws.setSessionId === 'function') {
          ws.setSessionId(capturedSessionId!);
        }

        // Send session-created event only once for new sessions
        if (!sessionId && !sessionCreatedSent) {
          sessionCreatedSent = true;
          ws.send({
            type: 'session-created',
            sessionId: capturedSessionId
          });
        } else {
          console.log('Not sending session-created. sessionId:', sessionId, 'sessionCreatedSent:', sessionCreatedSent);
        }
      } else {
        console.log('No session_id in message or already captured. message.session_id:', message.session_id, 'capturedSessionId:', capturedSessionId);
      }

      // Transform and send message to WebSocket
      const transformedMessage = transformMessage(message);
      ws.send({
        type: 'claude-response',
        data: transformedMessage,
        sessionId: capturedSessionId || sessionId || null
      });

      // Extract and send token budget updates from result messages
      if (message.type === 'result') {
        const models: string[] = Object.keys(message.modelUsage || {});
        if (models.length > 0) {
          console.log("---> Model was sent using:", models);
        }
        const tokenBudget: TokenBudget | null = extractTokenBudget(message);
        if (tokenBudget) {
          console.log('Token budget from modelUsage:', tokenBudget);
          ws.send({
            type: 'token-budget',
            data: tokenBudget,
            sessionId: capturedSessionId || sessionId || null
          });
        }
      }
    }

    // Clean up session on completion
    if (capturedSessionId) {
      removeSession(capturedSessionId);
    }

    // Clean up temporary image files
    await cleanupTempFiles(tempImagePaths, tempDir);

    // Send completion event
    console.log('Streaming complete, sending claude-complete event');
    ws.send({
      type: 'claude-complete',
      sessionId: capturedSessionId,
      exitCode: 0,
      isNewSession: !sessionId && !!command
    });
    console.log('claude-complete event sent');

  } catch (error) {
    console.error('SDK query error:', error);

    // Clean up session on error
    if (capturedSessionId) {
      removeSession(capturedSessionId);
    }

    // Clean up temporary image files on error
    await cleanupTempFiles(tempImagePaths, tempDir);

    // Send error to WebSocket
    ws.send({
      type: 'claude-error',
      error: (error as Error).message,
      sessionId: capturedSessionId || sessionId || null
    });

    throw error;
  }
}

/**
 * Aborts an active SDK session
 */
async function abortClaudeSDKSession(sessionId: string): Promise<boolean> {
  const session: SessionData | undefined = getSession(sessionId);

  if (!session) {
    console.log(`Session ${sessionId} not found`);
    return false;
  }

  try {
    console.log(`Aborting SDK session: ${sessionId}`);

    // Call interrupt() on the query instance
    await session.instance.interrupt?.();

    // Update session status
    session.status = 'aborted';

    // Clean up temporary image files
    await cleanupTempFiles(session.tempImagePaths, session.tempDir);

    // Clean up session
    removeSession(sessionId);

    return true;
  } catch (error) {
    console.error(`Error aborting session ${sessionId}:`, error);
    return false;
  }
}

/**
 * Checks if an SDK session is currently active
 */
function isClaudeSDKSessionActive(sessionId: string): boolean {
  const session: SessionData | undefined = getSession(sessionId);
  return !!session && session.status === 'active';
}

/**
 * Gets all active SDK session IDs
 */
function getActiveClaudeSDKSessions(): string[] {
  return getAllSessions();
}

/**
 * Get pending tool approvals for a specific session.
 */
function getPendingApprovalsForSession(sessionId: string): PendingApproval[] {
  const pending: PendingApproval[] = [];
  for (const [requestId, resolver] of pendingToolApprovals.entries()) {
    if (resolver._sessionId === sessionId) {
      pending.push({
        requestId,
        toolName: resolver._toolName || 'UnknownTool',
        input: resolver._input,
        context: resolver._context,
        sessionId,
        receivedAt: resolver._receivedAt || new Date(),
      });
    }
  }
  return pending;
}

/**
 * Reconnect a session's WebSocketWriter to a new raw WebSocket.
 * Called when client reconnects (e.g. page refresh) while SDK is still running.
 */
function reconnectSessionWriter(sessionId: string, newRawWs: unknown): boolean {
  const session: SessionData | undefined = getSession(sessionId);
  if (!session?.writer?.updateWebSocket) return false;
  session.writer.updateWebSocket(newRawWs);
  console.log(`[RECONNECT] Writer swapped for session ${sessionId}`);
  return true;
}

// Export public API
export {
  queryClaudeSDK,
  abortClaudeSDKSession,
  isClaudeSDKSessionActive,
  getActiveClaudeSDKSessions,
  resolveToolApproval,
  getPendingApprovalsForSession,
  reconnectSessionWriter
};
