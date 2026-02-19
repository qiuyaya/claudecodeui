import { memo, useEffect, useRef } from 'react';
import { CheckSquare, Loader2, Square, Trash2 } from 'lucide-react';
import type { TFunction } from 'i18next';
import { Button } from '../../../ui/button';
import type { LoadingProgress, Project, ProjectSession, SessionProvider } from '../../../../types/app';
import type {
  LoadingSessionsByProject,
  MCPServerStatus,
  SessionWithProvider,
  TouchHandlerFactory,
} from '../../types/types';
import SidebarProjectItem from './SidebarProjectItem';
import SidebarProjectsState from './SidebarProjectsState';

export type SidebarProjectListProps = {
  projects: Project[];
  filteredProjects: Project[];
  selectedProject: Project | null;
  selectedSession: ProjectSession | null;
  isLoading: boolean;
  loadingProgress: LoadingProgress | null;
  expandedProjects: Set<string>;
  editingProject: string | null;
  editingName: string;
  loadingSessions: LoadingSessionsByProject;
  initialSessionsLoaded: Set<string>;
  currentTime: Date;
  editingSession: string | null;
  editingSessionName: string;
  deletingProjects: Set<string>;
  tasksEnabled: boolean;
  mcpServerStatus: MCPServerStatus;
  selectedProjects: Set<string>;
  getProjectSessions: (project: Project) => SessionWithProvider[];
  isProjectStarred: (projectName: string) => boolean;
  onEditingNameChange: (value: string) => void;
  onToggleProject: (projectName: string) => void;
  onProjectSelect: (project: Project) => void;
  onToggleStarProject: (projectName: string) => void;
  onStartEditingProject: (project: Project) => void;
  onCancelEditingProject: () => void;
  onSaveProjectName: (projectName: string) => void;
  onDeleteProject: (project: Project) => void;
  onToggleProjectSelection: (projectName: string) => void;
  onToggleSelectAll: () => void;
  onBatchDelete: () => void;
  onSessionSelect: (session: SessionWithProvider, projectName: string) => void;
  onDeleteSession: (
    projectName: string,
    sessionId: string,
    sessionTitle: string,
    provider: SessionProvider,
  ) => void;
  onLoadMoreSessions: (project: Project) => void;
  onNewSession: (project: Project) => void;
  onEditingSessionNameChange: (value: string) => void;
  onStartEditingSession: (sessionId: string, initialName: string) => void;
  onCancelEditingSession: () => void;
  onSaveEditingSession: (projectName: string, sessionId: string, summary: string) => void;
  touchHandlerFactory: TouchHandlerFactory;
  hasMoreProjects: boolean;
  isLoadingMoreProjects: boolean;
  onLoadMoreProjects: () => void;
  t: TFunction;
};

const SidebarProjectList = memo(function SidebarProjectList({
  projects,
  filteredProjects,
  selectedProject,
  selectedSession,
  isLoading,
  loadingProgress,
  expandedProjects,
  editingProject,
  editingName,
  loadingSessions,
  initialSessionsLoaded,
  currentTime,
  editingSession,
  editingSessionName,
  deletingProjects,
  tasksEnabled,
  mcpServerStatus,
  selectedProjects,
  getProjectSessions,
  isProjectStarred,
  onEditingNameChange,
  onToggleProject,
  onProjectSelect,
  onToggleStarProject,
  onStartEditingProject,
  onCancelEditingProject,
  onSaveProjectName,
  onDeleteProject,
  onToggleProjectSelection,
  onToggleSelectAll,
  onBatchDelete,
  onSessionSelect,
  onDeleteSession,
  onLoadMoreSessions,
  onNewSession,
  onEditingSessionNameChange,
  onStartEditingSession,
  onCancelEditingSession,
  onSaveEditingSession,
  touchHandlerFactory,
  hasMoreProjects,
  isLoadingMoreProjects,
  onLoadMoreProjects,
  t,
}: SidebarProjectListProps) {
  const loadMoreRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!hasMoreProjects || isLoadingMoreProjects) return;
    const el = loadMoreRef.current;
    if (!el) return;
    const observer = new IntersectionObserver(
      ([entry]) => { if (entry?.isIntersecting) onLoadMoreProjects(); },
      { threshold: 0.1 },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [hasMoreProjects, isLoadingMoreProjects, onLoadMoreProjects]);
  const state = (
    <SidebarProjectsState
      isLoading={isLoading}
      loadingProgress={loadingProgress}
      projectsCount={projects.length}
      filteredProjectsCount={filteredProjects.length}
      t={t}
    />
  );

  const showProjects = !isLoading && projects.length > 0 && filteredProjects.length > 0;
  const hasSelection = selectedProjects.size > 0;
  const allSelected = hasSelection && selectedProjects.size === filteredProjects.length;

  return (
    <div className="md:space-y-1 pb-safe-area-inset-bottom">
      {showProjects && (
        <div className="hidden md:flex items-center justify-between px-2 py-1 text-xs text-muted-foreground">
          <button
            className="flex items-center gap-1.5 hover:text-foreground transition-colors"
            onClick={onToggleSelectAll}
          >
            {allSelected ? (
              <CheckSquare className="w-3.5 h-3.5" />
            ) : (
              <Square className="w-3.5 h-3.5" />
            )}
            {allSelected ? t('batchSelect.deselectAll') : t('batchSelect.all')}
          </button>
          {hasSelection && (
            <Button
              variant="ghost"
              size="sm"
              className="h-6 px-2 text-xs text-red-600 hover:text-red-700 hover:bg-red-50 dark:hover:bg-red-900/20"
              onClick={onBatchDelete}
            >
              <Trash2 className="w-3 h-3 mr-1" />
              {t('batchSelect.deleteSelected', { count: selectedProjects.size })}
            </Button>
          )}
        </div>
      )}
      {!showProjects
        ? state
        : filteredProjects.map((project) => (
            <SidebarProjectItem
              key={project.name}
              project={project}
              selectedProject={selectedProject}
              selectedSession={selectedSession}
              isExpanded={expandedProjects.has(project.name)}
              isDeleting={deletingProjects.has(project.name)}
              isStarred={isProjectStarred(project.name)}
              isSelectedForBatch={selectedProjects.has(project.name)}
              editingProject={editingProject}
              editingName={editingName}
              sessions={getProjectSessions(project)}
              initialSessionsLoaded={initialSessionsLoaded.has(project.name)}
              isLoadingSessions={Boolean(loadingSessions[project.name])}
              currentTime={currentTime}
              editingSession={editingSession}
              editingSessionName={editingSessionName}
              tasksEnabled={tasksEnabled}
              mcpServerStatus={mcpServerStatus}
              onEditingNameChange={onEditingNameChange}
              onToggleProject={onToggleProject}
              onProjectSelect={onProjectSelect}
              onToggleStarProject={onToggleStarProject}
              onStartEditingProject={onStartEditingProject}
              onCancelEditingProject={onCancelEditingProject}
              onSaveProjectName={onSaveProjectName}
              onDeleteProject={onDeleteProject}
              onToggleProjectSelection={onToggleProjectSelection}
              onSessionSelect={onSessionSelect}
              onDeleteSession={onDeleteSession}
              onLoadMoreSessions={onLoadMoreSessions}
              onNewSession={onNewSession}
              onEditingSessionNameChange={onEditingSessionNameChange}
              onStartEditingSession={onStartEditingSession}
              onCancelEditingSession={onCancelEditingSession}
              onSaveEditingSession={onSaveEditingSession}
              touchHandlerFactory={touchHandlerFactory}
              t={t}
            />
          ))}
      {showProjects && hasMoreProjects && (
        <div ref={loadMoreRef} className="flex justify-center py-2">
          {isLoadingMoreProjects && <Loader2 className="w-4 h-4 animate-spin text-muted-foreground" />}
        </div>
      )}
    </div>
  );
});

export default SidebarProjectList;
