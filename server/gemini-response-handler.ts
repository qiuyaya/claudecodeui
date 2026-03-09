// Gemini Response Handler - JSON Stream processing

interface WsWriter {
  send: (data: Record<string, unknown>) => void;
  getSessionId?: () => string | null;
  setSessionId?: (id: string) => void;
  isSSEStreamWriter?: boolean;
  isWebSocketWriter?: boolean;
  updateWebSocket?: (ws: WsWriter) => void;
}

interface GeminiEvent {
  type: string;
  role?: string;
  content?: string;
  delta?: boolean;
  tool_name?: string;
  tool_id?: string;
  parameters?: Record<string, unknown>;
  status?: string;
  output?: string;
  error?: string;
  message?: string;
  stats?: {
    total_tokens?: number;
    [key: string]: unknown;
  };
  session_id?: string;
  [key: string]: unknown;
}

interface GeminiResponseHandlerOptions {
  onContentFragment?: ((content: string) => void) | null;
  onInit?: ((event: GeminiEvent) => void) | null;
  onToolUse?: ((event: GeminiEvent) => void) | null;
  onToolResult?: ((event: GeminiEvent) => void) | null;
}

class GeminiResponseHandler {
  private ws: WsWriter;
  private buffer: string;
  private onContentFragment: ((content: string) => void) | null;
  private onInit: ((event: GeminiEvent) => void) | null;
  private onToolUse: ((event: GeminiEvent) => void) | null;
  private onToolResult: ((event: GeminiEvent) => void) | null;

  constructor(ws: WsWriter, options: GeminiResponseHandlerOptions = {}) {
    this.ws = ws;
    this.buffer = '';
    this.onContentFragment = options.onContentFragment || null;
    this.onInit = options.onInit || null;
    this.onToolUse = options.onToolUse || null;
    this.onToolResult = options.onToolResult || null;
  }

  // Process incoming raw data from Gemini stream-json
  processData(data: string): void {
    this.buffer += data;

    // Split by newline
    const lines: string[] = this.buffer.split('\n');

    // Keep the last incomplete line in the buffer
    this.buffer = lines.pop() || '';

    for (const line of lines) {
      if (!line.trim()) continue;

      try {
        const event: GeminiEvent = JSON.parse(line);
        this.handleEvent(event);
      } catch (err) {
        // Not a JSON line, probably debug output or CLI warnings
        // console.error('[Gemini Handler] Non-JSON line ignored:', line);
      }
    }
  }

  handleEvent(event: GeminiEvent): void {
    const socketSessionId: string | null = typeof this.ws.getSessionId === 'function' ? this.ws.getSessionId() : null;

    if (event.type === 'init') {
      if (this.onInit) {
        this.onInit(event);
      }
      return;
    }

    if (event.type === 'message' && event.role === 'assistant') {
      const content: string = event.content || '';

      // Notify the parent CLI handler of accumulated text
      if (this.onContentFragment && content) {
        this.onContentFragment(content);
      }

      const payload: Record<string, unknown> = {
        type: 'gemini-response',
        data: {
          type: 'message',
          content: content,
          isPartial: event.delta === true
        }
      };
      if (socketSessionId) payload.sessionId = socketSessionId;
      this.ws.send(payload);
    }
    else if (event.type === 'tool_use') {
      if (this.onToolUse) {
        this.onToolUse(event);
      }
      const payload: Record<string, unknown> = {
        type: 'gemini-tool-use',
        toolName: event.tool_name,
        toolId: event.tool_id,
        parameters: event.parameters || {}
      };
      if (socketSessionId) payload.sessionId = socketSessionId;
      this.ws.send(payload);
    }
    else if (event.type === 'tool_result') {
      if (this.onToolResult) {
        this.onToolResult(event);
      }
      const payload: Record<string, unknown> = {
        type: 'gemini-tool-result',
        toolId: event.tool_id,
        status: event.status,
        output: event.output || ''
      };
      if (socketSessionId) payload.sessionId = socketSessionId;
      this.ws.send(payload);
    }
    else if (event.type === 'result') {
      // Send a finalize message string
      const payload: Record<string, unknown> = {
        type: 'gemini-response',
        data: {
          type: 'message',
          content: '',
          isPartial: false
        }
      };
      if (socketSessionId) payload.sessionId = socketSessionId;
      this.ws.send(payload);

      if (event.stats && event.stats.total_tokens) {
        const statsPayload: Record<string, unknown> = {
          type: 'claude-status',
          data: {
            status: 'Complete',
            tokens: event.stats.total_tokens
          }
        };
        if (socketSessionId) statsPayload.sessionId = socketSessionId;
        this.ws.send(statsPayload);
      }
    }
    else if (event.type === 'error') {
      const payload: Record<string, unknown> = {
        type: 'gemini-error',
        error: event.error || event.message || 'Unknown Gemini streaming error'
      };
      if (socketSessionId) payload.sessionId = socketSessionId;
      this.ws.send(payload);
    }
  }

  forceFlush(): void {
    // If the buffer has content, try to parse it one last time
    if (this.buffer.trim()) {
      try {
        const event: GeminiEvent = JSON.parse(this.buffer);
        this.handleEvent(event);
      } catch (err) { }
    }
  }

  destroy(): void {
    this.buffer = '';
  }
}

export default GeminiResponseHandler;
