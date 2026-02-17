import { IS_PLATFORM } from "../constants/config";

// Token refresh state
let isRefreshing = false;
let refreshSubscribers = [];

// Subscribe to token refresh completion
const subscribeTokenRefresh = (callback) => {
  refreshSubscribers.push(callback);
};

// Notify all subscribers when token is refreshed
const onTokenRefreshed = (token) => {
  refreshSubscribers.forEach(callback => callback(token));
  refreshSubscribers = [];
};

// Notify all subscribers that refresh failed
const onTokenRefreshFailed = () => {
  refreshSubscribers.forEach(callback => callback(null));
  refreshSubscribers = [];
};

// Refresh access token using refresh token
const refreshAccessToken = async () => {
  const refreshToken = localStorage.getItem('refresh-token');

  if (!refreshToken) {
    throw new Error('No refresh token available');
  }

  const response = await fetch('/api/auth/refresh', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ refreshToken })
  });

  if (!response.ok) {
    throw new Error('Token refresh failed');
  }

  const data = await response.json();
  if (data.refreshToken) {
    localStorage.setItem('refresh-token', data.refreshToken);
  }
  return data.accessToken;
};

// Utility function for authenticated API calls with automatic token refresh
export const authenticatedFetch = async (url, options = {}) => {
  const token = localStorage.getItem('auth-token');

  const defaultHeaders = {};

  // Only set Content-Type for non-FormData requests
  if (!(options.body instanceof FormData)) {
    defaultHeaders['Content-Type'] = 'application/json';
  }

  if (!IS_PLATFORM && token) {
    defaultHeaders['Authorization'] = `Bearer ${token}`;
  }

  let response = await fetch(url, {
    ...options,
    headers: {
      ...defaultHeaders,
      ...options.headers,
    },
  });

  // Handle token expiration
  if (response.status === 401 && !IS_PLATFORM) {
    try {
      const errorData = await response.clone().json();

      // Check if it's a token expiration error
      if (errorData.code === 'TOKEN_EXPIRED') {
        if (!isRefreshing) {
          isRefreshing = true;

          try {
            // Refresh the token
            const newToken = await refreshAccessToken();
            localStorage.setItem('auth-token', newToken);
            isRefreshing = false;
            onTokenRefreshed(newToken);

            // Retry the original request with new token
            defaultHeaders['Authorization'] = `Bearer ${newToken}`;
            response = await fetch(url, {
              ...options,
              headers: {
                ...defaultHeaders,
                ...options.headers,
              },
            });
          } catch (error) {
            isRefreshing = false;
            onTokenRefreshFailed();
            // Refresh failed, clear tokens and let AuthContext handle redirect
            localStorage.removeItem('auth-token');
            localStorage.removeItem('refresh-token');
            window.dispatchEvent(new Event('auth-token-expired'));
            throw error;
          }
        } else {
          // Wait for the ongoing refresh to complete
          const newToken = await new Promise((resolve) => {
            subscribeTokenRefresh(resolve);
          });

          // If refresh failed, return original response
          if (!newToken) {
            return response;
          }

          // Retry with new token
          defaultHeaders['Authorization'] = `Bearer ${newToken}`;
          response = await fetch(url, {
            ...options,
            headers: {
              ...defaultHeaders,
              ...options.headers,
            },
          });
        }
      }
    } catch (error) {
      // If we can't parse the error or it's not a token error, just return the original response
      if (error.message !== 'Token refresh failed') {
        return response;
      }
    }
  }

  return response;
};

// API endpoints
export const api = {
  // Auth endpoints (no token required)
  auth: {
    status: () => fetch('/api/auth/status'),
    login: (username, password) => fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
    }),
    register: (username, password) => fetch('/api/auth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
    }),
    user: () => authenticatedFetch('/api/auth/user'),
    logout: () => {
      const refreshToken = localStorage.getItem('refresh-token');
      return authenticatedFetch('/api/auth/logout', {
        method: 'POST',
        body: JSON.stringify({ refreshToken }),
      });
    },
    refresh: (refreshToken) => fetch('/api/auth/refresh', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refreshToken }),
    }),
  },

  // Protected endpoints
  // config endpoint removed - no longer needed (frontend uses window.location)
  projects: (limit = 0, offset = 0) => {
    const params = limit > 0 ? `?limit=${limit}&offset=${offset}` : '';
    return authenticatedFetch(`/api/projects${params}`);
  },
  sessions: (projectName, limit = 5, offset = 0) => 
    authenticatedFetch(`/api/projects/${projectName}/sessions?limit=${limit}&offset=${offset}`),
  sessionMessages: (projectName, sessionId, limit = null, offset = 0, provider = 'claude') => {
    const params = new URLSearchParams();
    if (limit !== null) {
      params.append('limit', limit);
      params.append('offset', offset);
    }
    const queryString = params.toString();

    // Route to the correct endpoint based on provider
    let url;
    if (provider === 'codex') {
      url = `/api/codex/sessions/${sessionId}/messages${queryString ? `?${queryString}` : ''}`;
    } else if (provider === 'cursor') {
      url = `/api/cursor/sessions/${sessionId}/messages${queryString ? `?${queryString}` : ''}`;
    } else {
      url = `/api/projects/${projectName}/sessions/${sessionId}/messages${queryString ? `?${queryString}` : ''}`;
    }
    return authenticatedFetch(url);
  },
  renameProject: (projectName, displayName) =>
    authenticatedFetch(`/api/projects/${projectName}/rename`, {
      method: 'PUT',
      body: JSON.stringify({ displayName }),
    }),
  deleteSession: (projectName, sessionId) =>
    authenticatedFetch(`/api/projects/${projectName}/sessions/${sessionId}`, {
      method: 'DELETE',
    }),
  deleteCodexSession: (sessionId) =>
    authenticatedFetch(`/api/codex/sessions/${sessionId}`, {
      method: 'DELETE',
    }),
  deleteProject: (projectName, force = false, preserveSessions = false) => {
    const params = [];
    if (force) params.push('force=true');
    if (preserveSessions) params.push('preserveSessions=true');
    const queryString = params.length > 0 ? `?${params.join('&')}` : '';
    return authenticatedFetch(`/api/projects/${projectName}${queryString}`, {
      method: 'DELETE',
    });
  },
  createProject: (path) =>
    authenticatedFetch('/api/projects/create', {
      method: 'POST',
      body: JSON.stringify({ path }),
    }),
  createWorkspace: (workspaceData) =>
    authenticatedFetch('/api/projects/create-workspace', {
      method: 'POST',
      body: JSON.stringify(workspaceData),
    }),
  readFile: (projectName, filePath) =>
    authenticatedFetch(`/api/projects/${projectName}/file?filePath=${encodeURIComponent(filePath)}`),
  saveFile: (projectName, filePath, content) =>
    authenticatedFetch(`/api/projects/${projectName}/file`, {
      method: 'PUT',
      body: JSON.stringify({ filePath, content }),
    }),
  getFiles: (projectName) =>
    authenticatedFetch(`/api/projects/${projectName}/files`),
  transcribe: (formData) =>
    authenticatedFetch('/api/transcribe', {
      method: 'POST',
      body: formData,
      headers: {}, // Let browser set Content-Type for FormData
    }),

  // TaskMaster endpoints
  taskmaster: {
    // Initialize TaskMaster in a project
    init: (projectName) => 
      authenticatedFetch(`/api/taskmaster/init/${projectName}`, {
        method: 'POST',
      }),
    
    // Add a new task
    addTask: (projectName, { prompt, title, description, priority, dependencies }) =>
      authenticatedFetch(`/api/taskmaster/add-task/${projectName}`, {
        method: 'POST',
        body: JSON.stringify({ prompt, title, description, priority, dependencies }),
      }),
    
    // Parse PRD to generate tasks
    parsePRD: (projectName, { fileName, numTasks, append }) =>
      authenticatedFetch(`/api/taskmaster/parse-prd/${projectName}`, {
        method: 'POST',
        body: JSON.stringify({ fileName, numTasks, append }),
      }),

    // Get available PRD templates
    getTemplates: () =>
      authenticatedFetch('/api/taskmaster/prd-templates'),

    // Apply a PRD template
    applyTemplate: (projectName, { templateId, fileName, customizations }) =>
      authenticatedFetch(`/api/taskmaster/apply-template/${projectName}`, {
        method: 'POST',
        body: JSON.stringify({ templateId, fileName, customizations }),
      }),

    // Update a task
    updateTask: (projectName, taskId, updates) =>
      authenticatedFetch(`/api/taskmaster/update-task/${projectName}/${taskId}`, {
        method: 'PUT',
        body: JSON.stringify(updates),
      }),
  },
  
  // Browse filesystem for project suggestions
  browseFilesystem: (dirPath = null) => {
    const params = new URLSearchParams();
    if (dirPath) params.append('path', dirPath);

    return authenticatedFetch(`/api/browse-filesystem?${params}`);
  },

  createFolder: (folderPath) =>
    authenticatedFetch('/api/create-folder', {
      method: 'POST',
      body: JSON.stringify({ path: folderPath }),
    }),

  // User endpoints
  user: {
    gitConfig: () => authenticatedFetch('/api/user/git-config'),
    updateGitConfig: (gitName, gitEmail) =>
      authenticatedFetch('/api/user/git-config', {
        method: 'POST',
        body: JSON.stringify({ gitName, gitEmail }),
      }),
    onboardingStatus: () => authenticatedFetch('/api/user/onboarding-status'),
    completeOnboarding: () =>
      authenticatedFetch('/api/user/complete-onboarding', {
        method: 'POST',
      }),
  },

  // Generic GET method for any endpoint
  get: (endpoint) => authenticatedFetch(`/api${endpoint}`),
};