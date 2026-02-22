import express from 'express';
import path from 'path';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import { getSanitizedEnv } from '../utils/env.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const router = express.Router();

// System update endpoint
router.post('/update', async (req, res, next) => {
    try {
        const projectRoot = path.join(__dirname, '../..');

        // Verify git remote points to expected repository
        try {
          const { execFileSync } = await import('child_process');
          const remoteUrl = execFileSync('git', ['remote', 'get-url', 'origin'], { cwd: projectRoot, encoding: 'utf-8' }).trim();
          if (!/^(https:\/\/github\.com\/|git@github\.com:)/.test(remoteUrl)) {
            return res.status(400).json({ error: 'Update only supported for GitHub-hosted repositories' });
          }
        } catch (e) {
          return res.status(400).json({ error: 'Failed to verify git remote' });
        }

        const updateCommand = 'git checkout main && git pull && npm install';

        const child = spawn('sh', ['-c', updateCommand], {
            cwd: projectRoot,
            env: getSanitizedEnv()
        });

        let output = '';
        let errorOutput = '';

        child.stdout.on('data', (data) => {
            output += data.toString();
        });

        child.stderr.on('data', (data) => {
            errorOutput += data.toString();
        });

        child.on('close', (code) => {
            if (code === 0) {
                res.json({
                    success: true,
                    output: output || 'Update completed successfully',
                    message: 'Update completed. Please restart the server to apply changes.'
                });
            } else {
                res.status(500).json({
                    success: false,
                    error: 'Update command failed',
                    output,
                    errorOutput
                });
            }
        });

        child.on('error', (error) => {
            next(error);
        });

    } catch (error) {
        next(error);
    }
});

export default router;
