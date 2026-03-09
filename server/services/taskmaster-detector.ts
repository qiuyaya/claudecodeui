import { promises as fs } from 'fs';
import path from 'path';

interface TaskStats {
  total: number;
  subtotalTasks: number;
  pending: number;
  'in-progress': number;
  done: number;
  review: number;
  deferred: number;
  cancelled: number;
  subtasks: Record<string, number>;
  [key: string]: number | Record<string, number>;
}

interface TaskMetadata {
  taskCount: number;
  subtaskCount: number;
  completed: number;
  pending: number;
  inProgress: number;
  review: number;
  completionPercentage: number;
  lastModified: string;
}

interface TaskMetadataError {
  error: string;
}

interface TaskMasterDetectionResult {
  hasTaskmaster: boolean;
  hasEssentialFiles?: boolean;
  files?: Record<string, boolean>;
  metadata?: TaskMetadata | TaskMetadataError | null;
  path?: string;
  reason?: string;
}

interface TaskEntry {
  status: string;
  subtasks?: { status: string }[];
}

interface TasksData {
  tasks?: TaskEntry[];
  [key: string]: { tasks?: TaskEntry[] } | TaskEntry[] | undefined;
}

async function detectTaskMasterFolder(projectPath: string): Promise<TaskMasterDetectionResult> {
    try {
        const taskMasterPath: string = path.join(projectPath, '.taskmaster');

        try {
            const stats = await fs.stat(taskMasterPath);
            if (!stats.isDirectory()) {
                return { hasTaskmaster: false, reason: '.taskmaster exists but is not a directory' };
            }
        } catch (error: unknown) {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
                return { hasTaskmaster: false, reason: '.taskmaster directory not found' };
            }
            throw error;
        }

        const keyFiles: string[] = ['tasks/tasks.json', 'config.json'];
        const fileStatus: Record<string, boolean> = {};
        let hasEssentialFiles: boolean = true;

        for (const file of keyFiles) {
            const filePath: string = path.join(taskMasterPath, file);
            try {
                await fs.access(filePath);
                fileStatus[file] = true;
            } catch {
                fileStatus[file] = false;
                if (file === 'tasks/tasks.json') {
                    hasEssentialFiles = false;
                }
            }
        }

        let taskMetadata: TaskMetadata | TaskMetadataError | null = null;
        if (fileStatus['tasks/tasks.json']) {
            try {
                const tasksPath: string = path.join(taskMasterPath, 'tasks/tasks.json');
                const tasksContent: string = await fs.readFile(tasksPath, 'utf8');
                const tasksData: TasksData = JSON.parse(tasksContent);

                let tasks: TaskEntry[] = [];
                if (tasksData.tasks) {
                    tasks = tasksData.tasks;
                } else {
                    Object.values(tasksData).forEach((tagData) => {
                        if (tagData && typeof tagData === 'object' && 'tasks' in tagData && (tagData as { tasks?: TaskEntry[] }).tasks) {
                            tasks = tasks.concat((tagData as { tasks: TaskEntry[] }).tasks);
                        }
                    });
                }

                const stats: TaskStats = tasks.reduce((acc: TaskStats, task: TaskEntry) => {
                    acc.total++;
                    acc[task.status] = ((acc[task.status] as number) || 0) + 1;
                    if (task.subtasks) {
                        task.subtasks.forEach((subtask: { status: string }) => {
                            acc.subtotalTasks++;
                            acc.subtasks = acc.subtasks || {};
                            acc.subtasks[subtask.status] = (acc.subtasks[subtask.status] || 0) + 1;
                        });
                    }
                    return acc;
                }, {
                    total: 0, subtotalTasks: 0, pending: 0,
                    'in-progress': 0, done: 0, review: 0,
                    deferred: 0, cancelled: 0, subtasks: {}
                } as TaskStats);

                taskMetadata = {
                    taskCount: stats.total,
                    subtaskCount: stats.subtotalTasks,
                    completed: (stats.done as number) || 0,
                    pending: (stats.pending as number) || 0,
                    inProgress: (stats['in-progress'] as number) || 0,
                    review: (stats.review as number) || 0,
                    completionPercentage: stats.total > 0 ? Math.round(((stats.done as number) / stats.total) * 100) : 0,
                    lastModified: (await fs.stat(tasksPath)).mtime.toISOString()
                };
            } catch (parseError: unknown) {
                const message = parseError instanceof Error ? parseError.message : String(parseError);
                console.warn('Failed to parse tasks.json:', message);
                taskMetadata = { error: 'Failed to parse tasks.json' };
            }
        }

        return {
            hasTaskmaster: true,
            hasEssentialFiles,
            files: fileStatus,
            metadata: taskMetadata,
            path: taskMasterPath
        };

    } catch (error: unknown) {
        console.error('Error detecting TaskMaster folder:', error);
        const message = error instanceof Error ? error.message : String(error);
        return { hasTaskmaster: false, reason: `Error checking directory: ${message}` };
    }
}

export { detectTaskMasterFolder };
