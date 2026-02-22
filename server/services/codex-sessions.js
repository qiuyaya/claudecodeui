import { promises as fs } from 'fs';
import fsSync from 'fs';
import path from 'path';
import readline from 'readline';
import os from 'os';

async function parseCodexSessionFile(filePath) {
  try {
    const fileStream = fsSync.createReadStream(filePath);
    const rl = readline.createInterface({ input: fileStream, crlfDelay: Infinity });

    let sessionMeta = null;
    let lastTimestamp = null;
    let lastUserMessage = null;
    let messageCount = 0;

    for await (const line of rl) {
      if (line.trim()) {
        try {
          const entry = JSON.parse(line);
          if (entry.timestamp) lastTimestamp = entry.timestamp;

          if (entry.type === 'session_meta' && entry.payload) {
            sessionMeta = {
              id: entry.payload.id,
              cwd: entry.payload.cwd,
              model: entry.payload.model || entry.payload.model_provider,
              timestamp: entry.timestamp,
              git: entry.payload.git
            };
          }

          if (entry.type === 'event_msg' && entry.payload?.type === 'user_message') {
            messageCount++;
            if (entry.payload.message) lastUserMessage = entry.payload.message;
          }

          if (entry.type === 'response_item' && entry.payload?.type === 'message' && entry.payload.role === 'assistant') {
            messageCount++;
          }
        } catch (parseError) { /* Skip malformed lines */ }
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
  } catch (error) {
    console.error('Error parsing Codex session file:', error);
    return null;
  }
}

async function findJsonlFiles(dir) {
  const files = [];
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        files.push(...await findJsonlFiles(fullPath));
      } else if (entry.name.endsWith('.jsonl')) {
        files.push(fullPath);
      }
    }
  } catch (error) { /* Skip directories we can't read */ }
  return files;
}

async function getCodexSessions(projectPath, options = {}) {
  const { limit = 5 } = options;
  try {
    const codexSessionsDir = path.join(os.homedir(), '.codex', 'sessions');

    try {
      await fs.access(codexSessionsDir);
    } catch (error) {
      return [];
    }

    const jsonlFiles = await findJsonlFiles(codexSessionsDir);
    const sessions = [];

    for (const filePath of jsonlFiles) {
      try {
        const sessionData = await parseCodexSessionFile(filePath);
        const sessionCwd = sessionData?.cwd || '';
        const cleanSessionCwd = sessionCwd.startsWith('\\\\?\\') ? sessionCwd.slice(4) : sessionCwd;
        const cleanProjectPath = projectPath.startsWith('\\\\?\\') ? projectPath.slice(4) : projectPath;

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
      } catch (error) {
        console.warn(`Could not parse Codex session file ${filePath}:`, error.message);
      }
    }

    sessions.sort((a, b) => new Date(b.lastActivity) - new Date(a.lastActivity));
    return limit > 0 ? sessions.slice(0, limit) : sessions;
  } catch (error) {
    console.error('Error fetching Codex sessions:', error);
    return [];
  }
}

const extractText = (content) => {
  if (!Array.isArray(content)) return content;
  return content
    .map(item => {
      if (item.type === 'input_text' || item.type === 'output_text') return item.text;
      if (item.type === 'text') return item.text;
      return '';
    })
    .filter(Boolean)
    .join('\n');
};

async function getCodexSessionMessages(sessionId, limit = null, offset = 0) {
  try {
    const codexSessionsDir = path.join(os.homedir(), '.codex', 'sessions');

    const findSessionFile = async (dir) => {
      try {
        const entries = await fs.readdir(dir, { withFileTypes: true });
        for (const entry of entries) {
          const fullPath = path.join(dir, entry.name);
          if (entry.isDirectory()) {
            const found = await findSessionFile(fullPath);
            if (found) return found;
          } else if (entry.name.includes(sessionId) && entry.name.endsWith('.jsonl')) {
            return fullPath;
          }
        }
      } catch (error) { /* Skip */ }
      return null;
    };

    const sessionFilePath = await findSessionFile(codexSessionsDir);
    if (!sessionFilePath) {
      console.warn(`Codex session file not found for session ${sessionId}`);
      return { messages: [], total: 0, hasMore: false };
    }

    const messages = [];
    let tokenUsage = null;
    const fileStream = fsSync.createReadStream(sessionFilePath);
    const rl = readline.createInterface({ input: fileStream, crlfDelay: Infinity });

    for await (const line of rl) {
      if (!line.trim()) continue;
      try {
        const entry = JSON.parse(line);

        if (entry.type === 'event_msg' && entry.payload?.type === 'token_count' && entry.payload?.info) {
          const info = entry.payload.info;
          if (info.total_token_usage) {
            tokenUsage = {
              used: info.total_token_usage.total_tokens || 0,
              total: info.model_context_window || 200000
            };
          }
        }

        if (entry.type === 'response_item' && entry.payload?.type === 'message') {
          const textContent = extractText(entry.payload.content);
          if (textContent?.includes('<environment_context>')) continue;
          if (textContent?.trim()) {
            const role = entry.payload.role || 'assistant';
            messages.push({
              type: role === 'user' ? 'user' : 'assistant',
              timestamp: entry.timestamp,
              message: { role, content: textContent }
            });
          }
        }

        if (entry.type === 'response_item' && entry.payload?.type === 'reasoning') {
          const summaryText = entry.payload.summary?.map(s => s.text).filter(Boolean).join('\n');
          if (summaryText?.trim()) {
            messages.push({
              type: 'thinking',
              timestamp: entry.timestamp,
              message: { role: 'assistant', content: summaryText }
            });
          }
        }

        if (entry.type === 'response_item' && entry.payload?.type === 'function_call') {
          let toolName = entry.payload.name;
          let toolInput = entry.payload.arguments;
          if (toolName === 'shell_command') {
            toolName = 'Bash';
            try {
              const args = JSON.parse(entry.payload.arguments);
              toolInput = JSON.stringify({ command: args.command });
            } catch (e) { /* Keep original */ }
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
          const toolName = entry.payload.name || 'custom_tool';
          const input = entry.payload.input || '';

          if (toolName === 'apply_patch') {
            const fileMatch = input.match(/\*\*\* Update File: (.+)/);
            const filePath = fileMatch ? fileMatch[1].trim() : 'unknown';
            const lines = input.split('\n');
            const oldLines = [];
            const newLines = [];
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
      } catch (parseError) { /* Skip malformed lines */ }
    }

    messages.sort((a, b) => new Date(a.timestamp || 0) - new Date(b.timestamp || 0));
    const total = messages.length;

    if (limit !== null) {
      const startIndex = Math.max(0, total - offset - limit);
      const endIndex = total - offset;
      return {
        messages: messages.slice(startIndex, endIndex),
        total, hasMore: startIndex > 0, offset, limit, tokenUsage
      };
    }

    return { messages, tokenUsage };
  } catch (error) {
    console.error(`Error reading Codex session messages for ${sessionId}:`, error);
    return { messages: [], total: 0, hasMore: false };
  }
}

async function deleteCodexSession(sessionId) {
  try {
    const codexSessionsDir = path.join(os.homedir(), '.codex', 'sessions');
    const jsonlFiles = await findJsonlFiles(codexSessionsDir);

    for (const filePath of jsonlFiles) {
      const sessionData = await parseCodexSessionFile(filePath);
      if (sessionData && sessionData.id === sessionId) {
        await fs.unlink(filePath);
        return true;
      }
    }

    throw new Error(`Codex session file not found for session ${sessionId}`);
  } catch (error) {
    console.error(`Error deleting Codex session ${sessionId}:`, error);
    throw error;
  }
}

export { getCodexSessions, getCodexSessionMessages, deleteCodexSession };
