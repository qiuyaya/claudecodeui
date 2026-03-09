import matter from 'gray-matter';
import { promises as fs } from 'fs';
import path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { parse as parseShellCommand } from 'shell-quote';

const execFileAsync = promisify(execFile);

// Configuration
const MAX_INCLUDE_DEPTH: number = 3;
const BASH_TIMEOUT: number = 30000; // 30 seconds
const MAX_ARG_LENGTH: number = 1000; // Maximum length for a single argument
const MAX_COMMAND_LENGTH: number = 10000; // Maximum total command length
const BASH_COMMAND_ALLOWLIST: string[] = [
  'echo',
  'ls',
  'pwd',
  'date',
  'whoami',
  'git',
  'npm',
  'node',
  'cat',
  'grep',
  'find',
  'task-master'
];

export interface ParsedCommand {
  data: Record<string, unknown>;
  content: string;
  raw: string;
}

export interface CommandValidationResult {
  allowed: boolean;
  command: string;
  args: string[];
  error?: string;
}

export interface ProcessBashCommandsOptions {
  cwd?: string;
  timeout?: number;
}

/**
 * Parse a markdown command file and extract frontmatter and content
 * @param content - Raw markdown content
 * @returns Parsed command with data (frontmatter) and content
 */
export function parseCommand(content: string): ParsedCommand {
  try {
    const parsed = matter(content);
    return {
      data: (parsed.data as Record<string, unknown>) || {},
      content: parsed.content || '',
      raw: content
    };
  } catch (error: unknown) {
    throw new Error(`Failed to parse command: ${(error as Error).message}`);
  }
}

/**
 * Replace argument placeholders in content
 * @param content - Content with placeholders
 * @param args - Arguments to replace (string or array)
 * @returns Content with replaced arguments
 */
export function replaceArguments(content: string, args: string | string[] | undefined): string {
  if (!content) return content;

  let result: string = content;

  // Convert args to array if it's a string
  const argsArray: string[] = Array.isArray(args) ? args : (args ? [args] : []);

  // Replace $ARGUMENTS with all arguments joined by space
  const allArgs: string = argsArray.join(' ');
  result = result.replace(/\$ARGUMENTS/g, allArgs);

  // Replace positional arguments $1-$9
  for (let i = 1; i <= 9; i++) {
    const regex = new RegExp(`\\$${i}`, 'g');
    const value: string = argsArray[i - 1] || '';
    result = result.replace(regex, value);
  }

  return result;
}

/**
 * Validate file path to prevent directory traversal
 * @param filePath - Path to validate
 * @param basePath - Base directory path
 * @returns True if path is safe
 */
export function isPathSafe(filePath: string, basePath: string): boolean {
  // NULL byte check
  if (filePath.includes('\0') || basePath.includes('\0')) {
    console.warn('[SECURITY] NULL byte detected in path');
    return false;
  }

  // Check for dangerous path patterns
  const dangerousPatterns: string[] = [
    '../',     // Directory traversal
    '..\\',    // Windows directory traversal
    '~/',      // Home directory expansion
    '~\\',     // Windows home directory
  ];

  for (const pattern of dangerousPatterns) {
    if (filePath.includes(pattern)) {
      console.warn(`[SECURITY] Dangerous path pattern detected: ${pattern}`);
      return false;
    }
  }

  try {
    const resolvedPath: string = path.resolve(basePath, filePath);
    const resolvedBase: string = path.resolve(basePath);
    const relative: string = path.relative(resolvedBase, resolvedPath);

    // Ensure base path ends with separator for prefix matching
    // This prevents '/home/user' from matching '/home/user2/file'
    const normalizedBase: string = resolvedBase.endsWith(path.sep)
      ? resolvedBase
      : resolvedBase + path.sep;

    // Path must be:
    // 1. Not empty (relative must point to something)
    // 2. Not start with '..' (no parent directory access)
    // 3. Not be absolute (must be relative to base)
    // 4. Actually be within the base directory (strict prefix check with separator)
    const isSafe: boolean = (
      relative !== '' &&
      !relative.startsWith('..') &&
      !path.isAbsolute(relative) &&
      (resolvedPath === resolvedBase || resolvedPath.startsWith(normalizedBase))
    );

    if (!isSafe) {
      console.warn('[SECURITY] Path traversal attempt blocked:', filePath);
    }

    return isSafe;
  } catch (error: unknown) {
    console.error('[SECURITY] Path validation error:', (error as Error).message);
    return false;
  }
}

/**
 * Process file includes in content (@filename syntax)
 * @param content - Content with @filename includes
 * @param basePath - Base directory for resolving file paths
 * @param depth - Current recursion depth
 * @returns Content with includes resolved
 */
export async function processFileIncludes(content: string, basePath: string, depth: number = 0): Promise<string> {
  if (!content) return content;

  // Prevent infinite recursion
  if (depth >= MAX_INCLUDE_DEPTH) {
    throw new Error(`Maximum include depth (${MAX_INCLUDE_DEPTH}) exceeded`);
  }

  // Match @filename patterns (at start of line or after whitespace)
  const includePattern: RegExp = /(?:^|\s)@([^\s]+)/gm;
  const matches: RegExpMatchArray[] = [...content.matchAll(includePattern)];

  if (matches.length === 0) {
    return content;
  }

  let result: string = content;

  for (const match of matches) {
    const fullMatch: string = match[0];
    const filename: string = match[1];

    // Security: prevent directory traversal
    if (!isPathSafe(filename, basePath)) {
      throw new Error(`Invalid file path (directory traversal detected): ${filename}`);
    }

    try {
      const filePath: string = path.resolve(basePath, filename);
      const fileContent: string = await fs.readFile(filePath, 'utf-8');

      // Recursively process includes in the included file
      const processedContent: string = await processFileIncludes(fileContent, basePath, depth + 1);

      // Replace the @filename with the file content
      result = result.replace(fullMatch, fullMatch.startsWith(' ') ? ' ' + processedContent : processedContent);
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new Error(`File not found: ${filename}`);
      }
      throw error;
    }
  }

  return result;
}

/**
 * Validate that a command and its arguments are safe
 * @param commandString - Command string to validate
 * @returns Validation result
 */
export function validateCommand(commandString: string): CommandValidationResult {
  const trimmedCommand: string = commandString.trim();
  if (!trimmedCommand) {
    return { allowed: false, command: '', args: [], error: 'Empty command' };
  }

  // Length validation
  if (trimmedCommand.length > MAX_COMMAND_LENGTH) {
    console.warn('[SECURITY] Command too long:', trimmedCommand.length, 'characters');
    return {
      allowed: false,
      command: '',
      args: [],
      error: `Command too long (max ${MAX_COMMAND_LENGTH} characters)`
    };
  }

  // Parse the command using shell-quote to handle quotes properly
  const parsed = parseShellCommand(trimmedCommand);

  // Check for shell operators or control structures
  const hasOperators: boolean = parsed.some((token: unknown) =>
    typeof token === 'object' && token !== null && 'op' in (token as Record<string, unknown>)
  );

  if (hasOperators) {
    return {
      allowed: false,
      command: '',
      args: [],
      error: 'Shell operators (&&, ||, |, ;, etc.) are not allowed'
    };
  }

  // Extract command and args (all should be strings after validation)
  const tokens: string[] = parsed.filter((token: unknown): token is string => typeof token === 'string');

  if (tokens.length === 0) {
    return { allowed: false, command: '', args: [], error: 'No valid command found' };
  }

  const [command, ...args] = tokens;

  // Extract just the command name (remove path if present)
  const commandName: string = path.basename(command);

  // Check if command exactly matches allowlist (no prefix matching)
  const isAllowed: boolean = BASH_COMMAND_ALLOWLIST.includes(commandName);

  if (!isAllowed) {
    console.warn(`[SECURITY] Blocked non-allowlisted command: ${commandName}`);
    return {
      allowed: false,
      command: commandName,
      args,
      error: `Command '${commandName}' is not in the allowlist`
    };
  }

  // Dangerous character detection
  // Only block actual shell metacharacters that could enable command injection
  const dangerousPattern: RegExp = /[;&|`$()<>{}[\]\\]/;

  // Validate arguments
  for (const arg of args) {
    // Length check
    if (arg.length > MAX_ARG_LENGTH) {
      console.warn(`[SECURITY] Argument too long:`, arg.substring(0, 50) + '...');
      return {
        allowed: false,
        command: commandName,
        args,
        error: `Argument too long (max ${MAX_ARG_LENGTH} characters)`
      };
    }

    // Dangerous character check
    if (dangerousPattern.test(arg)) {
      console.warn(`[SECURITY] Dangerous characters in argument:`, arg.substring(0, 50));
      return {
        allowed: false,
        command: commandName,
        args,
        error: `Argument contains dangerous characters: ${arg.substring(0, 50)}${arg.length > 50 ? '...' : ''}`
      };
    }

    // NULL byte check (potential security issue)
    if (arg.includes('\0')) {
      console.warn('[SECURITY] NULL byte detected in argument');
      return {
        allowed: false,
        command: commandName,
        args,
        error: 'NULL bytes not allowed in arguments'
      };
    }

    // Check for command injection attempts via Unicode tricks
    // Some terminals interpret specific Unicode characters as control characters
    if (/[\u0000-\u001F\u007F-\u009F]/.test(arg)) {
      console.warn('[SECURITY] Control characters detected in argument');
      return {
        allowed: false,
        command: commandName,
        args,
        error: 'Control characters not allowed in arguments'
      };
    }
  }

  // Log successful validation (for audit trail)
  console.log(`[AUDIT] Allowed command: ${commandName} with ${args.length} arg(s)`);

  return { allowed: true, command: commandName, args };
}

/**
 * Backward compatibility: Check if command is allowed (deprecated)
 * @deprecated Use validateCommand() instead for better security
 * @param command - Command to validate
 * @returns True if command is allowed
 */
export function isBashCommandAllowed(command: string): boolean {
  const result = validateCommand(command);
  return result.allowed;
}

/**
 * Sanitize bash command output
 * @param output - Raw command output
 * @returns Sanitized output
 */
export function sanitizeOutput(output: string): string {
  if (!output) return '';

  // Remove control characters except \t, \n, \r
  return [...output]
    .filter((ch: string) => {
      const code: number = ch.charCodeAt(0);
      return code === 9  // \t
          || code === 10 // \n
          || code === 13 // \r
          || (code >= 32 && code !== 127);
    })
    .join('');
}

/**
 * Process bash commands in content (!command syntax)
 * @param content - Content with !command syntax
 * @param options - Options for bash execution
 * @returns Content with bash commands executed and replaced
 */
export async function processBashCommands(content: string, options: ProcessBashCommandsOptions = {}): Promise<string> {
  if (!content) return content;

  const { cwd = process.cwd(), timeout = BASH_TIMEOUT } = options;

  // Match !command patterns (at start of line or after whitespace)
  const commandPattern: RegExp = /(?:^|\n)!(.+?)(?=\n|$)/g;
  const matches: RegExpMatchArray[] = [...content.matchAll(commandPattern)];

  if (matches.length === 0) {
    return content;
  }

  let result: string = content;

  for (const match of matches) {
    const fullMatch: string = match[0];
    const commandString: string = match[1].trim();

    // Security: validate command and parse args
    const validation = validateCommand(commandString);

    if (!validation.allowed) {
      throw new Error(`Command not allowed: ${commandString} - ${validation.error}`);
    }

    try {
      // Execute without shell using execFile with parsed args
      const { stdout, stderr } = await execFileAsync(
        validation.command,
        validation.args,
        {
          cwd,
          timeout,
          maxBuffer: 1024 * 1024, // 1MB max output
          shell: false, // IMPORTANT: No shell interpretation
          env: { ...process.env, PATH: process.env.PATH } as NodeJS.ProcessEnv // Inherit PATH for finding commands
        }
      );

      const output: string = sanitizeOutput(stdout || stderr || '');

      // Replace the !command with the output
      result = result.replace(fullMatch, fullMatch.startsWith('\n') ? '\n' + output : output);
    } catch (error: unknown) {
      if ((error as { killed?: boolean }).killed) {
        throw new Error(`Command timeout: ${commandString}`);
      }
      throw new Error(`Command failed: ${commandString} - ${(error as Error).message}`);
    }
  }

  return result;
}
