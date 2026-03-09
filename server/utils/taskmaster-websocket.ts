/**
 * TASKMASTER WEBSOCKET UTILITIES
 * ==============================
 *
 * Utilities for broadcasting TaskMaster state changes via WebSocket.
 * Integrates with the existing WebSocket system to provide real-time updates.
 */

import type { WebSocketServer, WebSocket } from 'ws';

interface TaskMasterProjectUpdateMessage {
    type: 'taskmaster-project-updated';
    projectName: string;
    taskMasterData: unknown;
    timestamp: string;
}

interface TaskMasterTasksUpdateMessage {
    type: 'taskmaster-tasks-updated';
    projectName: string;
    tasksData: unknown;
    timestamp: string;
}

interface MCPStatusChangeMessage {
    type: 'taskmaster-mcp-status-changed';
    mcpStatus: unknown;
    timestamp: string;
}

interface TaskMasterUpdateMessage {
    type: 'taskmaster-update';
    updateType: string;
    data: Record<string, unknown>;
    timestamp: string;
}

/**
 * Broadcast TaskMaster project update to all connected clients
 * @param wss - WebSocket server instance
 * @param projectName - Name of the updated project
 * @param taskMasterData - Updated TaskMaster data
 */
export function broadcastTaskMasterProjectUpdate(wss: WebSocketServer, projectName: string, taskMasterData: unknown): void {
    if (!wss || !projectName) {
        console.warn('TaskMaster WebSocket broadcast: Missing wss or projectName');
        return;
    }

    const message: TaskMasterProjectUpdateMessage = {
        type: 'taskmaster-project-updated',
        projectName,
        taskMasterData,
        timestamp: new Date().toISOString()
    };


    wss.clients.forEach((client: WebSocket) => {
        if (client.readyState === 1) { // WebSocket.OPEN
            try {
                client.send(JSON.stringify(message));
            } catch (error: unknown) {
                console.error('Error sending TaskMaster project update:', error);
            }
        }
    });
}

/**
 * Broadcast TaskMaster tasks update for a specific project
 * @param wss - WebSocket server instance
 * @param projectName - Name of the project with updated tasks
 * @param tasksData - Updated tasks data
 */
export function broadcastTaskMasterTasksUpdate(wss: WebSocketServer, projectName: string, tasksData: unknown): void {
    if (!wss || !projectName) {
        console.warn('TaskMaster WebSocket broadcast: Missing wss or projectName');
        return;
    }

    const message: TaskMasterTasksUpdateMessage = {
        type: 'taskmaster-tasks-updated',
        projectName,
        tasksData,
        timestamp: new Date().toISOString()
    };


    wss.clients.forEach((client: WebSocket) => {
        if (client.readyState === 1) { // WebSocket.OPEN
            try {
                client.send(JSON.stringify(message));
            } catch (error: unknown) {
                console.error('Error sending TaskMaster tasks update:', error);
            }
        }
    });
}

/**
 * Broadcast MCP server status change
 * @param wss - WebSocket server instance
 * @param mcpStatus - Updated MCP server status
 */
export function broadcastMCPStatusChange(wss: WebSocketServer, mcpStatus: unknown): void {
    if (!wss) {
        console.warn('TaskMaster WebSocket broadcast: Missing wss');
        return;
    }

    const message: MCPStatusChangeMessage = {
        type: 'taskmaster-mcp-status-changed',
        mcpStatus,
        timestamp: new Date().toISOString()
    };


    wss.clients.forEach((client: WebSocket) => {
        if (client.readyState === 1) { // WebSocket.OPEN
            try {
                client.send(JSON.stringify(message));
            } catch (error: unknown) {
                console.error('Error sending TaskMaster MCP status update:', error);
            }
        }
    });
}

/**
 * Broadcast general TaskMaster update notification
 * @param wss - WebSocket server instance
 * @param updateType - Type of update (e.g., 'initialization', 'configuration')
 * @param data - Additional data about the update
 */
export function broadcastTaskMasterUpdate(wss: WebSocketServer, updateType: string, data: Record<string, unknown> = {}): void {
    if (!wss || !updateType) {
        console.warn('TaskMaster WebSocket broadcast: Missing wss or updateType');
        return;
    }

    const message: TaskMasterUpdateMessage = {
        type: 'taskmaster-update',
        updateType,
        data,
        timestamp: new Date().toISOString()
    };


    wss.clients.forEach((client: WebSocket) => {
        if (client.readyState === 1) { // WebSocket.OPEN
            try {
                client.send(JSON.stringify(message));
            } catch (error: unknown) {
                console.error('Error sending TaskMaster update:', error);
            }
        }
    });
}
