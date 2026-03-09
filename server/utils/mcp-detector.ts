/**
 * MCP SERVER DETECTION UTILITY
 * ============================
 *
 * Centralized utility for detecting MCP server configurations.
 * Used across TaskMaster integration and other MCP-dependent features.
 */

import { promises as fsPromises } from 'fs';
import path from 'path';
import os from 'os';
import type { MCPServerConfig } from '../types/index.js';

// Cache for detectTaskMasterMCPServer results (30s TTL)
let mcpDetectionCache: MCPDetectionResult | null = null;
let mcpDetectionCacheTime: number = 0;
const MCP_CACHE_TTL: number = 30000;

interface MCPConfigData {
    mcpServers?: Record<string, MCPServerConfig>;
    projects?: Record<string, {
        mcpServers?: Record<string, MCPServerConfig>;
        [key: string]: unknown;
    }>;
    [key: string]: unknown;
}

interface TaskMasterServerInfo {
    name: string;
    scope: 'user' | 'local';
    projectPath?: string;
    config: MCPServerConfig;
    type: 'stdio' | 'http' | 'unknown';
}

export interface MCPDetectionResultFound {
    hasMCPServer: true;
    isConfigured: boolean;
    hasApiKeys: boolean;
    scope: 'user' | 'local';
    config: {
        command?: string;
        args: string[];
        url?: string;
        envVars: string[];
        type: 'stdio' | 'http' | 'unknown';
    };
}

export interface MCPDetectionResultNotFound {
    hasMCPServer: false;
    reason: string;
    hasConfig: boolean;
    configPath?: string | null;
    availableServers?: string[];
}

export type MCPDetectionResult = MCPDetectionResultFound | MCPDetectionResultNotFound;

export interface AllMCPServersResult {
    hasConfig: boolean;
    configPath?: string | null;
    error?: string;
    servers: Record<string, MCPServerConfig>;
    projectServers: Record<string, unknown>;
}

/**
 * Check if task-master-ai MCP server is configured
 * Reads directly from Claude configuration files like claude-cli.js does
 * Results are cached for 30 seconds to avoid redundant disk reads.
 * @returns MCP detection result
 */
export async function detectTaskMasterMCPServer(): Promise<MCPDetectionResult> {
    const now: number = Date.now();
    if (mcpDetectionCache && (now - mcpDetectionCacheTime) < MCP_CACHE_TTL) {
        return mcpDetectionCache;
    }

    const result: MCPDetectionResult = await _detectTaskMasterMCPServerUncached();
    mcpDetectionCache = result;
    mcpDetectionCacheTime = now;
    return result;
}

async function _detectTaskMasterMCPServerUncached(): Promise<MCPDetectionResult> {
    try {
        // Read Claude configuration files directly (same logic as mcp.js)
        const homeDir: string = os.homedir();
        const configPaths: string[] = [
            path.join(homeDir, '.claude.json'),
            path.join(homeDir, '.claude', 'settings.json')
        ];

        let configData: MCPConfigData | null = null;
        let configPath: string | null = null;

        // Try to read from either config file
        for (const filepath of configPaths) {
            try {
                const fileContent: string = await fsPromises.readFile(filepath, 'utf8');
                configData = JSON.parse(fileContent) as MCPConfigData;
                configPath = filepath;
                break;
            } catch (error: unknown) {
                // File doesn't exist or is not valid JSON, try next
                continue;
            }
        }

        if (!configData) {
            return {
                hasMCPServer: false,
                reason: 'No Claude configuration file found',
                hasConfig: false
            };
        }

        // Look for task-master-ai in user-scoped MCP servers
        let taskMasterServer: TaskMasterServerInfo | null = null;
        if (configData.mcpServers && typeof configData.mcpServers === 'object') {
            const serverEntry = Object.entries(configData.mcpServers).find(([name, config]: [string, MCPServerConfig]) =>
                name === 'task-master-ai' ||
                name.includes('task-master') ||
                (config && config.command && config.command.includes('task-master'))
            );

            if (serverEntry) {
                const [name, config] = serverEntry;
                taskMasterServer = {
                    name,
                    scope: 'user',
                    config,
                    type: config.command ? 'stdio' : (config.url ? 'http' : 'unknown')
                };
            }
        }

        // Also check project-specific MCP servers if not found globally
        if (!taskMasterServer && configData.projects) {
            for (const [projectPath, projectConfig] of Object.entries(configData.projects)) {
                if (projectConfig.mcpServers && typeof projectConfig.mcpServers === 'object') {
                    const serverEntry = Object.entries(projectConfig.mcpServers).find(([name, config]: [string, MCPServerConfig]) =>
                        name === 'task-master-ai' ||
                        name.includes('task-master') ||
                        (config && config.command && config.command.includes('task-master'))
                    );

                    if (serverEntry) {
                        const [name, config] = serverEntry;
                        taskMasterServer = {
                            name,
                            scope: 'local',
                            projectPath,
                            config,
                            type: config.command ? 'stdio' : (config.url ? 'http' : 'unknown')
                        };
                        break;
                    }
                }
            }
        }

        if (taskMasterServer) {
            const isValid: boolean = !!(taskMasterServer.config &&
                             (taskMasterServer.config.command || taskMasterServer.config.url));
            const hasEnvVars: boolean = !!(taskMasterServer.config &&
                                taskMasterServer.config.env &&
                                Object.keys(taskMasterServer.config.env).length > 0);

            return {
                hasMCPServer: true,
                isConfigured: isValid,
                hasApiKeys: hasEnvVars,
                scope: taskMasterServer.scope,
                config: {
                    command: taskMasterServer.config?.command,
                    args: taskMasterServer.config?.args || [],
                    url: taskMasterServer.config?.url,
                    envVars: hasEnvVars ? Object.keys(taskMasterServer.config.env!) : [],
                    type: taskMasterServer.type
                }
            };
        } else {
            // Get list of available servers for debugging
            const availableServers: string[] = [];
            if (configData.mcpServers) {
                availableServers.push(...Object.keys(configData.mcpServers));
            }
            if (configData.projects) {
                for (const projectConfig of Object.values(configData.projects)) {
                    if (projectConfig.mcpServers) {
                        availableServers.push(...Object.keys(projectConfig.mcpServers).map((name: string) => `local:${name}`));
                    }
                }
            }

            return {
                hasMCPServer: false,
                reason: 'task-master-ai not found in configured MCP servers',
                hasConfig: true,
                configPath,
                availableServers
            };
        }
    } catch (error: unknown) {
        console.error('Error detecting MCP server config:', error);
        return {
            hasMCPServer: false,
            reason: `Error checking MCP config: ${(error as Error).message}`,
            hasConfig: false
        };
    }
}

/**
 * Get all configured MCP servers (not just TaskMaster)
 * @returns All MCP servers configuration
 */
export async function getAllMCPServers(): Promise<AllMCPServersResult> {
    try {
        const homeDir: string = os.homedir();
        const configPaths: string[] = [
            path.join(homeDir, '.claude.json'),
            path.join(homeDir, '.claude', 'settings.json')
        ];

        let configData: MCPConfigData | null = null;
        let configPath: string | null = null;

        // Try to read from either config file
        for (const filepath of configPaths) {
            try {
                const fileContent: string = await fsPromises.readFile(filepath, 'utf8');
                configData = JSON.parse(fileContent) as MCPConfigData;
                configPath = filepath;
                break;
            } catch (error: unknown) {
                continue;
            }
        }

        if (!configData) {
            return {
                hasConfig: false,
                servers: {},
                projectServers: {}
            };
        }

        return {
            hasConfig: true,
            configPath,
            servers: configData.mcpServers || {},
            projectServers: configData.projects || {}
        };
    } catch (error: unknown) {
        console.error('Error getting all MCP servers:', error);
        return {
            hasConfig: false,
            error: (error as Error).message,
            servers: {},
            projectServers: {}
        };
    }
}
