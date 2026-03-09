// Load environment variables from .env before other imports execute.
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const __filename: string = fileURLToPath(import.meta.url);
const __dirname: string = dirname(__filename);

try {
  const envPath: string = path.join(__dirname, '../.env');
  const envFile: string = fs.readFileSync(envPath, 'utf8');
  envFile.split('\n').forEach((line: string) => {
    const trimmedLine: string = line.trim();
    if (trimmedLine && !trimmedLine.startsWith('#')) {
      const [key, ...valueParts] = trimmedLine.split('=');
      if (key && valueParts.length > 0 && !process.env[key]) {
        process.env[key] = valueParts.join('=').trim();
      }
    }
  });
} catch (e: unknown) {
  const error = e as Error;
  console.log('No .env file found or error reading it:', error.message);
}

if (!process.env.DATABASE_PATH) {
  process.env.DATABASE_PATH = path.join(os.homedir(), '.cloudcli', 'auth.db');
}
