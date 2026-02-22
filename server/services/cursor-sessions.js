import { promises as fs } from 'fs';
import path from 'path';
import crypto from 'crypto';
import sqlite3 from 'sqlite3';
import { open } from 'sqlite';
import os from 'os';

async function getCursorSessions(projectPath) {
  try {
    const cwdId = crypto.createHash('md5').update(projectPath).digest('hex');
    const cursorChatsPath = path.join(os.homedir(), '.cursor', 'chats', cwdId);

    try {
      await fs.access(cursorChatsPath);
    } catch (error) {
      return [];
    }

    const sessionDirs = await fs.readdir(cursorChatsPath);
    const sessions = [];

    for (const sessionId of sessionDirs) {
      const sessionPath = path.join(cursorChatsPath, sessionId);
      const storeDbPath = path.join(sessionPath, 'store.db');

      try {
        await fs.access(storeDbPath);

        let dbStatMtimeMs = null;
        try {
          const stat = await fs.stat(storeDbPath);
          dbStatMtimeMs = stat.mtimeMs;
        } catch (_) {}

        const db = await open({
          filename: storeDbPath,
          driver: sqlite3.Database,
          mode: sqlite3.OPEN_READONLY
        });

        const metaRows = await db.all(`SELECT key, value FROM meta`);

        let metadata = {};
        for (const row of metaRows) {
          if (row.value) {
            try {
              const hexMatch = row.value.toString().match(/^[0-9a-fA-F]+$/);
              if (hexMatch) {
                const jsonStr = Buffer.from(row.value, 'hex').toString('utf8');
                metadata[row.key] = JSON.parse(jsonStr);
              } else {
                metadata[row.key] = row.value.toString();
              }
            } catch (e) {
              metadata[row.key] = row.value.toString();
            }
          }
        }

        const messageCountResult = await db.get(`SELECT COUNT(*) as count FROM blobs`);
        await db.close();

        const sessionName = metadata.title || metadata.sessionTitle || 'Untitled Session';

        let createdAt = null;
        if (metadata.createdAt) {
          createdAt = new Date(metadata.createdAt).toISOString();
        } else if (dbStatMtimeMs) {
          createdAt = new Date(dbStatMtimeMs).toISOString();
        } else {
          createdAt = new Date().toISOString();
        }

        sessions.push({
          id: sessionId,
          name: sessionName,
          createdAt: createdAt,
          lastActivity: createdAt,
          messageCount: messageCountResult.count || 0,
          projectPath: projectPath
        });

      } catch (error) {
        console.warn(`Could not read Cursor session ${sessionId}:`, error.message);
      }
    }

    sessions.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    return sessions.slice(0, 5);

  } catch (error) {
    console.error('Error fetching Cursor sessions:', error);
    return [];
  }
}

export { getCursorSessions };
