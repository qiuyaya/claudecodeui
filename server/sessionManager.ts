import { promises as fs } from 'fs';
import path from 'path';
import os from 'os';

interface SessionMessage {
  role: 'user' | 'assistant';
  content: string;
  timestamp: Date;
}

interface GeminiSession {
  id: string;
  projectPath: string;
  messages: SessionMessage[];
  createdAt: Date;
  lastActivity: Date;
  cliSessionId?: string;
}

interface SessionSummaryEntry {
  id: string;
  summary: string;
  messageCount: number;
  lastActivity: Date;
}

interface DisplayMessage {
  type: string;
  message: {
    role: string;
    content: string;
  };
  timestamp: string;
}

class SessionManager {
  sessions: Map<string, GeminiSession>;
  maxSessions: number;
  sessionsDir: string;
  ready: Promise<void>;

  constructor() {
    // Store sessions in memory with conversation history
    this.sessions = new Map();
    this.maxSessions = 100;
    this.sessionsDir = path.join(os.homedir(), '.gemini', 'sessions');
    this.ready = this.init();
  }

  async init(): Promise<void> {
    await this.initSessionsDir();
    await this.loadSessions();
  }

  async initSessionsDir(): Promise<void> {
    try {
      await fs.mkdir(this.sessionsDir, { recursive: true });
    } catch (error: unknown) {
      // console.error('Error creating sessions directory:', error);
    }
  }

  // Create a new session
  createSession(sessionId: string, projectPath: string): GeminiSession {
    const session: GeminiSession = {
      id: sessionId,
      projectPath: projectPath,
      messages: [],
      createdAt: new Date(),
      lastActivity: new Date()
    };

    // Evict oldest session from memory if we exceed limit
    if (this.sessions.size >= this.maxSessions) {
      const oldestKey = this.sessions.keys().next().value;
      if (oldestKey) this.sessions.delete(oldestKey);
    }

    this.sessions.set(sessionId, session);
    this.saveSession(sessionId);

    return session;
  }

  // Add a message to session
  addMessage(sessionId: string, role: 'user' | 'assistant', content: string): GeminiSession {
    let session = this.sessions.get(sessionId);

    if (!session) {
      // Create session if it doesn't exist
      session = this.createSession(sessionId, '');
    }

    const message: SessionMessage = {
      role: role, // 'user' or 'assistant'
      content: content,
      timestamp: new Date()
    };

    session.messages.push(message);
    session.lastActivity = new Date();

    this.saveSession(sessionId);

    return session;
  }

  // Get session by ID
  getSession(sessionId: string): GeminiSession | undefined {
    return this.sessions.get(sessionId);
  }

  // Get all sessions for a project
  getProjectSessions(projectPath: string): SessionSummaryEntry[] {
    const sessions: SessionSummaryEntry[] = [];

    for (const [id, session] of this.sessions) {
      if (session.projectPath === projectPath) {
        sessions.push({
          id: session.id,
          summary: this.getSessionSummary(session),
          messageCount: session.messages.length,
          lastActivity: session.lastActivity
        });
      }
    }

    return sessions.sort((a, b) =>
      new Date(b.lastActivity).getTime() - new Date(a.lastActivity).getTime()
    );
  }

  // Get session summary
  getSessionSummary(session: GeminiSession): string {
    if (session.messages.length === 0) {
      return 'New Session';
    }

    // Find first user message
    const firstUserMessage = session.messages.find(m => m.role === 'user');
    if (firstUserMessage) {
      const content = firstUserMessage.content;
      return content.length > 50 ? content.substring(0, 50) + '...' : content;
    }

    return 'New Session';
  }

  // Build conversation context for Gemini
  buildConversationContext(sessionId: string, maxMessages: number = 10): string {
    const session = this.sessions.get(sessionId);

    if (!session || session.messages.length === 0) {
      return '';
    }

    // Get last N messages for context
    const recentMessages = session.messages.slice(-maxMessages);

    let context = 'Here is the conversation history:\n\n';

    for (const msg of recentMessages) {
      if (msg.role === 'user') {
        context += `User: ${msg.content}\n`;
      } else {
        context += `Assistant: ${msg.content}\n`;
      }
    }

    context += '\nBased on the conversation history above, please answer the following:\n';

    return context;
  }

  // Prevent path traversal
  _safeFilePath(sessionId: string): string {
    const safeId = String(sessionId).replace(/[/\\]|\.\./g, '');
    return path.join(this.sessionsDir, `${safeId}.json`);
  }

  // Save session to disk
  async saveSession(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    try {
      const filePath = this._safeFilePath(sessionId);
      await fs.writeFile(filePath, JSON.stringify(session, null, 2));
    } catch (error: unknown) {
      // console.error('Error saving session:', error);
    }
  }

  // Load sessions from disk
  async loadSessions(): Promise<void> {
    try {
      const files = await fs.readdir(this.sessionsDir);

      for (const file of files) {
        if (file.endsWith('.json')) {
          try {
            const filePath = path.join(this.sessionsDir, file);
            const data = await fs.readFile(filePath, 'utf8');
            const session = JSON.parse(data) as GeminiSession;

            // Convert dates
            session.createdAt = new Date(session.createdAt);
            session.lastActivity = new Date(session.lastActivity);
            session.messages.forEach((msg: SessionMessage) => {
              msg.timestamp = new Date(msg.timestamp);
            });

            this.sessions.set(session.id, session);
          } catch (error: unknown) {
            // console.error(`Error loading session ${file}:`, error);
          }
        }
      }

      // Enforce eviction after loading to prevent massive memory usage
      while (this.sessions.size > this.maxSessions) {
        const oldestKey = this.sessions.keys().next().value;
        if (oldestKey) this.sessions.delete(oldestKey);
      }
    } catch (error: unknown) {
      // console.error('Error loading sessions:', error);
    }
  }

  // Delete a session
  async deleteSession(sessionId: string): Promise<void> {
    this.sessions.delete(sessionId);

    try {
      const filePath = this._safeFilePath(sessionId);
      await fs.unlink(filePath);
    } catch (error: unknown) {
      // console.error('Error deleting session file:', error);
    }
  }

  // Get session messages for display
  getSessionMessages(sessionId: string): DisplayMessage[] {
    const session = this.sessions.get(sessionId);
    if (!session) return [];

    return session.messages.map(msg => ({
      type: 'message',
      message: {
        role: msg.role,
        content: msg.content
      },
      timestamp: msg.timestamp.toISOString()
    }));
  }
}

// Singleton instance
const sessionManager = new SessionManager();

export const ready: Promise<void> = sessionManager.ready;
export default sessionManager;
