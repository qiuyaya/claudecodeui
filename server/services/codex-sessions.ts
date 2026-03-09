import { promises as fs } from 'fs';
import fsSync from 'fs';
import path from 'path';
import readline from 'readline';
import os from 'os';

interface CodexSessionMeta {
  id: string;
  cwd: string;
  model: string;
  timestamp: string;
  git: Record<string, unknown> | null;
}

interface ParsedCodexSession {
  id: string;
  cwd: string;
  model: string;
  timestamp: string;
  git: Record<string, unknown> | null;
  summary: string;
  messageCount: number;
}

interface CodexSessionEntry {
  id: string;
  summary: string;
  messageCount: number;
  lastActivity: Date;
  cwd: string;
  model: string;
  filePath: string;
  provider: string;
}

interface CodexGetSessionsOptions {
  limit?: number;
}

interface CodexJsonlEntry {
  type?: string;
  timestamp?: string;
  payload?: {
    id?: string;
    cwd?: string;
    model?: string;
    model_provider?: string;
    git?: Record<string, unknown> | null;
    type?: string;
    message?: string;
    role?: string;
    content?: string | ContentItem[];
    name?: string;
    arguments?: string;
    call_id?: string;
    output?: string;
    input?: string;
    info?: Record<string, unknown>;
    summary?: { text: string }[];
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

interface CodexMessageEntry {
  type: string;
  timestamp?: string;
  message?: { role: string; content: string };
  toolName?: string;
  toolInput?: string;
  toolCallId?: string;
  output?: string;
}

interface CodexTokenUsage {
  used: number;
  total: number;
}

interface CodexMessagesResult {
  messages: CodexMessageEntry[];
  total?: number;
  hasMore?: boolean;
  offset?: number;
  limit?: number | null;
  tokenUsage?: CodexTokenUsage | null;
}

interface ContentItem {
  type: string;
  text?: string;
}

async function parseCodexSessionFile(filePath: string): Promise<ParsedCodexSession | null> {
  try {
    const fileStream: fsSync.ReadStream = fsSync.createReadStream(filePath);
    const rl: readline.Interface = readline.createInterface({ input: fileStream, crlfDelay: Infinity });

    let sessionMeta: CodexSessionMeta | null = null;
    let lastTimestamp: string | null = null;
    let lastUserMessage: string | null = null;
    let messageCount: number = 0;

    for await (const line of rl) {
      if (line.trim()) {
        try {
          const entry: CodexJsonlEntry = JSON.parse(line);
          if (entry.timestamp) lastTimestamp = entry.timestamp;

          if (entry.type === 'session_meta' && entry.payload) {
            sessionMeta = {
              id: entry.payload.id as string,
              cwd: entry.payload.cwd as string,
              model: (entry.payload.model || entry.payload.model_provider) as string,
              timestamp: entry.timestamp as string,
              git: entry.payload.git ?? null
            };
          }

          if (entry.type === 'event_msg' && entry.payload?.type === 'user_message') {
            messageCount++;
            if (entry.payload.message) lastUserMessage = entry.payload.message as string;
          }

          if (entry.type === 'response_item' && entry.payload?.type === 'message' && entry.payload.role === 'assistant') {
            messageCount++;
          }
        } catch (parseError: unknown) { /* Skip malformed lines */ }
      }
    }

    if (sessionMeta) {
      return {
        ...sessionMeta,
        timestamp: lastTimestamp || sessionMeta.timestamp,
        summary: lastUserMessage
          ? (lastUserMessage.length > 50 ? lastUserMessage.substring(0, 50) + '...' : lastUserMessage)
          : 'Codex Session',
        messageCount
      };
    }
    return null;
  } catch (error: unknown) {
    console.error('Error parsing Codex session file:', error);
    return null;
  }
}

async function findJsonlFiles(dir: string): Promise<string[]> {
  const files: string[] = [];
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath: string = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        files.push(...await findJsonlFiles(fullPath));
      } else if (entry.name.endsWith('.jsonl')) {
        files.push(fullPath);
      }
    }
  } catch (error: unknown) { /* Skip directories we can't read */ }
  return files;
}

async function getCodexSessions(projectPath: string, options: CodexGetSessionsOptions = {}): Promise<CodexSessionEntry[]> {
  const { limit = 5 } = options;
  try {
    const codexSessionsDir: string = path.join(os.homedir(), '.codex', 'sessions');

    try {
      await fs.access(codexSessionsDir);
    } catch (error: unknown) {
      return [];
    }

    const jsonlFiles: string[] = await findJsonlFiles(codexSessionsDir);
    const sessions: CodexSessionEntry[] = [];

    for (const filePath of jsonlFiles) {
      try {
        const sessionData: ParsedCodexSession | null = await parseCodexSessionFile(filePath);
        const sessionCwd: string = sessionData?.cwd || '';
        const cleanSessionCwd: string = sessionCwd.startsWith('\\\\?\\') ? sessionCwd.slice(4) : sessionCwd;
        const cleanProjectPath: string = projectPath.startsWith('\\\\?\\') ? projectPath.slice(4) : projectPath;

        if (sessionData && (sessionData.cwd === projectPath || cleanSessionCwd === cleanProjectPath || path.relative(cleanSessionCwd, cleanProjectPath) === '')) {
          sessions.push({
            id: sessionData.id,
            summary: sessionData.summary || 'Codex Session',
            messageCount: sessionData.messageCount || 0,
            lastActivity: sessionData.timestamp ? new Date(sessionData.timestamp) : new Date(),
            cwd: sessionData.cwd,
            model: sessionData.model,
            filePath: filePath,
            provider: 'codex'
          });
        }
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        console.warn(`Could not parse Codex session file ${filePath}:`, message);
      }
    }

    sessions.sort((a: CodexSessionEntry, b: CodexSessionEntry) => new Date(b.lastActivity).getTime() - new Date(a.lastActivity).getTime());
    return limit > 0 ? sessions.slice(0, limit) : sessions;
  } catch (error: unknown) {
    console.error('Error fetching Codex sessions:', error);
    return [];
  }
}

const extractText = (content: string | ContentItem[]): string => {
  if (!Array.isArray(content)) return content;
  return content
    .map((item: ContentItem) => {
      if (item.type === 'input_text' || item.type === 'output_text') return item.text;
      if (item.type === 'text') return item.text;
      return '';
    })
    .filter(Boolean)
    .join('\n');
};

async function getCodexSessionMessages(sessionId: string, limit: number | null = null, offset: number = 0): Promise<CodexMessagesResult> {
  try {
    const codexSessionsDir: string = path.join(os.homedir(), '.codex', 'sessions');

    const findSessionFile = async (dir: string): Promise<string | null> => {
      try {
        const entries = await fs.readdir(dir, { withFileTypes: true });
        for (const entry of entries) {
          const fullPath: string = path.join(dir, entry.name);
          if (entry.isDirectory()) {
            const found: string | null = await findSessionFile(fullPath);
            if (found) return found;
          } else if (entry.name.includes(sessionId) && entry.name.endsWith('.jsonl')) {
            return fullPath;
          }
        }
      } catch (error: unknown) { /* Skip */ }
      return null;
    };

    const sessionFilePath: string | null = await findSessionFile(codexSessionsDir);
    if (!sessionFilePath) {
      console.warn(`Codex session file not found for session ${sessionId}`);
      return { messages: [], total: 0, hasMore: false };
    }

    const messages: CodexMessageEntry[] = [];
    let tokenUsage: CodexTokenUsage | null = null;
    const fileStream: fsSync.ReadStream = fsSync.createReadStream(sessionFilePath);
    const rl: readline.Interface = readline.createInterface({ input: fileStream, crlfDelay: Infinity });

    for await (const line of rl) {
      if (!line.trim()) continue;
      try {
        const entry: CodexJsonlEntry = JSON.parse(line);

        if (entry.type === 'event_msg' && entry.payload?.type === 'token_count' && entry.payload?.info) {
          const info: Record<string, unknown> = entry.payload.info as Record<string, unknown>;
          if (info.total_token_usage) {
            const usage = info.total_token_usage as Record<string, number>;
            tokenUsage = {
              used: usage.total_tokens || 0,
              total: (info.model_context_window as number) || 200000
            };
          }
        }

        if (entry.type === 'response_item' && entry.payload?.type === 'message') {
          const textContent: string = extractText(entry.payload.content ?? '');
          if (textContent?.includes('<environment_context>')) continue;
          if (textContent?.trim()) {
            const role: string = entry.payload.role || 'assistant';
            messages.push({
              type: role === 'user' ? 'user' : 'assistant',
              timestamp: entry.timestamp,
              message: { role, content: textContent }
            });
          }
        }

        if (entry.type === 'response_item' && entry.payload?.type === 'reasoning') {
          const summaryText: string | undefined = entry.payload.summary?.map((s: { text: string }) => s.text).filter(Boolean).join('\n');
          if (summaryText?.trim()) {
            messages.push({
              type: 'thinking',
              timestamp: entry.timestamp,
              message: { role: 'assistant', content: summaryText }
            });
          }
        }

        if (entry.type === 'response_item' && entry.payload?.type === 'function_call') {
          let toolName: string = entry.payload.name;
          let toolInput: string = entry.payload.arguments;
          if (toolName === 'shell_command') {
            toolName = 'Bash';
            try {
              const args = JSON.parse(entry.payload.arguments) as Record<string, string>;
              toolInput = JSON.stringify({ command: args.command });
            } catch (e: unknown) { /* Keep original */ }
          }
          messages.push({
            type: 'tool_use', timestamp: entry.timestamp,
            toolName, toolInput, toolCallId: entry.payload.call_id
          });
        }

        if (entry.type === 'response_item' && entry.payload?.type === 'function_call_output') {
          messages.push({
            type: 'tool_result', timestamp: entry.timestamp,
            toolCallId: entry.payload.call_id, output: entry.payload.output
          });
        }

        if (entry.type === 'response_item' && entry.payload?.type === 'custom_tool_call') {
          const toolName: string = entry.payload.name || 'custom_tool';
          const input: string = entry.payload.input || '';

          if (toolName === 'apply_patch') {
            const fileMatch: RegExpMatchArray | null = input.match(/\*\*\* Update File: (.+)/);
            const filePath: string = fileMatch ? fileMatch[1].trim() : 'unknown';
            const lines: string[] = input.split('\n');
            const oldLines: string[] = [];
            const newLines: string[] = [];
            for (const l of lines) {
              if (l.startsWith('-') && !l.startsWith('---')) oldLines.push(l.substring(1));
              else if (l.startsWith('+') && !l.startsWith('+++')) newLines.push(l.substring(1));
            }
            messages.push({
              type: 'tool_use', timestamp: entry.timestamp, toolName: 'Edit',
              toolInput: JSON.stringify({ file_path: filePath, old_string: oldLines.join('\n'), new_string: newLines.join('\n') }),
              toolCallId: entry.payload.call_id
            });
          } else {
            messages.push({
              type: 'tool_use', timestamp: entry.timestamp,
              toolName, toolInput: input, toolCallId: entry.payload.call_id
            });
          }
        }

        if (entry.type === 'response_item' && entry.payload?.type === 'custom_tool_call_output') {
          messages.push({
            type: 'tool_result', timestamp: entry.timestamp,
            toolCallId: entry.payload.call_id, output: entry.payload.output || ''
          });
        }
      } catch (parseError: unknown) { /* Skip malformed lines */ }
    }

    messages.sort((a: CodexMessageEntry, b: CodexMessageEntry) => new Date(a.timestamp || 0).getTime() - new Date(b.timestamp || 0).getTime());
    const total: number = messages.length;

    if (limit !== null) {
      const startIndex: number = Math.max(0, total - offset - limit);
      const endIndex: number = total - offset;
      return {
        messages: messages.slice(startIndex, endIndex),
        total, hasMore: startIndex > 0, offset, limit, tokenUsage
      };
    }

    return { messages, tokenUsage };
  } catch (error: unknown) {
    console.error(`Error reading Codex session messages for ${sessionId}:`, error);
    return { messages: [], total: 0, hasMore: false };
  }
}

async function deleteCodexSession(sessionId: string): Promise<boolean> {
  try {
    const codexSessionsDir: string = path.join(os.homedir(), '.codex', 'sessions');
    const jsonlFiles: string[] = await findJsonlFiles(codexSessionsDir);

    for (const filePath of jsonlFiles) {
      const sessionData: ParsedCodexSession | null = await parseCodexSessionFile(filePath);
      if (sessionData && sessionData.id === sessionId) {
        await fs.unlink(filePath);
        return true;
      }
    }

    throw new Error(`Codex session file not found for session ${sessionId}`);
  } catch (error: unknown) {
    console.error(`Error deleting Codex session ${sessionId}:`, error);
    throw error;
  }
}

export { getCodexSessions, getCodexSessionMessages, deleteCodexSession };
