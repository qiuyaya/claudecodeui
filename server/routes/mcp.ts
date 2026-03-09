import { Router, Request, Response } from 'express';
import { promises as fs } from 'fs';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import { spawn, ChildProcess } from 'child_process';

const router: Router = Router();
const __filename: string = fileURLToPath(import.meta.url);
const __dirname: string = dirname(__filename);

interface MCPServer {
  id: string;
  name: string;
  type: string;
  scope: string;
  projectPath?: string;
  config: {
    command?: string;
    args?: string[];
    env?: Record<string, string>;
    url?: string;
    headers?: Record<string, string>;
  };
  raw: Record<string, unknown>;
}

interface ParsedServer {
  name: string;
  type: string;
  status: string;
  description: string;
}

interface ParsedServerDetails {
  raw_output: string;
  name?: string;
  type?: string;
  command?: string;
  url?: string;
  parse_error?: string;
}

interface ClaudeConfigData {
  mcpServers?: Record<string, Record<string, unknown>>;
  projects?: Record<string, {
    mcpServers?: Record<string, Record<string, unknown>>;
  }>;
  [key: string]: unknown;
}

// Claude CLI command routes

// GET /api/mcp/cli/list - List MCP servers using Claude CLI
router.get('/cli/list', async (req: Request, res: Response): Promise<void> => {
  try {
    console.log('📋 Listing MCP servers using Claude CLI');

    const { spawn } = await import('child_process');
    const { promisify } = await import('util');
    const exec = promisify(spawn);

    const process: ChildProcess = spawn('claude', ['mcp', 'list'], {
      stdio: ['pipe', 'pipe', 'pipe']
    });

    let stdout: string = '';
    let stderr: string = '';

    process.stdout!.on('data', (data: Buffer) => {
      stdout += data.toString();
    });

    process.stderr!.on('data', (data: Buffer) => {
      stderr += data.toString();
    });

    process.on('close', (code: number | null) => {
      if (code === 0) {
        res.json({ success: true, output: stdout, servers: parseClaudeListOutput(stdout) });
      } else {
        console.error('Claude CLI error:', stderr);
        res.status(500).json({ error: 'Claude CLI command failed', details: stderr });
      }
    });

    process.on('error', (error: Error) => {
      console.error('Error running Claude CLI:', error);
      res.status(500).json({ error: 'Failed to run Claude CLI', details: error.message });
    });
  } catch (error) {
    console.error('Error listing MCP servers via CLI:', error);
    res.status(500).json({ error: 'Failed to list MCP servers', details: (error as Error).message });
  }
});

// POST /api/mcp/cli/add - Add MCP server using Claude CLI
router.post('/cli/add', async (req: Request, res: Response): Promise<void> => {
  try {
    const { name, type = 'stdio', command, args = [], url, headers = {}, env = {}, scope = 'user', projectPath } = req.body;

    console.log(`➕ Adding MCP server using Claude CLI (${scope} scope):`, name);

    const { spawn } = await import('child_process');

    let cliArgs: string[] = ['mcp', 'add'];

    // Add scope flag
    cliArgs.push('--scope', scope);

    if (type === 'http') {
      cliArgs.push('--transport', 'http', name, url);
      // Add headers if provided
      Object.entries(headers).forEach(([key, value]) => {
        cliArgs.push('--header', `${key}: ${value}`);
      });
    } else if (type === 'sse') {
      cliArgs.push('--transport', 'sse', name, url);
      // Add headers if provided
      Object.entries(headers).forEach(([key, value]) => {
        cliArgs.push('--header', `${key}: ${value}`);
      });
    } else {
      // stdio (default): claude mcp add --scope user <name> <command> [args...]
      cliArgs.push(name);
      // Add environment variables
      Object.entries(env).forEach(([key, value]) => {
        cliArgs.push('-e', `${key}=${value}`);
      });
      cliArgs.push(command);
      if (args && args.length > 0) {
        cliArgs.push(...args);
      }
    }

    console.log('🔧 Running Claude CLI command:', 'claude', cliArgs.join(' '));

    // For local scope, we need to run the command in the project directory
    const spawnOptions: { stdio: ['pipe', 'pipe', 'pipe']; cwd?: string } = {
      stdio: ['pipe', 'pipe', 'pipe']
    };

    if (scope === 'local' && projectPath) {
      spawnOptions.cwd = projectPath;
      console.log('📁 Running in project directory:', projectPath);
    }

    const process: ChildProcess = spawn('claude', cliArgs, spawnOptions);

    let stdout: string = '';
    let stderr: string = '';

    process.stdout!.on('data', (data: Buffer) => {
      stdout += data.toString();
    });

    process.stderr!.on('data', (data: Buffer) => {
      stderr += data.toString();
    });

    process.on('close', (code: number | null) => {
      if (code === 0) {
        res.json({ success: true, output: stdout, message: `MCP server "${name}" added successfully` });
      } else {
        console.error('Claude CLI error:', stderr);
        res.status(400).json({ error: 'Claude CLI command failed', details: stderr });
      }
    });

    process.on('error', (error: Error) => {
      console.error('Error running Claude CLI:', error);
      res.status(500).json({ error: 'Failed to run Claude CLI', details: error.message });
    });
  } catch (error) {
    console.error('Error adding MCP server via CLI:', error);
    res.status(500).json({ error: 'Failed to add MCP server', details: (error as Error).message });
  }
});

// POST /api/mcp/cli/add-json - Add MCP server using JSON format
router.post('/cli/add-json', async (req: Request, res: Response): Promise<void> => {
  try {
    const { name, jsonConfig, scope = 'user', projectPath } = req.body;

    console.log('➕ Adding MCP server using JSON format:', name);

    // Validate and parse JSON config
    let parsedConfig: Record<string, unknown>;
    try {
      parsedConfig = typeof jsonConfig === 'string' ? JSON.parse(jsonConfig) : jsonConfig;
    } catch (parseError) {
      res.status(400).json({
        error: 'Invalid JSON configuration',
        details: (parseError as Error).message
      });
      return;
    }

    // Validate required fields
    if (!parsedConfig.type) {
      res.status(400).json({
        error: 'Invalid configuration',
        details: 'Missing required field: type'
      });
      return;
    }

    if (parsedConfig.type === 'stdio' && !parsedConfig.command) {
      res.status(400).json({
        error: 'Invalid configuration',
        details: 'stdio type requires a command field'
      });
      return;
    }

    if ((parsedConfig.type === 'http' || parsedConfig.type === 'sse') && !parsedConfig.url) {
      res.status(400).json({
        error: 'Invalid configuration',
        details: `${parsedConfig.type as string} type requires a url field`
      });
      return;
    }

    const { spawn } = await import('child_process');

    // Build the command: claude mcp add-json --scope <scope> <name> '<json>'
    const cliArgs: string[] = ['mcp', 'add-json', '--scope', scope, name];

    // Add the JSON config as a properly formatted string
    const jsonString: string = JSON.stringify(parsedConfig);
    cliArgs.push(jsonString);

    console.log('🔧 Running Claude CLI command:', 'claude', cliArgs[0], cliArgs[1], cliArgs[2], cliArgs[3], cliArgs[4], jsonString);

    // For local scope, we need to run the command in the project directory
    const spawnOptions: { stdio: ['pipe', 'pipe', 'pipe']; cwd?: string } = {
      stdio: ['pipe', 'pipe', 'pipe']
    };

    if (scope === 'local' && projectPath) {
      spawnOptions.cwd = projectPath;
      console.log('📁 Running in project directory:', projectPath);
    }

    const process: ChildProcess = spawn('claude', cliArgs, spawnOptions);

    let stdout: string = '';
    let stderr: string = '';

    process.stdout!.on('data', (data: Buffer) => {
      stdout += data.toString();
    });

    process.stderr!.on('data', (data: Buffer) => {
      stderr += data.toString();
    });

    process.on('close', (code: number | null) => {
      if (code === 0) {
        res.json({ success: true, output: stdout, message: `MCP server "${name}" added successfully via JSON` });
      } else {
        console.error('Claude CLI error:', stderr);
        res.status(400).json({ error: 'Claude CLI command failed', details: stderr });
      }
    });

    process.on('error', (error: Error) => {
      console.error('Error running Claude CLI:', error);
      res.status(500).json({ error: 'Failed to run Claude CLI', details: error.message });
    });
  } catch (error) {
    console.error('Error adding MCP server via JSON:', error);
    res.status(500).json({ error: 'Failed to add MCP server', details: (error as Error).message });
  }
});

// DELETE /api/mcp/cli/remove/:name - Remove MCP server using Claude CLI
router.delete('/cli/remove/:name', async (req: Request, res: Response): Promise<void> => {
  try {
    const { name } = req.params;
    const { scope } = req.query as { scope?: string }; // Get scope from query params

    // Handle the ID format (remove scope prefix if present)
    let actualName: string = name as string;
    let actualScope: string | undefined = scope;

    // If the name includes a scope prefix like "local:test", extract it
    if ((name as string).includes(':')) {
      const [prefix, serverName] = (name as string).split(':');
      actualName = serverName;
      actualScope = actualScope || prefix; // Use prefix as scope if not provided in query
    }

    console.log('🗑️ Removing MCP server using Claude CLI:', actualName, 'scope:', actualScope);

    const { spawn } = await import('child_process');

    // Build command args based on scope
    let cliArgs: string[] = ['mcp', 'remove'];

    // Add scope flag if it's local scope
    if (actualScope === 'local') {
      cliArgs.push('--scope', 'local');
    } else if (actualScope === 'user' || !actualScope) {
      // User scope is default, but we can be explicit
      cliArgs.push('--scope', 'user');
    }

    cliArgs.push(actualName);

    console.log('🔧 Running Claude CLI command:', 'claude', cliArgs.join(' '));

    const process: ChildProcess = spawn('claude', cliArgs, {
      stdio: ['pipe', 'pipe', 'pipe']
    });

    let stdout: string = '';
    let stderr: string = '';

    process.stdout!.on('data', (data: Buffer) => {
      stdout += data.toString();
    });

    process.stderr!.on('data', (data: Buffer) => {
      stderr += data.toString();
    });

    process.on('close', (code: number | null) => {
      if (code === 0) {
        res.json({ success: true, output: stdout, message: `MCP server "${name}" removed successfully` });
      } else {
        console.error('Claude CLI error:', stderr);
        res.status(400).json({ error: 'Claude CLI command failed', details: stderr });
      }
    });

    process.on('error', (error: Error) => {
      console.error('Error running Claude CLI:', error);
      res.status(500).json({ error: 'Failed to run Claude CLI', details: error.message });
    });
  } catch (error) {
    console.error('Error removing MCP server via CLI:', error);
    res.status(500).json({ error: 'Failed to remove MCP server', details: (error as Error).message });
  }
});

// GET /api/mcp/cli/get/:name - Get MCP server details using Claude CLI
router.get('/cli/get/:name', async (req: Request, res: Response): Promise<void> => {
  try {
    const { name } = req.params;

    console.log('📄 Getting MCP server details using Claude CLI:', name);

    const { spawn } = await import('child_process');

    const process: ChildProcess = spawn('claude', ['mcp', 'get', name as string], {
      stdio: ['pipe', 'pipe', 'pipe']
    });

    let stdout: string = '';
    let stderr: string = '';

    process.stdout!.on('data', (data: Buffer) => {
      stdout += data.toString();
    });

    process.stderr!.on('data', (data: Buffer) => {
      stderr += data.toString();
    });

    process.on('close', (code: number | null) => {
      if (code === 0) {
        res.json({ success: true, output: stdout, server: parseClaudeGetOutput(stdout) });
      } else {
        console.error('Claude CLI error:', stderr);
        res.status(404).json({ error: 'Claude CLI command failed', details: stderr });
      }
    });

    process.on('error', (error: Error) => {
      console.error('Error running Claude CLI:', error);
      res.status(500).json({ error: 'Failed to run Claude CLI', details: error.message });
    });
  } catch (error) {
    console.error('Error getting MCP server details via CLI:', error);
    res.status(500).json({ error: 'Failed to get MCP server details', details: (error as Error).message });
  }
});

// GET /api/mcp/config/read - Read MCP servers directly from Claude config files
router.get('/config/read', async (req: Request, res: Response): Promise<void> => {
  try {
    console.log('📖 Reading MCP servers from Claude config files');

    const homeDir: string = os.homedir();
    const configPaths: string[] = [
      path.join(homeDir, '.claude.json'),
      path.join(homeDir, '.claude', 'settings.json')
    ];

    let configData: ClaudeConfigData | null = null;
    let configPath: string | null = null;

    // Try to read from either config file
    for (const filepath of configPaths) {
      try {
        const fileContent: string = await fs.readFile(filepath, 'utf8');
        configData = JSON.parse(fileContent);
        configPath = filepath;
        console.log(`✅ Found Claude config at: ${filepath}`);
        break;
      } catch (error) {
        // File doesn't exist or is not valid JSON, try next
        console.log(`ℹ️ Config not found or invalid at: ${filepath}`);
      }
    }

    if (!configData) {
      res.json({
        success: false,
        message: 'No Claude configuration file found',
        servers: []
      });
      return;
    }

    // Extract MCP servers from the config
    const servers: MCPServer[] = [];

    // Check for user-scoped MCP servers (at root level)
    if (configData.mcpServers && typeof configData.mcpServers === 'object' && Object.keys(configData.mcpServers).length > 0) {
      console.log('🔍 Found user-scoped MCP servers:', Object.keys(configData.mcpServers));
      for (const [name, config] of Object.entries(configData.mcpServers) as [string, Record<string, unknown>][]) {
        const server: MCPServer = {
          id: name,
          name: name,
          type: 'stdio', // Default type
          scope: 'user',  // User scope - available across all projects
          config: {},
          raw: config as Record<string, unknown> // Include raw config for full details
        };

        // Determine transport type and extract config
        if (config.command) {
          server.type = 'stdio';
          server.config.command = config.command as string;
          server.config.args = (config.args as string[]) || [];
          server.config.env = (config.env as Record<string, string>) || {};
        } else if (config.url) {
          server.type = (config.transport as string) || 'http';
          server.config.url = config.url as string;
          server.config.headers = (config.headers as Record<string, string>) || {};
        }

        servers.push(server);
      }
    }

    // Check for local-scoped MCP servers (project-specific)
    const currentProjectPath: string = process.cwd();

    // Check under 'projects' key
    if (configData.projects && configData.projects[currentProjectPath]) {
      const projectConfig = configData.projects[currentProjectPath];
      if (projectConfig.mcpServers && typeof projectConfig.mcpServers === 'object' && Object.keys(projectConfig.mcpServers).length > 0) {
        console.log(`🔍 Found local-scoped MCP servers for ${currentProjectPath}:`, Object.keys(projectConfig.mcpServers));
        for (const [name, config] of Object.entries(projectConfig.mcpServers) as [string, Record<string, unknown>][]) {
          const server: MCPServer = {
            id: `local:${name}`,  // Prefix with scope for uniqueness
            name: name,           // Keep original name
            type: 'stdio', // Default type
            scope: 'local',  // Local scope - only for this project
            projectPath: currentProjectPath,
            config: {},
            raw: config as Record<string, unknown> // Include raw config for full details
          };

          // Determine transport type and extract config
          if (config.command) {
            server.type = 'stdio';
            server.config.command = config.command as string;
            server.config.args = (config.args as string[]) || [];
            server.config.env = (config.env as Record<string, string>) || {};
          } else if (config.url) {
            server.type = (config.transport as string) || 'http';
            server.config.url = config.url as string;
            server.config.headers = (config.headers as Record<string, string>) || {};
          }

          servers.push(server);
        }
      }
    }

    console.log(`📋 Found ${servers.length} MCP servers in config`);

    res.json({
      success: true,
      configPath: configPath,
      servers: servers
    });
  } catch (error) {
    console.error('Error reading Claude config:', error);
    res.status(500).json({
      error: 'Failed to read Claude configuration',
      details: (error as Error).message
    });
  }
});

// Helper functions to parse Claude CLI output
function parseClaudeListOutput(output: string): ParsedServer[] {
  const servers: ParsedServer[] = [];
  const lines: string[] = output.split('\n').filter(line => line.trim());

  for (const line of lines) {
    // Skip the header line
    if (line.includes('Checking MCP server health')) continue;

    // Parse lines like "test: test test - ✗ Failed to connect"
    // or "server-name: command or description - ✓ Connected"
    if (line.includes(':')) {
      const colonIndex: number = line.indexOf(':');
      const name: string = line.substring(0, colonIndex).trim();

      // Skip empty names
      if (!name) continue;

      // Extract the rest after the name
      const rest: string = line.substring(colonIndex + 1).trim();

      // Try to extract description and status
      let description: string = rest;
      let status: string = 'unknown';
      let type: string = 'stdio'; // default type

      // Check for status indicators
      if (rest.includes('✓') || rest.includes('✗')) {
        const statusMatch = rest.match(/(.*?)\s*-\s*([✓✗].*)$/);
        if (statusMatch) {
          description = statusMatch[1].trim();
          status = statusMatch[2].includes('✓') ? 'connected' : 'failed';
        }
      }

      // Try to determine type from description
      if (description.startsWith('http://') || description.startsWith('https://')) {
        type = 'http';
      }

      servers.push({
        name,
        type,
        status: status || 'active',
        description
      });
    }
  }

  console.log('🔍 Parsed Claude CLI servers:', servers);
  return servers;
}

function parseClaudeGetOutput(output: string): ParsedServerDetails {
  // Parse the output from 'claude mcp get <name>' command
  // This is a simple parser - might need adjustment based on actual output format
  try {
    // Try to extract JSON if present
    const jsonMatch = output.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      return JSON.parse(jsonMatch[0]);
    }

    // Otherwise, parse as text
    const server: ParsedServerDetails = { raw_output: output };
    const lines: string[] = output.split('\n');

    for (const line of lines) {
      if (line.includes('Name:')) {
        server.name = line.split(':')[1]?.trim();
      } else if (line.includes('Type:')) {
        server.type = line.split(':')[1]?.trim();
      } else if (line.includes('Command:')) {
        server.command = line.split(':')[1]?.trim();
      } else if (line.includes('URL:')) {
        server.url = line.split(':')[1]?.trim();
      }
    }

    return server;
  } catch (error) {
    return { raw_output: output, parse_error: (error as Error).message };
  }
}

export default router;
