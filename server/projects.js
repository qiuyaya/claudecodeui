/**
 * PROJECT DISCOVERY AND MANAGEMENT SYSTEM
 * ========================================
 * 
 * This module manages project discovery for both Claude CLI and Cursor CLI sessions.
 * 
 * ## Architecture Overview
 * 
 * 1. **Claude Projects** (stored in ~/.claude/projects/)
 *    - Each project is a directory named with the project path encoded (/ replaced with -)
 *    - Contains .jsonl files with conversation history including 'cwd' field
 *    - Project metadata stored in ~/.claude/project-config.json
 * 
 * 2. **Cursor Projects** (stored in ~/.cursor/chats/)
 *    - Each project directory is named with MD5 hash of the absolute project path
 *    - Example: /Users/john/myproject -> MD5 -> a1b2c3d4e5f6...
 *    - Contains session directories with SQLite databases (store.db)
 *    - Project path is NOT stored in the database - only in the MD5 hash
 * 
 * ## Project Discovery Strategy
 * 
 * 1. **Claude Projects Discovery**:
 *    - Scan ~/.claude/projects/ directory for Claude project folders
 *    - Extract actual project path from .jsonl files (cwd field)
 *    - Fall back to decoded directory name if no sessions exist
 * 
 * 2. **Cursor Sessions Discovery**:
 *    - For each KNOWN project (from Claude or manually added)
 *    - Compute MD5 hash of the project's absolute path
 *    - Check if ~/.cursor/chats/{md5_hash}/ directory exists
 *    - Read session metadata from SQLite store.db files
 * 
 * 3. **Manual Project Addition**:
 *    - Users can manually add project paths via UI
 *    - Stored in ~/.claude/project-config.json with 'manuallyAdded' flag
 *    - Allows discovering Cursor sessions for projects without Claude sessions
 * 
 * ## Critical Limitations
 * 
 * - **CANNOT discover Cursor-only projects**: From a quick check, there was no mention of
 *   the cwd of each project. if someone has the time, you can try to reverse engineer it.
 * 
 * - **Project relocation breaks history**: If a project directory is moved or renamed,
 *   the MD5 hash changes, making old Cursor sessions inaccessible unless the old
 *   path is known and manually added.
 * 
 * ## Error Handling
 * 
 * - Missing ~/.claude directory is handled gracefully with automatic creation
 * - ENOENT errors are caught and handled without crashing
 * - Empty arrays returned when no projects/sessions exist
 * 
 * ## Caching Strategy
 * 
 * - Project directory extraction is cached to minimize file I/O
 * - Cache is cleared when project configuration changes
 * - Session data is fetched on-demand, not cached
 */

import { promises as fs } from 'fs';
import fsSync from 'fs';
import path from 'path';
import readline from 'readline';
import crypto from 'crypto';
import os from 'os';
import { detectTaskMasterFolder } from './services/taskmaster-detector.js';
import { getCursorSessions } from './services/cursor-sessions.js';
import { getCodexSessions, getCodexSessionMessages, deleteCodexSession } from './services/codex-sessions.js';

// Cache for extracted project directories
const projectDirectoryCache = new Map();

// Clear cache when needed (called when project files change)
function clearProjectDirectoryCache() {
  projectDirectoryCache.clear();
}

// Load project configuration file
async function loadProjectConfig() {
  const configPath = path.join(os.homedir(), '.claude', 'project-config.json');
  try {
    const configData = await fs.readFile(configPath, 'utf8');
    return JSON.parse(configData);
  } catch (error) {
    // Return empty config if file doesn't exist
    return {};
  }
}

// Save project configuration file
async function saveProjectConfig(config) {
  const claudeDir = path.join(os.homedir(), '.claude');
  const configPath = path.join(claudeDir, 'project-config.json');
  
  // Ensure the .claude directory exists
  try {
    await fs.mkdir(claudeDir, { recursive: true });
  } catch (error) {
    if (error.code !== 'EEXIST') {
      throw error;
    }
  }
  
  await fs.writeFile(configPath, JSON.stringify(config, null, 2), 'utf8');
}

// Generate better display name from path
async function generateDisplayName(projectName, actualProjectDir = null) {
  // Use actual project directory if provided, otherwise decode from project name
  let projectPath = actualProjectDir || projectName.replace(/-/g, '/');
  
  // Try to read package.json from the project path
  try {
    const packageJsonPath = path.join(projectPath, 'package.json');
    const packageData = await fs.readFile(packageJsonPath, 'utf8');
    const packageJson = JSON.parse(packageData);
    
    // Return the name from package.json if it exists
    if (packageJson.name) {
      return packageJson.name;
    }
  } catch (error) {
    // Fall back to path-based naming if package.json doesn't exist or can't be read
  }
  
  // If it starts with /, it's an absolute path
  if (projectPath.startsWith('/')) {
    const parts = projectPath.split('/').filter(Boolean);
    // Return only the last folder name
    return parts[parts.length - 1] || projectPath;
  }
  
  return projectPath;
}

// Extract the actual project directory from JSONL sessions (with caching)
async function extractProjectDirectory(projectName, configOverride = null) {
  // Check cache first
  if (projectDirectoryCache.has(projectName)) {
    return projectDirectoryCache.get(projectName);
  }

  // Check project config for originalPath (manually added projects via UI or platform)
  // This handles projects with dashes in their directory names correctly
  const config = configOverride || await loadProjectConfig();
  if (config[projectName]?.originalPath) {
    const originalPath = config[projectName].originalPath;
    projectDirectoryCache.set(projectName, originalPath);
    return originalPath;
  }

  const projectDir = path.join(os.homedir(), '.claude', 'projects', projectName);
  let extractedPath;

  try {
    // Check if the project directory exists
    await fs.access(projectDir);

    const files = await fs.readdir(projectDir);
    const jsonlFiles = files.filter(file => file.endsWith('.jsonl'));

    if (jsonlFiles.length === 0) {
      // Fall back to decoded project name if no sessions
      extractedPath = projectName.replace(/-/g, '/');
    } else {
      // Only read the first few lines of the most recent JSONL file to find cwd
      // Sort by filename (UUID-based, so pick the last one or use file stats)
      let targetFile = jsonlFiles[0];

      // Try to find the most recently modified file without reading all of them
      if (jsonlFiles.length > 1) {
        let latestMtime = 0;
        for (const file of jsonlFiles) {
          try {
            const stat = await fs.stat(path.join(projectDir, file));
            if (stat.mtimeMs > latestMtime) {
              latestMtime = stat.mtimeMs;
              targetFile = file;
            }
          } catch { /* skip */ }
        }
      }

      // Read only the first lines to find cwd (typically in the first entry)
      const jsonlFile = path.join(projectDir, targetFile);
      const cwd = await extractCwdFromFile(jsonlFile);

      if (cwd) {
        extractedPath = cwd;
      } else {
        // Fall back to decoded project name
        extractedPath = projectName.replace(/-/g, '/');
      }
    }

    // Cache the result
    projectDirectoryCache.set(projectName, extractedPath);

    return extractedPath;

  } catch (error) {
    // If the directory doesn't exist, just use the decoded project name
    if (error.code !== 'ENOENT') {
      console.error(`Error extracting project directory for ${projectName}:`, error);
    }
    extractedPath = projectName.replace(/-/g, '/');

    // Cache the fallback result too
    projectDirectoryCache.set(projectName, extractedPath);

    return extractedPath;
  }
}

// Read only the first N lines of a JSONL file to extract cwd
async function extractCwdFromFile(filePath, maxLines = 20) {
  return new Promise((resolve) => {
    const fileStream = fsSync.createReadStream(filePath, { encoding: 'utf8' });
    const rl = readline.createInterface({
      input: fileStream,
      crlfDelay: Infinity
    });

    let linesRead = 0;
    let foundCwd = null;

    rl.on('line', (line) => {
      linesRead++;
      if (line.trim()) {
        try {
          const entry = JSON.parse(line);
          if (entry.cwd) {
            foundCwd = entry.cwd;
            rl.close();
            fileStream.destroy();
            return;
          }
        } catch { /* skip malformed lines */ }
      }
      if (linesRead >= maxLines) {
        rl.close();
        fileStream.destroy();
      }
    });

    rl.on('close', () => resolve(foundCwd));
    rl.on('error', () => resolve(null));
    fileStream.on('error', () => resolve(null));
  });
}

async function getProjects(progressCallback = null) {
  const claudeDir = path.join(os.homedir(), '.claude', 'projects');
  const config = await loadProjectConfig();
  const projects = [];
  const existingProjects = new Set();
  let totalProjects = 0;
  let processedProjects = 0;
  let directories = [];

  try {
    // Check if the .claude/projects directory exists
    await fs.access(claudeDir);

    // First, get existing Claude projects from the file system
    const entries = await fs.readdir(claudeDir, { withFileTypes: true });
    directories = entries.filter(e => e.isDirectory());

    // Build set of existing project names for later
    directories.forEach(e => existingProjects.add(e.name));

    // Count manual projects not already in directories
    const manualProjectsCount = Object.entries(config)
      .filter(([name, cfg]) => cfg.manuallyAdded && !existingProjects.has(name))
      .length;

    totalProjects = directories.length + manualProjectsCount;

    // Process projects in parallel with concurrency limit
    const CONCURRENCY = 20;
    const processProject = async (entry) => {
        const actualProjectDir = await extractProjectDirectory(entry.name, config);

        const customName = config[entry.name]?.displayName;
        const autoDisplayName = await generateDisplayName(entry.name, actualProjectDir);

        const project = {
          name: entry.name,
          path: actualProjectDir,
          displayName: customName || autoDisplayName,
          fullPath: actualProjectDir,
          isCustomName: !!customName,
          sessions: []
        };

        // Run session and detection queries in parallel (load first 5 sessions for accurate count)
        const [sessionsResult, cursorSessions, codexSessions, taskMasterResult] = await Promise.allSettled([
          getSessions(entry.name, 5, 0),
          getCursorSessions(actualProjectDir),
          getCodexSessions(actualProjectDir),
          detectTaskMasterFolder(actualProjectDir)
        ]);

        if (sessionsResult.status === 'fulfilled') {
          project.sessions = sessionsResult.value.sessions || [];
          project.sessionMeta = {
            hasMore: sessionsResult.value.hasMore || false,
            total: sessionsResult.value.total || 0,
            lastActivity: project.sessions.length > 0 ? project.sessions[0].lastActivity : null
          };
        }

        project.cursorSessions = cursorSessions.status === 'fulfilled' ? cursorSessions.value : [];
        project.codexSessions = codexSessions.status === 'fulfilled' ? codexSessions.value : [];

        if (taskMasterResult.status === 'fulfilled') {
          const tm = taskMasterResult.value;
          project.taskmaster = {
            hasTaskmaster: tm.hasTaskmaster,
            hasEssentialFiles: tm.hasEssentialFiles,
            metadata: tm.metadata,
            status: tm.hasTaskmaster && tm.hasEssentialFiles ? 'configured' : 'not-configured'
          };
        } else {
          project.taskmaster = { hasTaskmaster: false, hasEssentialFiles: false, metadata: null, status: 'error' };
        }

        return project;
    };

    // Process in batches to limit concurrency
    for (let i = 0; i < directories.length; i += CONCURRENCY) {
      const batch = directories.slice(i, i + CONCURRENCY);
      const results = await Promise.all(batch.map(entry => processProject(entry)));
      projects.push(...results);

      processedProjects += batch.length;
      if (progressCallback) {
        progressCallback({
          phase: 'loading',
          current: processedProjects,
          total: totalProjects,
          currentProject: batch[batch.length - 1].name
        });
      }
    }
  } catch (error) {
    // If the directory doesn't exist (ENOENT), that's okay - just continue with empty projects
    if (error.code !== 'ENOENT') {
      console.error('Error reading projects directory:', error);
    }
    // Calculate total for manual projects only (no directories exist)
    totalProjects = Object.entries(config)
      .filter(([name, cfg]) => cfg.manuallyAdded)
      .length;
  }
  
  // Add manually configured projects that don't exist as folders yet
  for (const [projectName, projectConfig] of Object.entries(config)) {
    if (!existingProjects.has(projectName) && projectConfig.manuallyAdded) {
      processedProjects++;

      // Emit progress for manual projects
      if (progressCallback) {
        progressCallback({
          phase: 'loading',
          current: processedProjects,
          total: totalProjects,
          currentProject: projectName
        });
      }

      // Use the original path if available, otherwise extract from potential sessions
      let actualProjectDir = projectConfig.originalPath;
      
      if (!actualProjectDir) {
        try {
          actualProjectDir = await extractProjectDirectory(projectName);
        } catch (error) {
          // Fall back to decoded project name
          actualProjectDir = projectName.replace(/-/g, '/');
        }
      }
      
              const project = {
          name: projectName,
          path: actualProjectDir,
          displayName: projectConfig.displayName || await generateDisplayName(projectName, actualProjectDir),
          fullPath: actualProjectDir,
          isCustomName: !!projectConfig.displayName,
          isManuallyAdded: true,
          sessions: [],
          cursorSessions: [],
          codexSessions: []
        };

      // Try to fetch Cursor sessions for manual projects too
      try {
        project.cursorSessions = await getCursorSessions(actualProjectDir);
      } catch (e) {
        console.warn(`Could not load Cursor sessions for manual project ${projectName}:`, e.message);
      }

      // Try to fetch Codex sessions for manual projects too
      try {
        project.codexSessions = await getCodexSessions(actualProjectDir);
      } catch (e) {
        console.warn(`Could not load Codex sessions for manual project ${projectName}:`, e.message);
      }

      // Add TaskMaster detection for manual projects
      try {
        const taskMasterResult = await detectTaskMasterFolder(actualProjectDir);
        
        // Determine TaskMaster status
        let taskMasterStatus = 'not-configured';
        if (taskMasterResult.hasTaskmaster && taskMasterResult.hasEssentialFiles) {
          taskMasterStatus = 'taskmaster-only'; // We don't check MCP for manual projects in bulk
        }
        
        project.taskmaster = {
          status: taskMasterStatus,
          hasTaskmaster: taskMasterResult.hasTaskmaster,
          hasEssentialFiles: taskMasterResult.hasEssentialFiles,
          metadata: taskMasterResult.metadata
        };
      } catch (error) {
        console.warn(`TaskMaster detection failed for manual project ${projectName}:`, error.message);
        project.taskmaster = {
          status: 'error',
          hasTaskmaster: false,
          hasEssentialFiles: false,
          error: error.message
        };
      }
      
      projects.push(project);
    }
  }

  // Emit completion after all projects (including manual) are processed
  if (progressCallback) {
    progressCallback({
      phase: 'complete',
      current: totalProjects,
      total: totalProjects
    });
  }

  return projects;
}

// Lightweight session metadata for project list (no JSONL parsing)
async function getSessionsMeta(projectName) {
  const projectDir = path.join(os.homedir(), '.claude', 'projects', projectName);
  try {
    const files = await fs.readdir(projectDir);
    const jsonlFiles = files.filter(file => file.endsWith('.jsonl') && !file.startsWith('agent-'));
    if (jsonlFiles.length === 0) {
      return { total: 0, lastActivity: null };
    }
    // Get the most recent file's mtime as lastActivity
    let latestMtime = 0;
    for (const file of jsonlFiles) {
      try {
        const stat = await fs.stat(path.join(projectDir, file));
        if (stat.mtimeMs > latestMtime) latestMtime = stat.mtimeMs;
      } catch { /* skip */ }
    }
    return { total: jsonlFiles.length, lastActivity: latestMtime ? new Date(latestMtime) : null };
  } catch {
    return { total: 0, lastActivity: null };
  }
}

async function getSessions(projectName, limit = 5, offset = 0) {
  const projectDir = path.join(os.homedir(), '.claude', 'projects', projectName);

  try {
    const files = await fs.readdir(projectDir);
    // agent-*.jsonl files contain session start data at this point. This needs to be revisited
    // periodically to make sure only accurate data is there and no new functionality is added there
    const jsonlFiles = files.filter(file => file.endsWith('.jsonl') && !file.startsWith('agent-'));
    
    if (jsonlFiles.length === 0) {
      return { sessions: [], hasMore: false, total: 0 };
    }
    
    // Sort files by modification time (newest first)
    const filesWithStats = await Promise.all(
      jsonlFiles.map(async (file) => {
        const filePath = path.join(projectDir, file);
        const stats = await fs.stat(filePath);
        return { file, mtime: stats.mtime };
      })
    );
    filesWithStats.sort((a, b) => b.mtime - a.mtime);
    
    const allSessions = new Map();
    const allEntries = [];
    const uuidToSessionMap = new Map();
    
    // Collect all sessions and entries from all files
    for (const { file } of filesWithStats) {
      const jsonlFile = path.join(projectDir, file);
      const result = await parseJsonlSessions(jsonlFile);
      
      result.sessions.forEach(session => {
        if (!allSessions.has(session.id)) {
          allSessions.set(session.id, session);
        }
      });
      
      allEntries.push(...result.entries);
      
      // Early exit optimization for large projects
      if (allSessions.size >= (limit + offset) * 2 && allEntries.length >= Math.min(3, filesWithStats.length)) {
        break;
      }
    }
    
    // Build UUID-to-session mapping for timeline detection
    allEntries.forEach(entry => {
      if (entry.uuid && entry.sessionId) {
        uuidToSessionMap.set(entry.uuid, entry.sessionId);
      }
    });
    
    // Group sessions by first user message ID
    const sessionGroups = new Map(); // firstUserMsgId -> { latestSession, allSessions[] }
    const sessionToFirstUserMsgId = new Map(); // sessionId -> firstUserMsgId

    // Find the first user message for each session
    allEntries.forEach(entry => {
      if (entry.sessionId && entry.type === 'user' && entry.parentUuid === null && entry.uuid) {
        // This is a first user message in a session (parentUuid is null)
        const firstUserMsgId = entry.uuid;

        if (!sessionToFirstUserMsgId.has(entry.sessionId)) {
          sessionToFirstUserMsgId.set(entry.sessionId, firstUserMsgId);

          const session = allSessions.get(entry.sessionId);
          if (session) {
            if (!sessionGroups.has(firstUserMsgId)) {
              sessionGroups.set(firstUserMsgId, {
                latestSession: session,
                allSessions: [session]
              });
            } else {
              const group = sessionGroups.get(firstUserMsgId);
              group.allSessions.push(session);

              // Update latest session if this one is more recent
              if (new Date(session.lastActivity) > new Date(group.latestSession.lastActivity)) {
                group.latestSession = session;
              }
            }
          }
        }
      }
    });

    // Collect all sessions that don't belong to any group (standalone sessions)
    const groupedSessionIds = new Set();
    sessionGroups.forEach(group => {
      group.allSessions.forEach(session => groupedSessionIds.add(session.id));
    });

    const standaloneSessionsArray = Array.from(allSessions.values())
      .filter(session => !groupedSessionIds.has(session.id));

    // Combine grouped sessions (only show latest from each group) + standalone sessions
    const latestFromGroups = Array.from(sessionGroups.values()).map(group => {
      const session = { ...group.latestSession };
      // Add metadata about grouping
      if (group.allSessions.length > 1) {
        session.isGrouped = true;
        session.groupSize = group.allSessions.length;
        session.groupSessions = group.allSessions.map(s => s.id);
      }
      return session;
    });
    const visibleSessions = [...latestFromGroups, ...standaloneSessionsArray]
      .filter(session => !session.summary.startsWith('{ "'))
      .sort((a, b) => new Date(b.lastActivity) - new Date(a.lastActivity));

    const total = visibleSessions.length;
    const paginatedSessions = visibleSessions.slice(offset, offset + limit);
    const hasMore = offset + limit < total;
    
    return {
      sessions: paginatedSessions,
      hasMore,
      total,
      offset,
      limit
    };
  } catch (error) {
    console.error(`Error reading sessions for project ${projectName}:`, error);
    return { sessions: [], hasMore: false, total: 0 };
  }
}

async function parseJsonlSessions(filePath) {
  const sessions = new Map();
  const entries = [];
  const pendingSummaries = new Map(); // leafUuid -> summary for entries without sessionId

  try {
    const fileStream = fsSync.createReadStream(filePath);
    const rl = readline.createInterface({
      input: fileStream,
      crlfDelay: Infinity
    });

    for await (const line of rl) {
      if (line.trim()) {
        try {
          const entry = JSON.parse(line);
          entries.push(entry);

          // Handle summary entries that don't have sessionId yet
          if (entry.type === 'summary' && entry.summary && !entry.sessionId && entry.leafUuid) {
            pendingSummaries.set(entry.leafUuid, entry.summary);
          }

          if (entry.sessionId) {
            if (!sessions.has(entry.sessionId)) {
              sessions.set(entry.sessionId, {
                id: entry.sessionId,
                summary: 'New Session',
                messageCount: 0,
                lastActivity: new Date(),
                cwd: entry.cwd || '',
                lastUserMessage: null,
                lastAssistantMessage: null
              });
            }

            const session = sessions.get(entry.sessionId);

            // Apply pending summary if this entry has a parentUuid that matches a pending summary
            if (session.summary === 'New Session' && entry.parentUuid && pendingSummaries.has(entry.parentUuid)) {
              session.summary = pendingSummaries.get(entry.parentUuid);
            }

            // Update summary from summary entries with sessionId
            if (entry.type === 'summary' && entry.summary) {
              session.summary = entry.summary;
            }

            // Track last user and assistant messages (skip system messages)
            if (entry.message?.role === 'user' && entry.message?.content) {
              const content = entry.message.content;

              // Extract text from array format if needed
              let textContent = content;
              if (Array.isArray(content) && content.length > 0 && content[0].type === 'text') {
                textContent = content[0].text;
              }

              const isSystemMessage = typeof textContent === 'string' && (
                textContent.startsWith('<command-name>') ||
                textContent.startsWith('<command-message>') ||
                textContent.startsWith('<command-args>') ||
                textContent.startsWith('<local-command-stdout>') ||
                textContent.startsWith('<system-reminder>') ||
                textContent.startsWith('Caveat:') ||
                textContent.startsWith('This session is being continued from a previous') ||
                textContent.startsWith('Invalid API key') ||
                textContent.includes('{"subtasks":') || // Filter Task Master prompts
                textContent.includes('CRITICAL: You MUST respond with ONLY a JSON') || // Filter Task Master system prompts
                textContent === 'Warmup' // Explicitly filter out "Warmup"
              );

              if (typeof textContent === 'string' && textContent.length > 0 && !isSystemMessage) {
                session.lastUserMessage = textContent;
              }
            } else if (entry.message?.role === 'assistant' && entry.message?.content) {
              // Skip API error messages using the isApiErrorMessage flag
              if (entry.isApiErrorMessage === true) {
                // Skip this message entirely
              } else {
                // Track last assistant text message
                let assistantText = null;

                if (Array.isArray(entry.message.content)) {
                  for (const part of entry.message.content) {
                    if (part.type === 'text' && part.text) {
                      assistantText = part.text;
                    }
                  }
                } else if (typeof entry.message.content === 'string') {
                  assistantText = entry.message.content;
                }

                // Additional filter for assistant messages with system content
                const isSystemAssistantMessage = typeof assistantText === 'string' && (
                  assistantText.startsWith('Invalid API key') ||
                  assistantText.includes('{"subtasks":') ||
                  assistantText.includes('CRITICAL: You MUST respond with ONLY a JSON')
                );

                if (assistantText && !isSystemAssistantMessage) {
                  session.lastAssistantMessage = assistantText;
                }
              }
            }

            session.messageCount++;

            if (entry.timestamp) {
              session.lastActivity = new Date(entry.timestamp);
            }
          }
        } catch (parseError) {
          // Skip malformed lines silently
        }
      }
    }

    // After processing all entries, set final summary based on last message if no summary exists
    for (const session of sessions.values()) {
      if (session.summary === 'New Session') {
        // Prefer last user message, fall back to last assistant message
        const lastMessage = session.lastUserMessage || session.lastAssistantMessage;
        if (lastMessage) {
          session.summary = lastMessage.length > 50 ? lastMessage.substring(0, 50) + '...' : lastMessage;
        }
      }
    }

    // Filter out sessions that contain JSON responses (Task Master errors)
    const allSessions = Array.from(sessions.values());
    const filteredSessions = allSessions.filter(session => {
      const shouldFilter = session.summary.startsWith('{ "');
      if (shouldFilter) {
      }
      // Log a sample of summaries to debug
      if (Math.random() < 0.01) { // Log 1% of sessions
      }
      return !shouldFilter;
    });


    return {
      sessions: filteredSessions,
      entries: entries
    };

  } catch (error) {
    console.error('Error reading JSONL file:', error);
    return { sessions: [], entries: [] };
  }
}

// Parse an agent JSONL file and extract tool uses
async function parseAgentTools(filePath) {
  const tools = [];

  try {
    const fileStream = fsSync.createReadStream(filePath);
    const rl = readline.createInterface({
      input: fileStream,
      crlfDelay: Infinity
    });

    for await (const line of rl) {
      if (line.trim()) {
        try {
          const entry = JSON.parse(line);
          // Look for assistant messages with tool_use
          if (entry.message?.role === 'assistant' && Array.isArray(entry.message?.content)) {
            for (const part of entry.message.content) {
              if (part.type === 'tool_use') {
                tools.push({
                  toolId: part.id,
                  toolName: part.name,
                  toolInput: part.input,
                  timestamp: entry.timestamp
                });
              }
            }
          }
          // Look for tool results
          if (entry.message?.role === 'user' && Array.isArray(entry.message?.content)) {
            for (const part of entry.message.content) {
              if (part.type === 'tool_result') {
                // Find the matching tool and add result
                const tool = tools.find(t => t.toolId === part.tool_use_id);
                if (tool) {
                  tool.toolResult = {
                    content: typeof part.content === 'string' ? part.content :
                             Array.isArray(part.content) ? part.content.map(c => c.text || '').join('\n') :
                             JSON.stringify(part.content),
                    isError: Boolean(part.is_error)
                  };
                }
              }
            }
          }
        } catch (parseError) {
          // Skip malformed lines
        }
      }
    }
  } catch (error) {
    console.warn(`Error parsing agent file ${filePath}:`, error.message);
  }

  return tools;
}

// Get messages for a specific session with pagination support
async function getSessionMessages(projectName, sessionId, limit = null, offset = 0) {
  const projectDir = path.join(os.homedir(), '.claude', 'projects', projectName);

  try {
    const files = await fs.readdir(projectDir);
    // agent-*.jsonl files contain subagent tool history - we'll process them separately
    const jsonlFiles = files.filter(file => file.endsWith('.jsonl') && !file.startsWith('agent-'));
    const agentFiles = files.filter(file => file.endsWith('.jsonl') && file.startsWith('agent-'));

    if (jsonlFiles.length === 0) {
      return { messages: [], total: 0, hasMore: false };
    }

    const messages = [];
    // Map of agentId -> tools for subagent tool grouping
    const agentToolsCache = new Map();

    // Process all JSONL files to find messages for this session
    for (const file of jsonlFiles) {
      const jsonlFile = path.join(projectDir, file);
      const fileStream = fsSync.createReadStream(jsonlFile);
      const rl = readline.createInterface({
        input: fileStream,
        crlfDelay: Infinity
      });

      for await (const line of rl) {
        if (line.trim()) {
          try {
            const entry = JSON.parse(line);
            if (entry.sessionId === sessionId) {
              messages.push(entry);
            }
          } catch (parseError) {
            console.warn('Error parsing line:', parseError.message);
          }
        }
      }
    }

    // Collect agentIds from Task tool results
    const agentIds = new Set();
    for (const message of messages) {
      if (message.toolUseResult?.agentId) {
        agentIds.add(message.toolUseResult.agentId);
      }
    }

    // Load agent tools for each agentId found
    for (const agentId of agentIds) {
      const agentFileName = `agent-${agentId}.jsonl`;
      if (agentFiles.includes(agentFileName)) {
        const agentFilePath = path.join(projectDir, agentFileName);
        const tools = await parseAgentTools(agentFilePath);
        agentToolsCache.set(agentId, tools);
      }
    }

    // Attach agent tools to their parent Task messages
    for (const message of messages) {
      if (message.toolUseResult?.agentId) {
        const agentId = message.toolUseResult.agentId;
        const agentTools = agentToolsCache.get(agentId);
        if (agentTools && agentTools.length > 0) {
          message.subagentTools = agentTools;
        }
      }
    }

    // Sort messages by timestamp
    const sortedMessages = messages.sort((a, b) =>
      new Date(a.timestamp || 0) - new Date(b.timestamp || 0)
    );

    const total = sortedMessages.length;

    // If no limit is specified, return all messages (backward compatibility)
    if (limit === null) {
      return sortedMessages;
    }

    // Apply pagination - for recent messages, we need to slice from the end
    // offset 0 should give us the most recent messages
    const startIndex = Math.max(0, total - offset - limit);
    const endIndex = total - offset;
    const paginatedMessages = sortedMessages.slice(startIndex, endIndex);
    const hasMore = startIndex > 0;

    return {
      messages: paginatedMessages,
      total,
      hasMore,
      offset,
      limit
    };
  } catch (error) {
    console.error(`Error reading messages for session ${sessionId}:`, error);
    return limit === null ? [] : { messages: [], total: 0, hasMore: false };
  }
}

// Rename a project's display name
async function renameProject(projectName, newDisplayName) {
  const config = await loadProjectConfig();
  
  if (!newDisplayName || newDisplayName.trim() === '') {
    // Remove custom name if empty, will fall back to auto-generated
    delete config[projectName];
  } else {
    // Set custom display name
    config[projectName] = {
      displayName: newDisplayName.trim()
    };
  }
  
  await saveProjectConfig(config);
  return true;
}

// Delete a session from a project
async function deleteSession(projectName, sessionId) {
  const projectDir = path.join(os.homedir(), '.claude', 'projects', projectName);
  
  try {
    const files = await fs.readdir(projectDir);
    const jsonlFiles = files.filter(file => file.endsWith('.jsonl'));
    
    if (jsonlFiles.length === 0) {
      throw new Error('No session files found for this project');
    }
    
    // Check all JSONL files to find which one contains the session
    for (const file of jsonlFiles) {
      const jsonlFile = path.join(projectDir, file);
      const content = await fs.readFile(jsonlFile, 'utf8');
      const lines = content.split('\n').filter(line => line.trim());
      
      // Check if this file contains the session
      const hasSession = lines.some(line => {
        try {
          const data = JSON.parse(line);
          return data.sessionId === sessionId;
        } catch {
          return false;
        }
      });
      
      if (hasSession) {
        // Filter out all entries for this session
        const filteredLines = lines.filter(line => {
          try {
            const data = JSON.parse(line);
            return data.sessionId !== sessionId;
          } catch {
            return true; // Keep malformed lines
          }
        });
        
        // Write back the filtered content
        await fs.writeFile(jsonlFile, filteredLines.join('\n') + (filteredLines.length > 0 ? '\n' : ''));
        return true;
      }
    }
    
    throw new Error(`Session ${sessionId} not found in any files`);
  } catch (error) {
    console.error(`Error deleting session ${sessionId} from project ${projectName}:`, error);
    throw error;
  }
}

// Check if a project is empty (has no sessions)
async function isProjectEmpty(projectName) {
  try {
    const sessionsResult = await getSessions(projectName, 1, 0);
    return sessionsResult.total === 0;
  } catch (error) {
    console.error(`Error checking if project ${projectName} is empty:`, error);
    return false;
  }
}

// Delete a project (force=true to delete even with sessions, preserveSessions=true to keep session files)
async function deleteProject(projectName, force = false, preserveSessions = false) {
  const projectDir = path.join(os.homedir(), '.claude', 'projects', projectName);

  try {
    // If not preserving sessions, check if project is empty
    if (!preserveSessions) {
      const isEmpty = await isProjectEmpty(projectName);
      if (!isEmpty && !force) {
        throw new Error('Cannot delete project with existing sessions');
      }
    }

    const config = await loadProjectConfig();
    let projectPath = config[projectName]?.path || config[projectName]?.originalPath;

    // Fallback to extractProjectDirectory if projectPath is not in config
    if (!projectPath) {
      projectPath = await extractProjectDirectory(projectName);
    }

    // Remove the project directory (includes all Claude sessions)
    await fs.rm(projectDir, { recursive: true, force: true });

    // Delete all Codex sessions associated with this project
    if (projectPath) {
      try {
        const codexSessions = await getCodexSessions(projectPath, { limit: 0 });
        for (const session of codexSessions) {
          try {
            await deleteCodexSession(session.id);
          } catch (err) {
            console.warn(`Failed to delete Codex session ${session.id}:`, err.message);
          }
        }
      } catch (err) {
        console.warn('Failed to delete Codex sessions:', err.message);
      }

      // Delete Cursor sessions directory if it exists
      try {
        const hash = crypto.createHash('md5').update(projectPath).digest('hex');
        const cursorProjectDir = path.join(os.homedir(), '.cursor', 'chats', hash);
        await fs.rm(cursorProjectDir, { recursive: true, force: true });
      } catch (err) {
        // Cursor dir may not exist, ignore
      }
    }

    // Remove from project config
    delete config[projectName];
    await saveProjectConfig(config);

    return true;
  } catch (error) {
    console.error(`Error deleting project ${projectName}:`, error);
    throw error;
  }
}

// Add a project manually to the config (without creating folders)
async function addProjectManually(projectPath, displayName = null) {
  const absolutePath = path.resolve(projectPath);

  try {
    // Check if the path exists
    await fs.access(absolutePath);
  } catch (error) {
    throw new Error(`Path does not exist: ${absolutePath}`);
  }

  // Generate project name (encode path for use as directory name)
  const projectName = absolutePath.replace(/[\\/:\s~_]/g, '-');

  // Check if project already exists in config
  const config = await loadProjectConfig();
  const projectDir = path.join(os.homedir(), '.claude', 'projects', projectName);

  if (config[projectName]) {
    throw new Error(`Project already configured for path: ${absolutePath}`);
  }

  // Allow adding projects even if the directory exists - this enables tracking
  // existing Claude Code or Cursor projects in the UI

  // Add to config as manually added project
  config[projectName] = {
    manuallyAdded: true,
    originalPath: absolutePath
  };

  if (displayName) {
    config[projectName].displayName = displayName;
  }
  
  await saveProjectConfig(config);
  
  
  return {
    name: projectName,
    path: absolutePath,
    fullPath: absolutePath,
    displayName: displayName || await generateDisplayName(projectName, absolutePath),
    isManuallyAdded: true,
    sessions: [],
    cursorSessions: []
  };
}


export {
  getProjects,
  getSessions,
  getSessionMessages,
  parseJsonlSessions,
  renameProject,
  deleteSession,
  isProjectEmpty,
  deleteProject,
  addProjectManually,
  loadProjectConfig,
  saveProjectConfig,
  extractProjectDirectory,
  clearProjectDirectoryCache,
  getCodexSessions,
  getCodexSessionMessages,
  deleteCodexSession
};
