import { promises as fs } from 'fs';
import path from 'path';
import crypto from 'crypto';
import sqlite3 from 'sqlite3';
import { open } from 'sqlite';
import os from 'os';

interface CursorSessionInfo {
  id: string;
  name: string;
  createdAt: string;
  lastActivity: string;
  messageCount: number;
  projectPath: string;
}

interface MetaRow {
  key: string;
  value: Buffer | string;
}

interface CountResult {
  count: number;
}

async function getCursorSessions(projectPath: string): Promise<CursorSessionInfo[]> {
  try {
    const cwdId: string = crypto.createHash('md5').update(projectPath).digest('hex');
    const cursorChatsPath: string = path.join(os.homedir(), '.cursor', 'chats', cwdId);

    try {
      await fs.access(cursorChatsPath);
    } catch {
      return [];
    }

    const sessionDirs: string[] = await fs.readdir(cursorChatsPath);
    const sessions: CursorSessionInfo[] = [];

    for (const sessionId of sessionDirs) {
      const sessionPath: string = path.join(cursorChatsPath, sessionId);
      const storeDbPath: string = path.join(sessionPath, 'store.db');

      try {
        await fs.access(storeDbPath);

        let dbStatMtimeMs: number | null = null;
        try {
          const stat = await fs.stat(storeDbPath);
          dbStatMtimeMs = stat.mtimeMs;
        } catch (_) {}

        const db = await open({
          filename: storeDbPath,
          driver: sqlite3.Database,
          mode: sqlite3.OPEN_READONLY
        });

        const metaRows: MetaRow[] = await db.all(`SELECT key, value FROM meta`);

        const metadata: Record<string, unknown> = {};
        for (const row of metaRows) {
          if (row.value) {
            try {
              const hexMatch: RegExpMatchArray | null = row.value.toString().match(/^[0-9a-fA-F]+$/);
              if (hexMatch) {
                const jsonStr: string = Buffer.from(row.value as string, 'hex').toString('utf8');
                metadata[row.key] = JSON.parse(jsonStr);
              } else {
                metadata[row.key] = row.value.toString();
              }
            } catch {
              metadata[row.key] = row.value.toString();
            }
          }
        }

        const messageCountResult: CountResult | undefined = await db.get(`SELECT COUNT(*) as count FROM blobs`);
        await db.close();

        const sessionName: string = (metadata.title as string) || (metadata.sessionTitle as string) || 'Untitled Session';

        let createdAt: string;
        if (metadata.createdAt) {
          createdAt = new Date(metadata.createdAt as string | number).toISOString();
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
          messageCount: messageCountResult?.count || 0,
          projectPath: projectPath
        });

      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        console.warn(`Could not read Cursor session ${sessionId}:`, message);
      }
    }

    sessions.sort((a: CursorSessionInfo, b: CursorSessionInfo) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
    return sessions.slice(0, 5);

  } catch (error: unknown) {
    console.error('Error fetching Cursor sessions:', error);
    return [];
  }
}

export { getCursorSessions };
