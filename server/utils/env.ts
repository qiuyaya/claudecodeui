const SAFE_ENV_KEYS: string[] = [
  'PATH', 'HOME', 'USER', 'SHELL', 'LANG', 'LC_ALL', 'LC_CTYPE',
  'TERM', 'COLORTERM', 'FORCE_COLOR', 'EDITOR', 'VISUAL',
  'NODE_ENV', 'XDG_RUNTIME_DIR', 'XDG_DATA_HOME', 'XDG_CONFIG_HOME',
  'DISPLAY', 'WAYLAND_DISPLAY', 'TMPDIR', 'TMP', 'TEMP',
  'HOSTNAME', 'LOGNAME', 'PWD', 'OLDPWD',
  // Node/package manager paths
  'NVM_DIR', 'NVM_BIN', 'NVM_INC',
  'VOLTA_HOME', 'FNM_DIR',
  'NPM_CONFIG_PREFIX', 'NPM_CONFIG_CACHE',
  // Project-specific
  'CLAUDE_CLI_PATH',
  // API keys needed by child processes (e.g. claude CLI)
  'ANTHROPIC_API_KEY', 'CLAUDE_API_KEY',
  // Proxy settings
  'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY',
  'http_proxy', 'https_proxy', 'no_proxy',
  // SSH agent for git SSH operations
  'SSH_AUTH_SOCK', 'SSH_AGENT_PID',
  // Windows specific
  'APPDATA', 'LOCALAPPDATA', 'USERPROFILE', 'SYSTEMROOT', 'COMSPEC',
  'PROGRAMFILES', 'COMMONPROGRAMFILES', 'WINDIR',
];

export function getSanitizedEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of SAFE_ENV_KEYS) {
    if (process.env[key]) {
      env[key] = process.env[key] as string;
    }
  }

  // Add terminal-specific defaults (fallback, don't override existing values)
  env.TERM = env.TERM || 'xterm-256color';
  env.COLORTERM = env.COLORTERM || 'truecolor';
  env.FORCE_COLOR = env.FORCE_COLOR || '3';

  return env;
}
