import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

export interface GitConfig {
  git_name: string | null;
  git_email: string | null;
}

/**
 * Read git configuration from system's global git config
 * @returns Promise resolving to git name and email
 */
export async function getSystemGitConfig(): Promise<GitConfig> {
  try {
    const [nameResult, emailResult] = await Promise.all([
      execFileAsync('git', ['config', '--global', 'user.name']).catch(() => ({ stdout: '' })),
      execFileAsync('git', ['config', '--global', 'user.email']).catch(() => ({ stdout: '' }))
    ]);

    return {
      git_name: nameResult.stdout.trim() || null,
      git_email: emailResult.stdout.trim() || null
    };
  } catch (error) {
    return { git_name: null, git_email: null };
  }
}
