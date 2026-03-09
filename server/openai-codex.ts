/**
 * OpenAI Codex SDK Integration
 * =============================
 *
 * This module provides integration with the OpenAI Codex SDK for non-interactive
 * chat sessions. It mirrors the pattern used in claude-sdk.js for consistency.
 *
 * ## Usage
 *
 * - queryCodex(command, options, ws) - Execute a prompt with streaming via WebSocket
 * - abortCodexSession(sessionId) - Cancel an active session
 * - isCodexSessionActive(sessionId) - Check if a session is running
 * - getActiveCodexSessions() - List all active sessions
 */

import { Codex, Thread, type ThreadEvent, type ThreadItem } from '@openai/codex-sdk';

interface WsWriter {
  send: (data: Record<string, unknown> | string) => void;
  setSessionId?: (id: string) => void;
  getSessionId?: () => string | null;
  isSSEStreamWriter?: boolean;
  isWebSocketWriter?: boolean;
}

interface CodexQueryOptions {
  sessionId?: string;
  cwd?: string;
  projectPath?: string;
  model?: string;
  permissionMode?: string;
  [key: string]: unknown;
}

interface CodexSessionData {
  thread: Thread;
  codex: Codex;
  status: string;
  abortController: AbortController;
  startedAt: string;
}

interface CodexActiveSessionInfo {
  id: string;
  status: string;
  startedAt: string;
}

interface CodexEvent {
  type: string;
  item?: CodexItem;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    [key: string]: unknown;
  };
  error?: unknown;
  message?: string;
  id?: string;
  [key: string]: unknown;
}

interface CodexItem {
  type: string;
  text?: string;
  command?: string;
  aggregated_output?: string;
  exit_code?: number;
  status?: string;
  changes?: unknown;
  server?: string;
  tool?: string;
  arguments?: unknown;
  result?: unknown;
  error?: unknown;
  query?: string;
  items?: unknown[];
  message?: string;
  [key: string]: unknown;
}

interface TransformedCodexEvent {
  type: string;
  [key: string]: unknown;
}

// Track active sessions
const activeCodexSessions: Map<string, CodexSessionData> = new Map();

/**
 * Transform Codex SDK event to WebSocket message format
 */
function transformCodexEvent(event: CodexEvent): TransformedCodexEvent {
  // Map SDK event types to a consistent format
  switch (event.type) {
    case 'item.started':
    case 'item.updated':
    case 'item.completed': {
      const item: CodexItem | undefined = event.item;
      if (!item) {
        return { type: event.type, item: null };
      }

      // Transform based on item type
      switch (item.type) {
        case 'agent_message':
          return {
            type: 'item',
            itemType: 'agent_message',
            message: {
              role: 'assistant',
              content: item.text
            }
          };

        case 'reasoning':
          return {
            type: 'item',
            itemType: 'reasoning',
            message: {
              role: 'assistant',
              content: item.text,
              isReasoning: true
            }
          };

        case 'command_execution':
          return {
            type: 'item',
            itemType: 'command_execution',
            command: item.command,
            output: item.aggregated_output,
            exitCode: item.exit_code,
            status: item.status
          };

        case 'file_change':
          return {
            type: 'item',
            itemType: 'file_change',
            changes: item.changes,
            status: item.status
          };

        case 'mcp_tool_call':
          return {
            type: 'item',
            itemType: 'mcp_tool_call',
            server: item.server,
            tool: item.tool,
            arguments: item.arguments,
            result: item.result,
            error: item.error,
            status: item.status
          };

        case 'web_search':
          return {
            type: 'item',
            itemType: 'web_search',
            query: item.query
          };

        case 'todo_list':
          return {
            type: 'item',
            itemType: 'todo_list',
            items: item.items
          };

        case 'error':
          return {
            type: 'item',
            itemType: 'error',
            message: {
              role: 'error',
              content: item.message
            }
          };

        default:
          return {
            type: 'item',
            itemType: item.type,
            item: item
          };
      }
    }

    case 'turn.started':
      return {
        type: 'turn_started'
      };

    case 'turn.completed':
      return {
        type: 'turn_complete',
        usage: event.usage
      };

    case 'turn.failed':
      return {
        type: 'turn_failed',
        error: event.error
      };

    case 'thread.started':
      return {
        type: 'thread_started',
        threadId: event.id
      };

    case 'error':
      return {
        type: 'error',
        message: event.message
      };

    default:
      return {
        type: event.type,
        data: event
      };
  }
}

/**
 * Map permission mode to Codex SDK options
 */
function mapPermissionModeToCodexOptions(permissionMode: string): { sandboxMode: string; approvalPolicy: string } {
  switch (permissionMode) {
    case 'acceptEdits':
      return {
        sandboxMode: 'workspace-write',
        approvalPolicy: 'never'
      };
    case 'bypassPermissions':
      return {
        sandboxMode: 'danger-full-access',
        approvalPolicy: 'never'
      };
    case 'default':
    default:
      return {
        sandboxMode: 'workspace-write',
        approvalPolicy: 'untrusted'
      };
  }
}

/**
 * Execute a Codex query with streaming
 */
export async function queryCodex(command: string, options: CodexQueryOptions = {}, ws: WsWriter): Promise<void> {
  const {
    sessionId,
    cwd,
    projectPath,
    model,
    permissionMode = 'default'
  } = options;

  const workingDirectory: string = cwd || projectPath || process.cwd();
  const { sandboxMode, approvalPolicy } = mapPermissionModeToCodexOptions(permissionMode);

  let codex: Codex;
  let thread: Thread;
  let currentSessionId: string | undefined = sessionId;
  const abortController: AbortController = new AbortController();

  try {
    // Initialize Codex SDK
    codex = new Codex();

    // Thread options with sandbox and approval settings
    const threadOptions: Record<string, unknown> = {
      workingDirectory,
      skipGitRepoCheck: true,
      sandboxMode,
      approvalPolicy,
      model
    };

    // Start or resume thread
    if (sessionId) {
      thread = codex.resumeThread(sessionId, threadOptions);
    } else {
      thread = codex.startThread(threadOptions);
    }

    // Get the thread ID
    currentSessionId = thread.id || sessionId || `codex-${Date.now()}`;

    // Track the session
    activeCodexSessions.set(currentSessionId!, {
      thread,
      codex,
      status: 'running',
      abortController,
      startedAt: new Date().toISOString()
    });

    // Send session created event
    sendMessage(ws, {
      type: 'session-created',
      sessionId: currentSessionId,
      provider: 'codex'
    });

    // Execute with streaming
    const streamedTurn = await thread.runStreamed(command, {
      signal: abortController.signal
    });

    for await (const event of streamedTurn.events) {
      // Check if session was aborted
      const session: CodexSessionData | undefined = activeCodexSessions.get(currentSessionId!);
      if (!session || session.status === 'aborted') {
        break;
      }

      if (event.type === 'item.started' || event.type === 'item.updated') {
        continue;
      }

      const transformed: TransformedCodexEvent = transformCodexEvent(event);

      sendMessage(ws, {
        type: 'codex-response',
        data: transformed,
        sessionId: currentSessionId
      });

      // Extract and send token usage if available (normalized to match Claude format)
      if (event.type === 'turn.completed' && event.usage) {
        const totalTokens: number = (event.usage.input_tokens || 0) + (event.usage.output_tokens || 0);
        sendMessage(ws, {
          type: 'token-budget',
          data: {
            used: totalTokens,
            total: 200000 // Default context window for Codex models
          },
          sessionId: currentSessionId
        });
      }
    }

    // Send completion event
    sendMessage(ws, {
      type: 'codex-complete',
      sessionId: currentSessionId,
      actualSessionId: thread.id
    });

  } catch (error) {
    const session: CodexSessionData | undefined = currentSessionId ? activeCodexSessions.get(currentSessionId) : undefined;
    const isAbortError = error instanceof Error && error.name === 'AbortError';
    const errorMessage = error instanceof Error ? error.message : String(error);
    const wasAborted: boolean =
      session?.status === 'aborted' ||
      isAbortError ||
      errorMessage.toLowerCase().includes('aborted');

    if (!wasAborted) {
      console.error('[Codex] Error:', error);
      sendMessage(ws, {
        type: 'codex-error',
        error: errorMessage,
        sessionId: currentSessionId
      });
    }

  } finally {
    // Update session status
    if (currentSessionId) {
      const session: CodexSessionData | undefined = activeCodexSessions.get(currentSessionId);
      if (session) {
        session.status = session.status === 'aborted' ? 'aborted' : 'completed';
      }
    }
  }
}

/**
 * Abort an active Codex session
 */
export function abortCodexSession(sessionId: string): boolean {
  const session: CodexSessionData | undefined = activeCodexSessions.get(sessionId);

  if (!session) {
    return false;
  }

  session.status = 'aborted';
  try {
    session.abortController?.abort();
  } catch (error) {
    console.warn(`[Codex] Failed to abort session ${sessionId}:`, error);
  }

  return true;
}

/**
 * Check if a session is active
 */
export function isCodexSessionActive(sessionId: string): boolean {
  const session: CodexSessionData | undefined = activeCodexSessions.get(sessionId);
  return session?.status === 'running';
}

/**
 * Get all active sessions
 */
export function getActiveCodexSessions(): CodexActiveSessionInfo[] {
  const sessions: CodexActiveSessionInfo[] = [];

  for (const [id, session] of activeCodexSessions.entries()) {
    if (session.status === 'running') {
      sessions.push({
        id,
        status: session.status,
        startedAt: session.startedAt
      });
    }
  }

  return sessions;
}

/**
 * Helper to send message via WebSocket or writer
 */
function sendMessage(ws: WsWriter, data: Record<string, unknown>): void {
  try {
    if (ws.isSSEStreamWriter || ws.isWebSocketWriter) {
      // Writer handles stringification (SSEStreamWriter or WebSocketWriter)
      ws.send(data);
    } else if (typeof ws.send === 'function') {
      // Raw WebSocket - stringify here
      ws.send(JSON.stringify(data));
    }
  } catch (error) {
    console.error('[Codex] Error sending message:', error);
  }
}

// Clean up old completed sessions periodically
const codexCleanupInterval: ReturnType<typeof setInterval> = setInterval(() => {
  const now: number = Date.now();
  const maxAge: number = 30 * 60 * 1000; // 30 minutes

  for (const [id, session] of activeCodexSessions.entries()) {
    if (session.status !== 'running') {
      const startedAt: number = new Date(session.startedAt).getTime();
      if (now - startedAt > maxAge) {
        activeCodexSessions.delete(id);
      }
    }
  }
}, 5 * 60 * 1000); // Every 5 minutes
codexCleanupInterval.unref(); // Don't prevent process exit
