/**
 * MCP UTILITIES API ROUTES
 * ========================
 *
 * API endpoints for MCP server detection and configuration utilities.
 * These endpoints expose centralized MCP detection functionality.
 */

import { Router, Request, Response } from 'express';
import { detectTaskMasterMCPServer, getAllMCPServers } from '../utils/mcp-detector.js';
import type { MCPDetectionResult, AllMCPServersResult } from '../utils/mcp-detector.js';

const router: Router = Router();

/**
 * GET /api/mcp-utils/taskmaster-server
 * Check if TaskMaster MCP server is configured
 */
router.get('/taskmaster-server', async (req: Request, res: Response): Promise<void> => {
    try {
        const result: MCPDetectionResult = await detectTaskMasterMCPServer();
        res.json(result);
    } catch (error: unknown) {
        console.error('TaskMaster MCP detection error:', error);
        res.status(500).json({
            error: 'Failed to detect TaskMaster MCP server',
            message: (error as Error).message
        });
    }
});

/**
 * GET /api/mcp-utils/all-servers
 * Get all configured MCP servers
 */
router.get('/all-servers', async (req: Request, res: Response): Promise<void> => {
    try {
        const result: AllMCPServersResult = await getAllMCPServers();
        res.json(result);
    } catch (error: unknown) {
        console.error('MCP servers detection error:', error);
        res.status(500).json({
            error: 'Failed to get MCP servers',
            message: (error as Error).message
        });
    }
});

export default router;
