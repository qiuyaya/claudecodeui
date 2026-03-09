import express, { Router, Request, Response } from 'express';
import { spawn, ChildProcess } from 'child_process';
import { promises as fs } from 'fs';
import path from 'path';
import os from 'os';
import TOML from '@iarna/toml';
import { getCodexSessions, getCodexSessionMessages, deleteCodexSession } from '../projects.js';
import { applyCustomSessionNames, sessionNamesDb } from '../database/db.js';

const router: Router = express.Router();

function createCliResponder(res: Response): (status: number, payload: Record<string, unknown>) => void {
  let responded = false;
  return (status: number, payload: Record<string, unknown>): void => {
    if (responded || res.headersSent) {
      return;
    }
    responded = true;
    res.status(status).json(payload);
  };
}

router.get('/config', async (req: Request, res: Response): Promise<void> => {
  try {
    const configPath = path.join(os.homedir(), '.codex', 'config.toml');
    const content = await fs.readFile(configPath, 'utf8');
    const config = TOML.parse(content) as Record<string, unknown>;

    res.json({
      success: true,
      config: {
        model: config.model || null,
        mcpServers: config.mcp_servers || {},
        approvalMode: config.approval_mode || 'suggest'
      }
    });
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      res.json({
        success: true,
        config: {
          model: null,
          mcpServers: {},
          approvalMode: 'suggest'
        }
      });
    } else {
      console.error('Error reading Codex config:', error);
      res.status(500).json({ success: false, error: (error as Error).message });
    }
  }
});

router.get('/sessions', async (req: Request, res: Response): Promise<void> => {
  try {
    const { projectPath } = req.query;

    if (!projectPath) {
      res.status(400).json({ success: false, error: 'projectPath query parameter required' });
      return;
    }

    const sessions = await getCodexSessions(projectPath as string);
    applyCustomSessionNames(sessions, 'codex');
    res.json({ success: true, sessions });
  } catch (error: unknown) {
    console.error('Error fetching Codex sessions:', error);
    res.status(500).json({ success: false, error: (error as Error).message });
  }
});

router.get('/sessions/:sessionId/messages', async (req: Request, res: Response): Promise<void> => {
  try {
    const { sessionId } = req.params;
    const { limit, offset } = req.query;

    const result = await getCodexSessionMessages(
      sessionId,
      limit ? parseInt(limit as string, 10) : null,
      offset ? parseInt(offset as string, 10) : 0
    );

    res.json({ success: true, ...result });
  } catch (error: unknown) {
    console.error('Error fetching Codex session messages:', error);
    res.status(500).json({ success: false, error: (error as Error).message });
  }
});

router.delete('/sessions/:sessionId', async (req: Request, res: Response): Promise<void> => {
  try {
    const { sessionId } = req.params;
    await deleteCodexSession(sessionId as string);
    sessionNamesDb.deleteName(sessionId as string, 'codex');
    res.json({ success: true });
  } catch (error: unknown) {
    console.error(`Error deleting Codex session ${req.params.sessionId}:`, error);
    res.status(500).json({ success: false, error: (error as Error).message });
  }
});

// MCP Server Management Routes

router.get('/mcp/cli/list', async (req: Request, res: Response): Promise<void> => {
  try {
    const respond = createCliResponder(res);
    const proc: ChildProcess = spawn('codex', ['mcp', 'list'], { stdio: ['pipe', 'pipe', 'pipe'] });

    let stdout = '';
    let stderr = '';

    proc.stdout?.on('data', (data: Buffer) => { stdout += data.toString(); });
    proc.stderr?.on('data', (data: Buffer) => { stderr += data.toString(); });

    proc.on('close', (code: number | null) => {
      if (code === 0) {
        respond(200, { success: true, output: stdout, servers: parseCodexListOutput(stdout) });
      } else {
        respond(500, { error: 'Codex CLI command failed', details: stderr || `Exited with code ${code}` });
      }
    });

    proc.on('error', (error: NodeJS.ErrnoException) => {
      const isMissing = error?.code === 'ENOENT';
      respond(isMissing ? 503 : 500, {
        error: isMissing ? 'Codex CLI not installed' : 'Failed to run Codex CLI',
        details: error.message,
        code: error.code
      });
    });
  } catch (error: unknown) {
    res.status(500).json({ error: 'Failed to list MCP servers', details: (error as Error).message });
  }
});

router.post('/mcp/cli/add', async (req: Request, res: Response): Promise<void> => {
  try {
    const { name, command, args = [], env = {} } = req.body;

    if (!name || !command) {
      res.status(400).json({ error: 'name and command are required' });
      return;
    }

    // Build: codex mcp add <name> [-e KEY=VAL]... -- <command> [args...]
    let cliArgs: string[] = ['mcp', 'add', name];

    Object.entries(env).forEach(([key, value]) => {
      cliArgs.push('-e', `${key}=${value}`);
    });

    cliArgs.push('--', command);

    if (args && args.length > 0) {
      cliArgs.push(...args);
    }

    const respond = createCliResponder(res);
    const proc: ChildProcess = spawn('codex', cliArgs, { stdio: ['pipe', 'pipe', 'pipe'] });

    let stdout = '';
    let stderr = '';

    proc.stdout?.on('data', (data: Buffer) => { stdout += data.toString(); });
    proc.stderr?.on('data', (data: Buffer) => { stderr += data.toString(); });

    proc.on('close', (code: number | null) => {
      if (code === 0) {
        respond(200, { success: true, output: stdout, message: `MCP server "${name}" added successfully` });
      } else {
        respond(400, { error: 'Codex CLI command failed', details: stderr || `Exited with code ${code}` });
      }
    });

    proc.on('error', (error: NodeJS.ErrnoException) => {
      const isMissing = error?.code === 'ENOENT';
      respond(isMissing ? 503 : 500, {
        error: isMissing ? 'Codex CLI not installed' : 'Failed to run Codex CLI',
        details: error.message,
        code: error.code
      });
    });
  } catch (error: unknown) {
    res.status(500).json({ error: 'Failed to add MCP server', details: (error as Error).message });
  }
});

router.delete('/mcp/cli/remove/:name', async (req: Request, res: Response): Promise<void> => {
  try {
    const { name } = req.params;

    const respond = createCliResponder(res);
    const proc: ChildProcess = spawn('codex', ['mcp', 'remove', name as string], { stdio: ['pipe', 'pipe', 'pipe'] });

    let stdout = '';
    let stderr = '';

    proc.stdout?.on('data', (data: Buffer) => { stdout += data.toString(); });
    proc.stderr?.on('data', (data: Buffer) => { stderr += data.toString(); });

    proc.on('close', (code: number | null) => {
      if (code === 0) {
        respond(200, { success: true, output: stdout, message: `MCP server "${name}" removed successfully` });
      } else {
        respond(400, { error: 'Codex CLI command failed', details: stderr || `Exited with code ${code}` });
      }
    });

    proc.on('error', (error: NodeJS.ErrnoException) => {
      const isMissing = error?.code === 'ENOENT';
      respond(isMissing ? 503 : 500, {
        error: isMissing ? 'Codex CLI not installed' : 'Failed to run Codex CLI',
        details: error.message,
        code: error.code
      });
    });
  } catch (error: unknown) {
    res.status(500).json({ error: 'Failed to remove MCP server', details: (error as Error).message });
  }
});

router.get('/mcp/cli/get/:name', async (req: Request, res: Response): Promise<void> => {
  try {
    const { name } = req.params;

    const respond = createCliResponder(res);
    const proc: ChildProcess = spawn('codex', ['mcp', 'get', name as string], { stdio: ['pipe', 'pipe', 'pipe'] });

    let stdout = '';
    let stderr = '';

    proc.stdout?.on('data', (data: Buffer) => { stdout += data.toString(); });
    proc.stderr?.on('data', (data: Buffer) => { stderr += data.toString(); });

    proc.on('close', (code: number | null) => {
      if (code === 0) {
        respond(200, { success: true, output: stdout, server: parseCodexGetOutput(stdout) });
      } else {
        respond(404, { error: 'Codex CLI command failed', details: stderr || `Exited with code ${code}` });
      }
    });

    proc.on('error', (error: NodeJS.ErrnoException) => {
      const isMissing = error?.code === 'ENOENT';
      respond(isMissing ? 503 : 500, {
        error: isMissing ? 'Codex CLI not installed' : 'Failed to run Codex CLI',
        details: error.message,
        code: error.code
      });
    });
  } catch (error: unknown) {
    res.status(500).json({ error: 'Failed to get MCP server details', details: (error as Error).message });
  }
});

router.get('/mcp/config/read', async (req: Request, res: Response): Promise<void> => {
  try {
    const configPath = path.join(os.homedir(), '.codex', 'config.toml');

    let configData: Record<string, unknown> | null = null;

    try {
      const fileContent = await fs.readFile(configPath, 'utf8');
      configData = TOML.parse(fileContent);
    } catch (error: unknown) {
      // Config file doesn't exist
    }

    if (!configData) {
      res.json({ success: true, configPath, servers: [] });
      return;
    }

    const servers: Array<Record<string, unknown>> = [];

    if (configData.mcp_servers && typeof configData.mcp_servers === 'object') {
      for (const [name, config] of Object.entries(configData.mcp_servers as Record<string, Record<string, unknown>>)) {
        servers.push({
          id: name,
          name: name,
          type: 'stdio',
          scope: 'user',
          config: {
            command: config.command || '',
            args: config.args || [],
            env: config.env || {}
          },
          raw: config
        });
      }
    }

    res.json({ success: true, configPath, servers });
  } catch (error: unknown) {
    res.status(500).json({ error: 'Failed to read Codex configuration', details: (error as Error).message });
  }
});

function parseCodexListOutput(output: string): Array<{ name: string; type: string; status: string; description: string }> {
  const servers: Array<{ name: string; type: string; status: string; description: string }> = [];
  const lines = output.split('\n').filter((line: string) => line.trim());

  for (const line of lines) {
    if (line.includes(':')) {
      const colonIndex = line.indexOf(':');
      const name = line.substring(0, colonIndex).trim();

      if (!name) continue;

      const rest = line.substring(colonIndex + 1).trim();
      let description = rest;
      let status = 'unknown';

      if (rest.includes('\u2713') || rest.includes('\u2717')) {
        const statusMatch = rest.match(/(.*?)\s*-\s*([\u2713\u2717].*)$/);
        if (statusMatch) {
          description = statusMatch[1].trim();
          status = statusMatch[2].includes('\u2713') ? 'connected' : 'failed';
        }
      }

      servers.push({ name, type: 'stdio', status, description });
    }
  }

  return servers;
}

function parseCodexGetOutput(output: string): Record<string, unknown> {
  try {
    const jsonMatch = output.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      return JSON.parse(jsonMatch[0]);
    }

    const server: Record<string, string> = { raw_output: output };
    const lines = output.split('\n');

    for (const line of lines) {
      if (line.includes('Name:')) server.name = line.split(':')[1]?.trim();
      else if (line.includes('Type:')) server.type = line.split(':')[1]?.trim();
      else if (line.includes('Command:')) server.command = line.split(':')[1]?.trim();
    }

    return server;
  } catch (error: unknown) {
    return { raw_output: output, parse_error: (error as Error).message };
  }
}

export default router;
