import type { Request, Response, NextFunction } from 'express';

// ==================== Database Models ====================

export interface User {
  id: number;
  username: string;
  password_hash?: string;
  created_at: string;
  last_login: string | null;
  git_name?: string | null;
  git_email?: string | null;
  onboarding_completed?: number;
}

export interface ApiKey {
  id: number;
  user_id: number;
  key_name: string;
  api_key: string;
  created_at: string;
  last_used: string | null;
  is_active: number;
}

export interface UserCredential {
  id: number;
  user_id: number;
  credential_name: string;
  credential_type: string;
  credential_value: string;
  description: string | null;
  created_at: string;
  is_active: number;
}

export interface RefreshToken {
  id: number;
  user_id: number;
  token_hash: string;
  created_at: string;
  expires_at: string;
  is_revoked: number;
}

export interface SessionName {
  id: number;
  session_id: string;
  provider: string;
  custom_name: string;
  created_at: string;
  updated_at: string;
}

export interface AppSetting {
  key: string;
  value: string;
  updated_at: string;
}

// ==================== Auth Types ====================

export interface JwtPayload {
  id: number;
  username: string;
  iat?: number;
  exp?: number;
}

export interface AuthRequest extends Request {
  user?: {
    id: number;
    username: string;
    created_at?: string;
    last_login?: string;
    platformUserId?: string;
    platformUsername?: string;
    platformEmail?: string;
  };
  apiKeyUser?: {
    id: number;
    username: string;
    api_key_id: number;
  };
}

export interface TokenPair {
  accessToken: string;
  refreshToken: string;
}

// ==================== Session Types ====================

export interface SessionMessage {
  role: 'user' | 'assistant';
  content: string;
  timestamp: Date;
}

export interface Session {
  id: string;
  projectPath: string;
  messages: SessionMessage[];
  createdAt: Date;
  lastActivity: Date;
}

export interface SessionSummary {
  id: string;
  summary: string;
  messageCount: number;
  lastActivity: Date;
}

// ==================== Provider Types ====================

export type ProviderType = 'claude' | 'cursor' | 'codex' | 'gemini';

export interface ClaudeMessage {
  role: 'user' | 'assistant';
  content: string | ContentBlock[];
}

export interface ContentBlock {
  type: 'text' | 'tool_use' | 'tool_result' | 'image';
  text?: string;
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
  tool_use_id?: string;
  content?: string | ContentBlock[];
  source?: ImageSource;
}

export interface ImageSource {
  type: 'base64';
  media_type: string;
  data: string;
}

export interface CursorSession {
  composerId: string;
  title: string;
  createdAt: number;
  lastUpdatedAt: number;
  messageCount: number;
}

export interface CodexSession {
  id: string;
  summary: string;
  timestamp: number;
  messageCount: number;
}

// ==================== WebSocket Types ====================

export interface WsMessage {
  type: string;
  [key: string]: unknown;
}

export interface WsClientMessage extends WsMessage {
  type: 'query' | 'abort' | 'ping' | 'approve_tool' | 'deny_tool' | 'provide_input';
}

export interface WsServerMessage extends WsMessage {
  type: 'message' | 'error' | 'status' | 'tool_use' | 'result' | 'pong' | 'session_update';
}

// ==================== Project Types ====================

export interface Project {
  path: string;
  name: string;
  sessions: ProjectSession[];
  provider: ProviderType;
  manuallyAdded?: boolean;
}

export interface ProjectSession {
  id: string;
  summary: string;
  provider: string;
  timestamp: number;
  messageCount?: number;
}

// ==================== Config Types ====================

export interface AppConfig {
  port: number;
  host: string;
  isPlatform: boolean;
}

// ==================== Logger Types ====================

export interface SecurityLogger {
  authAttempt: (success: boolean, username: string, ip: string, details?: Record<string, unknown>) => void;
  blocked: (reason: string, ip: string, path: string, details?: Record<string, unknown>) => void;
  suspicious: (activity: string, ip: string, details?: Record<string, unknown>) => void;
  violation: (violation: string, ip: string, details?: Record<string, unknown>) => void;
}

export interface AuditLogger {
  action: (username: string, action: string, resource: string, details?: Record<string, unknown>) => void;
  access: (username: string, resource: string, operation: string, details?: Record<string, unknown>) => void;
  configChange: (username: string, setting: string, oldValue: unknown, newValue: unknown, details?: Record<string, unknown>) => void;
}

export interface AppLogger {
  info: (message: string, data?: Record<string, unknown>) => void;
  warn: (message: string, data?: Record<string, unknown>) => void;
  error: (message: string, error?: Error | null, data?: Record<string, unknown>) => void;
}

export interface LoggerModule {
  security: SecurityLogger;
  audit: AuditLogger;
  logger: AppLogger;
  rotateLogs: () => void;
}

// ==================== MCP Types ====================

export interface MCPServerConfig {
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  type?: 'stdio' | 'http' | 'sse';
}

export interface MCPConfig {
  mcpServers?: Record<string, MCPServerConfig>;
}

// ==================== TaskMaster Types ====================

export interface TaskMasterTask {
  id: string | number;
  title: string;
  description?: string;
  status: string;
  priority?: string;
  dependencies?: (string | number)[];
  subtasks?: TaskMasterTask[];
}

export interface TaskMasterProject {
  name: string;
  path: string;
  tasks: TaskMasterTask[];
  totalTasks: number;
  completedTasks: number;
}

// ==================== PTY Types ====================

export interface PtySession {
  pty: import('node-pty').IPty;
  ws: import('ws').WebSocket;
  lastActivity: number;
  projectPath: string;
}

// ==================== Express Middleware Types ====================

export type AsyncRequestHandler = (
  req: AuthRequest,
  res: Response,
  next: NextFunction
) => Promise<void> | void;

// ==================== Model Types ====================

export interface ModelDefinition {
  id: string;
  name: string;
  provider?: string;
}

// ==================== Error Utilities ====================

export function getErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

export function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}
