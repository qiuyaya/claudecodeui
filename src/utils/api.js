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

// Request cache for GET requests (stores parsed JSON, not Response objects)
const requestCache = new Map();
const DEFAULT_CACHE_TTL = 30000; // 30 seconds default

// Per-endpoint cache TTL overrides (longer TTL for infrequently changing data)
// Order: most specific prefixes first — getCacheTTL matches the first entry
const CACHE_TTL_OVERRIDES = [
  ['/api/codex/sessions', 15000],     // 15 seconds for session messages (dynamic data)
  ['/api/cursor/sessions', 15000],
  ['/api/gemini/sessions', 15000],
  ['/api/projects/create', 0],        // no cache for mutations via GET
  ['/api/projects/', 15000],          // 15 seconds for project sub-resources
  ['/api/projects', 300000],          // 5 minutes - project list changes rarely
  ['/api/auth/status', 120000],       // 2 minutes
  ['/api/auth/user', 120000],         // 2 minutes
  ['/api/user/git-config', 300000],   // 5 minutes
  ['/api/user/onboarding-status', 300000],
  ['/api/taskmaster/prd-templates', 600000], // 10 minutes
  ['/api/browse-filesystem', 60000],  // 1 minute
];

const getCacheTTL = (url) => {
  const basePath = url.split('?')[0];
  for (const [prefix, ttl] of CACHE_TTL_OVERRIDES) {
    if (prefix.endsWith('/')) {
      // Trailing-slash prefix: only match sub-paths (not the bare path)
      if (basePath.startsWith(prefix)) return ttl;
    } else {
      if (basePath === prefix || basePath.startsWith(prefix + '/')) return ttl;
    }
  }
  return DEFAULT_CACHE_TTL;
};

const getCached = (key) => {
  const entry = requestCache.get(key);
  if (entry && Date.now() - entry.timestamp < getCacheTTL(key)) {
    return { data: entry.data, isStale: false };
  }
  // Stale-while-revalidate: return stale data with flag
  if (entry) {
    return { data: entry.data, isStale: true };
  }
  requestCache.delete(key);
  return null;
};

const setCache = (key, data) => {
  requestCache.set(key, { data, timestamp: Date.now() });
  // Prevent cache from growing unbounded
  if (requestCache.size > 100) {
    const oldestKey = requestCache.keys().next().value;
    requestCache.delete(oldestKey);
  }
};

const invalidateCacheForUrl = (mutationUrl) => {
  // Extract the path without query string for matching
  const basePath = mutationUrl.split('?')[0];
  for (const key of requestCache.keys()) {
    // Only invalidate if paths share the same base endpoint
    if (key.split('?')[0] === basePath) {
      requestCache.delete(key);
    }
  }
};

// Expose cache invalidation for WebSocket-driven updates
export const invalidateApiCache = (pattern) => {
  if (!pattern) {
    requestCache.clear();
    return;
  }
  for (const key of requestCache.keys()) {
    if (key.includes(pattern)) {
      requestCache.delete(key);
    }
  }
};

// Request deduplication for in-flight requests
const inflightRequests = new Map();

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
  // Add timeout control (default 30s, 0 to disable)
  const timeout = options.timeout ?? 30000;
  let controller;
  let timeoutId;

  if (timeout > 0 && !options.signal) {
    controller = new AbortController();
    timeoutId = setTimeout(() => controller.abort(), timeout);
  }

  const token = localStorage.getItem('auth-token');

  const defaultHeaders = {};

  // Only set Content-Type for non-FormData requests
  if (!(options.body instanceof FormData)) {
    defaultHeaders['Content-Type'] = 'application/json';
  }

  if (!IS_PLATFORM && token) {
    defaultHeaders['Authorization'] = `Bearer ${token}`;
  }

  const fetchSignal = controller?.signal ?? options.signal;

  try {
    let response = await fetch(url, {
      ...options,
      ...(fetchSignal ? { signal: fetchSignal } : {}),
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
                ...(fetchSignal ? { signal: fetchSignal } : {}),
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
              ...(fetchSignal ? { signal: fetchSignal } : {}),
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
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
};

const cachedFetch = async (url, options = {}) => {
  const method = (options.method || 'GET').toUpperCase();

  // Only cache GET requests
  if (method !== 'GET') {
    invalidateCacheForUrl(url);
    return authenticatedFetch(url, options);
  }

  // Check cache first
  const cached = getCached(url);
  if (cached !== null && !cached.isStale) {
    // Fresh cache hit — return immediately
    return new Response(JSON.stringify(cached.data), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // Stale-while-revalidate: return stale data immediately, revalidate in background.
  // Note: the caller receives stale data; the background fetch only updates the cache
  // so the *next* request will get fresh data. No push notification to current consumers.
  if (cached !== null && cached.isStale) {
    // Fire background revalidation (don't await)
    if (!inflightRequests.has(url)) {
      const revalidate = authenticatedFetch(url, options).then(async (response) => {
        inflightRequests.delete(url);
        if (response.ok) {
          try {
            const cloned = response.clone();
            const json = await cloned.json();
            setCache(url, json);
          } catch { /* skip */ }
        }
        return response;
      }).catch(() => {
        inflightRequests.delete(url);
        // Background revalidation failed silently; stale cache remains
      });
      inflightRequests.set(url, revalidate);
    }

    // Return stale data immediately
    return new Response(JSON.stringify(cached.data), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // Deduplicate in-flight requests
  if (inflightRequests.has(url)) {
    // Clone the result so each caller gets their own consumable Response
    return inflightRequests.get(url).then(r => r.clone());
  }

  const requestPromise = authenticatedFetch(url, options).then(async (response) => {
    inflightRequests.delete(url);
    // Cache parsed JSON for successful responses
    if (response.ok) {
      try {
        const cloned = response.clone();
        const json = await cloned.json();
        setCache(url, json);
      } catch {
        // Response is not JSON — skip caching
      }
    }
    return response;
  }).catch(err => {
    inflightRequests.delete(url);
    throw err;
  });

  inflightRequests.set(url, requestPromise);
  return requestPromise;
};

// API endpoints
export const api = {
  // Auth endpoints (no token required)
  auth: {
    status: () => cachedFetch('/api/auth/status'),
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
    user: () => cachedFetch('/api/auth/user'),
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
    return cachedFetch(`/api/projects${params}`);
  },
  sessions: (projectName, limit = 5, offset = 0) =>
    cachedFetch(`/api/projects/${projectName}/sessions?limit=${limit}&offset=${offset}`),
  sessionMessages: (projectName, sessionId, limit = null, offset = 0, provider = 'claude') => {
    const params = new URLSearchParams();
    if (limit !== null) {
      params.append('limit', limit);
      params.append('offset', offset);
    }
    const queryString = params.toString();

    let url;
    if (provider === 'codex') {
      url = `/api/codex/sessions/${sessionId}/messages${queryString ? `?${queryString}` : ''}`;
    } else if (provider === 'cursor') {
      url = `/api/cursor/sessions/${sessionId}/messages${queryString ? `?${queryString}` : ''}`;
    } else if (provider === 'gemini') {
      url = `/api/gemini/sessions/${sessionId}/messages${queryString ? `?${queryString}` : ''}`;
    } else {
      url = `/api/projects/${projectName}/sessions/${sessionId}/messages${queryString ? `?${queryString}` : ''}`;
    }
    // Use cachedFetch for session messages - stale-while-revalidate ensures
    // fresh data on next request while returning cached data instantly
    return cachedFetch(url);
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
  renameSession: (sessionId, summary, provider) =>
    authenticatedFetch(`/api/sessions/${sessionId}/rename`, {
      method: 'PUT',
      body: JSON.stringify({ summary, provider }),
    }),
  deleteCodexSession: (sessionId) =>
    authenticatedFetch(`/api/codex/sessions/${sessionId}`, {
      method: 'DELETE',
    }),
  deleteGeminiSession: (sessionId) =>
    authenticatedFetch(`/api/gemini/sessions/${sessionId}`, {
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
  searchConversationsUrl: (query, limit = 50) => {
    const token = localStorage.getItem('auth-token');
    const params = new URLSearchParams({ q: query, limit: String(limit) });
    if (token) params.set('token', token);
    return `/api/search/conversations?${params.toString()}`;
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
    cachedFetch(`/api/projects/${projectName}/file?filePath=${encodeURIComponent(filePath)}`),
  saveFile: (projectName, filePath, content) =>
    authenticatedFetch(`/api/projects/${projectName}/file`, {
      method: 'PUT',
      body: JSON.stringify({ filePath, content }),
    }),
  getFiles: (projectName, options = {}) =>
    cachedFetch(`/api/projects/${projectName}/files`, options),

  // File operations
  createFile: (projectName, { path, type, name }) =>
    authenticatedFetch(`/api/projects/${projectName}/files/create`, {
      method: 'POST',
      body: JSON.stringify({ path, type, name }),
    }),

  renameFile: (projectName, { oldPath, newName }) =>
    authenticatedFetch(`/api/projects/${projectName}/files/rename`, {
      method: 'PUT',
      body: JSON.stringify({ oldPath, newName }),
    }),

  deleteFile: (projectName, { path, type }) =>
    authenticatedFetch(`/api/projects/${projectName}/files`, {
      method: 'DELETE',
      body: JSON.stringify({ path, type }),
    }),

  uploadFiles: (projectName, formData) =>
    authenticatedFetch(`/api/projects/${projectName}/files/upload`, {
      method: 'POST',
      body: formData,
      headers: {}, // Let browser set Content-Type for FormData
    }),

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
      cachedFetch('/api/taskmaster/prd-templates'),

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

    return cachedFetch(`/api/browse-filesystem?${params}`);
  },

  createFolder: (folderPath) =>
    authenticatedFetch('/api/create-folder', {
      method: 'POST',
      body: JSON.stringify({ path: folderPath }),
    }),

  // User endpoints
  user: {
    gitConfig: () => cachedFetch('/api/user/git-config'),
    updateGitConfig: (gitName, gitEmail) =>
      authenticatedFetch('/api/user/git-config', {
        method: 'POST',
        body: JSON.stringify({ gitName, gitEmail }),
      }),
    onboardingStatus: () => cachedFetch('/api/user/onboarding-status'),
    completeOnboarding: () =>
      authenticatedFetch('/api/user/complete-onboarding', {
        method: 'POST',
      }),
  },

  // Generic GET method for any endpoint
  get: (endpoint) => cachedFetch(`/api${endpoint}`),

  // Generic POST method for any endpoint
  post: (endpoint, body) => authenticatedFetch(`/api${endpoint}`, {
    method: 'POST',
    ...(body instanceof FormData ? { body } : { body: JSON.stringify(body) }),
  }),

  // Generic PUT method for any endpoint
  put: (endpoint, body) => authenticatedFetch(`/api${endpoint}`, {
    method: 'PUT',
    body: JSON.stringify(body),
  }),

  // Generic DELETE method for any endpoint
  delete: (endpoint, options = {}) => authenticatedFetch(`/api${endpoint}`, {
    method: 'DELETE',
    ...options,
  }),
};