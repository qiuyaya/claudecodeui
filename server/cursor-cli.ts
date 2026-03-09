import { spawn, ChildProcess } from 'child_process';
import crossSpawn from 'cross-spawn';
import { promises as fs } from 'fs';
import path from 'path';
import os from 'os';
import { getSanitizedEnv } from './utils/env.js';

// Use cross-spawn on Windows for better command execution
const spawnFunction = process.platform === 'win32' ? crossSpawn : spawn;

interface WsWriter {
  send: (data: Record<string, unknown>) => void;
  setSessionId?: (id: string) => void;
  getSessionId?: () => string | null;
  isSSEStreamWriter?: boolean;
  isWebSocketWriter?: boolean;
}

interface CursorOptions {
  sessionId?: string;
  projectPath?: string;
  cwd?: string;
  resume?: boolean;
  toolsSettings?: CursorToolsSettings;
  skipPermissions?: boolean;
  model?: string;
  images?: unknown[];
  [key: string]: unknown;
}

interface CursorToolsSettings {
  allowedShellCommands?: string[];
  skipPermissions?: boolean;
  [key: string]: unknown;
}

interface CursorJsonResponse {
  type: string;
  subtype?: string;
  session_id?: string;
  model?: string;
  cwd?: string;
  message?: {
    content?: Array<{ text?: string; [key: string]: unknown }>;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

let activeCursorProcesses: Map<string, ChildProcess> = new Map(); // Track active processes by session ID

async function spawnCursor(command: string, options: CursorOptions = {}, ws: WsWriter): Promise<void> {
  return new Promise<void>(async (resolve, reject) => {
    const { sessionId, projectPath, cwd, resume, toolsSettings, skipPermissions, model, images } = options;
    let capturedSessionId: string | undefined = sessionId; // Track session ID throughout the process
    let sessionCreatedSent = false; // Track if we've already sent session-created event
    let messageBuffer = ''; // Buffer for accumulating assistant messages

    // Use tools settings passed from frontend, or defaults
    const settings: CursorToolsSettings = toolsSettings || {
      allowedShellCommands: [],
      skipPermissions: false
    };

    // Build Cursor CLI command
    const args: string[] = [];

    // Build flags allowing both resume and prompt together (reply in existing session)
    // Treat presence of sessionId as intention to resume, regardless of resume flag
    if (sessionId) {
      args.push('--resume=' + sessionId);
    }

    if (command && command.trim()) {
      // Provide a prompt (works for both new and resumed sessions)
      args.push('-p', command);

      // Add model flag if specified (only meaningful for new sessions; harmless on resume)
      if (!sessionId && model) {
        args.push('--model', model);
      }

      // Request streaming JSON when we are providing a prompt
      args.push('--output-format', 'stream-json');
    }

    // Add skip permissions flag if enabled
    if (skipPermissions || settings.skipPermissions) {
      args.push('-f');
      console.log('⚠️  Using -f flag (skip permissions)');
    }

    // Use cwd (actual project directory) instead of projectPath
    const workingDir: string = cwd || projectPath || process.cwd();

    console.log('Spawning Cursor CLI:', 'cursor-agent', args.join(' '));
    console.log('Working directory:', workingDir);
    console.log('Session info - Input sessionId:', sessionId, 'Resume:', resume);

    const cursorProcess: ChildProcess = spawnFunction('cursor-agent', args, {
      cwd: workingDir,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: getSanitizedEnv()
    });

    // Store process reference for potential abort
    const processKey: string = capturedSessionId || Date.now().toString();
    activeCursorProcesses.set(processKey, cursorProcess);

    // Handle stdout (streaming JSON responses)
    cursorProcess.stdout!.on('data', (data: Buffer) => {
      const rawOutput: string = data.toString();
      console.log('📤 Cursor CLI stdout:', rawOutput);

      const lines: string[] = rawOutput.split('\n').filter((line: string) => line.trim());

      for (const line of lines) {
        try {
          const response: CursorJsonResponse = JSON.parse(line);
          console.log('📄 Parsed JSON response:', response);

          // Handle different message types
          switch (response.type) {
            case 'system':
              if (response.subtype === 'init') {
                // Capture session ID
                if (response.session_id && !capturedSessionId) {
                  capturedSessionId = response.session_id;
                  console.log('📝 Captured session ID:', capturedSessionId);

                  // Update process key with captured session ID
                  if (processKey !== capturedSessionId) {
                    activeCursorProcesses.delete(processKey);
                    activeCursorProcesses.set(capturedSessionId, cursorProcess);
                  }

                  // Set session ID on writer (for API endpoint compatibility)
                  if (ws.setSessionId && typeof ws.setSessionId === 'function') {
                    ws.setSessionId(capturedSessionId);
                  }

                  // Send session-created event only once for new sessions
                  if (!sessionId && !sessionCreatedSent) {
                    sessionCreatedSent = true;
                    ws.send({
                      type: 'session-created',
                      sessionId: capturedSessionId,
                      model: response.model,
                      cwd: response.cwd
                    });
                  }
                }

                // Send system info to frontend
                ws.send({
                  type: 'cursor-system',
                  data: response,
                  sessionId: capturedSessionId || sessionId || null
                });
              }
              break;

            case 'user':
              // Forward user message
              ws.send({
                type: 'cursor-user',
                data: response,
                sessionId: capturedSessionId || sessionId || null
              });
              break;

            case 'assistant':
              // Accumulate assistant message chunks
              if (response.message && response.message.content && response.message.content.length > 0) {
                const textContent: string = response.message.content[0].text || '';
                messageBuffer += textContent;

                // Send as Claude-compatible format for frontend
                ws.send({
                  type: 'claude-response',
                  data: {
                    type: 'content_block_delta',
                    delta: {
                      type: 'text_delta',
                      text: textContent
                    }
                  },
                  sessionId: capturedSessionId || sessionId || null
                });
              }
              break;

            case 'result':
              // Session complete
              console.log('Cursor session result:', response);

              // Send final message if we have buffered content
              if (messageBuffer) {
                ws.send({
                  type: 'claude-response',
                  data: {
                    type: 'content_block_stop'
                  },
                  sessionId: capturedSessionId || sessionId || null
                });
              }

              // Send completion event
              ws.send({
                type: 'cursor-result',
                sessionId: capturedSessionId || sessionId,
                data: response,
                success: response.subtype === 'success'
              });
              break;

            default:
              // Forward any other message types
              ws.send({
                type: 'cursor-response',
                data: response,
                sessionId: capturedSessionId || sessionId || null
              });
          }
        } catch (parseError) {
          console.log('📄 Non-JSON response:', line);
          // If not JSON, send as raw text
          ws.send({
            type: 'cursor-output',
            data: line,
            sessionId: capturedSessionId || sessionId || null
          });
        }
      }
    });

    // Handle stderr
    cursorProcess.stderr!.on('data', (data: Buffer) => {
      console.error('Cursor CLI stderr:', data.toString());
      ws.send({
        type: 'cursor-error',
        error: data.toString(),
        sessionId: capturedSessionId || sessionId || null
      });
    });

    // Handle process completion
    cursorProcess.on('close', async (code: number | null) => {
      console.log(`Cursor CLI process exited with code ${code}`);

      // Clean up process reference
      const finalSessionId: string = capturedSessionId || sessionId || processKey;
      activeCursorProcesses.delete(finalSessionId);

      ws.send({
        type: 'claude-complete',
        sessionId: finalSessionId,
        exitCode: code,
        isNewSession: !sessionId && !!command // Flag to indicate this was a new session
      });

      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`Cursor CLI exited with code ${code}`));
      }
    });

    // Handle process errors
    cursorProcess.on('error', (error: Error) => {
      console.error('Cursor CLI process error:', error);

      // Clean up process reference on error
      const finalSessionId: string = capturedSessionId || sessionId || processKey;
      activeCursorProcesses.delete(finalSessionId);

      ws.send({
        type: 'cursor-error',
        error: error.message,
        sessionId: capturedSessionId || sessionId || null
      });

      reject(error);
    });

    // Close stdin since Cursor doesn't need interactive input
    cursorProcess.stdin!.end();
  });
}

function abortCursorSession(sessionId: string): boolean {
  const proc: ChildProcess | undefined = activeCursorProcesses.get(sessionId);
  if (proc) {
    console.log(`🛑 Aborting Cursor session: ${sessionId}`);
    proc.kill('SIGTERM');
    activeCursorProcesses.delete(sessionId);
    return true;
  }
  return false;
}

function isCursorSessionActive(sessionId: string): boolean {
  return activeCursorProcesses.has(sessionId);
}

function getActiveCursorSessions(): string[] {
  return Array.from(activeCursorProcesses.keys());
}

export {
  spawnCursor,
  abortCursorSession,
  isCursorSessionActive,
  getActiveCursorSessions
};
