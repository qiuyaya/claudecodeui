import { memo, useEffect, useRef } from 'react';
import { ChevronDown, Plus } from 'lucide-react';
import type { TFunction } from 'i18next';
import { Button } from '../../../../shared/view/ui';
import type { Project, ProjectSession, SessionProvider } from '../../../../types/app';
import type { SessionWithProvider } from '../../types/types';
import SidebarSessionItem from './SidebarSessionItem';

type SidebarProjectSessionsProps = {
  project: Project;
  isExpanded: boolean;
  sessions: SessionWithProvider[];
  selectedSession: ProjectSession | null;
  initialSessionsLoaded: boolean;
  isLoadingSessions: boolean;
  currentTime: Date;
  editingSession: string | null;
  editingSessionName: string;
  onEditingSessionNameChange: (value: string) => void;
  onStartEditingSession: (sessionId: string, initialName: string) => void;
  onCancelEditingSession: () => void;
  onSaveEditingSession: (projectName: string, sessionId: string, summary: string, provider: SessionProvider) => void;
  onProjectSelect: (project: Project) => void;
  onSessionSelect: (session: SessionWithProvider, projectName: string) => void;
  onDeleteSession: (
    projectName: string,
    sessionId: string,
    sessionTitle: string,
    provider: SessionProvider,
  ) => void;
  onLoadMoreSessions: (project: Project) => void;
  onNewSession: (project: Project) => void;
  t: TFunction;
};

function SessionListSkeleton() {
  return (
    <>
      {Array.from({ length: 3 }).map((_, index) => (
        <div key={index} className="rounded-md p-2">
          <div className="flex items-start gap-2">
            <div className="mt-0.5 h-3 w-3 animate-pulse rounded-full bg-muted" />
            <div className="flex-1 space-y-1">
              <div className="h-3 animate-pulse rounded bg-muted" style={{ width: `${60 + index * 15}%` }} />
              <div className="h-2 w-1/2 animate-pulse rounded bg-muted" />
            </div>
          </div>
        </div>
      ))}
    </>
  );
}

function SessionLoadMoreButton({
  project,
  isLoadingSessions,
  onLoadMoreSessions,
  t,
}: {
  project: Project;
  isLoadingSessions: boolean;
  onLoadMoreSessions: (project: Project) => void;
  t: TFunction;
}) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const element = ref.current;
    if (!element) return;

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0].isIntersecting && !isLoadingSessions) {
          onLoadMoreSessions(project);
        }
      },
      { threshold: 0.1, rootMargin: '50px' },
    );

    observer.observe(element);
    return () => observer.disconnect();
  }, [isLoadingSessions, onLoadMoreSessions, project]);

  return (
    <div ref={ref}>
      <Button
        variant="ghost"
        size="sm"
        className="w-full justify-center gap-2 mt-2 text-muted-foreground"
        disabled={isLoadingSessions}
      >
        {isLoadingSessions ? (
          <>
            <div className="w-3 h-3 animate-spin rounded-full border border-muted-foreground border-t-transparent" />
            {t('sessions.loading')}
          </>
        ) : (
          <>
            <ChevronDown className="w-3 h-3" />
            {t('sessions.showMore')}
          </>
        )}
      </Button>
    </div>
  );
}

const SidebarProjectSessions = memo(function SidebarProjectSessions({
  project,
  isExpanded,
  sessions,
  selectedSession,
  initialSessionsLoaded,
  isLoadingSessions,
  currentTime,
  editingSession,
  editingSessionName,
  onEditingSessionNameChange,
  onStartEditingSession,
  onCancelEditingSession,
  onSaveEditingSession,
  onProjectSelect,
  onSessionSelect,
  onDeleteSession,
  onLoadMoreSessions,
  onNewSession,
  t,
}: SidebarProjectSessionsProps) {
  if (!isExpanded) {
    return null;
  }

  const hasSessions = sessions.length > 0;
  const hasMoreSessions = project.sessionMeta?.hasMore === true;

  return (
    <div className="ml-3 space-y-1 border-l border-border pl-3">
      {/* New Session Button - Desktop (Top) */}
      <Button
        variant="default"
        size="sm"
        className="hidden md:flex w-full justify-start gap-2 mb-1 h-8 text-xs font-medium bg-primary hover:bg-primary/90 text-primary-foreground transition-colors"
        onClick={() => onNewSession(project)}
      >
        <Plus className="w-3 h-3" />
        {t('sessions.newSession')}
      </Button>

      {/* New Session Button - Mobile (Top) */}
      <div className="md:hidden px-3 pb-2">
        <button
          className="w-full h-8 bg-primary hover:bg-primary/90 text-primary-foreground rounded-md flex items-center justify-center gap-2 font-medium text-xs active:scale-[0.98] transition-all duration-150"
          onClick={() => {
            onProjectSelect(project);
            onNewSession(project);
          }}
        >
          <Plus className="w-3 h-3" />
          {t('sessions.newSession')}
        </button>
      </div>

      {!initialSessionsLoaded ? (
        <SessionListSkeleton />
      ) : !hasSessions && !isLoadingSessions ? (
        <div className="px-3 py-2 text-left">
          <p className="text-xs text-muted-foreground">{t('sessions.noSessions')}</p>
        </div>
      ) : (
        sessions.map((session) => (
          <SidebarSessionItem
            key={session.id}
            project={project}
            session={session}
            selectedSession={selectedSession}
            currentTime={currentTime}
            editingSession={editingSession}
            editingSessionName={editingSessionName}
            onEditingSessionNameChange={onEditingSessionNameChange}
            onStartEditingSession={onStartEditingSession}
            onCancelEditingSession={onCancelEditingSession}
            onSaveEditingSession={onSaveEditingSession}
            onProjectSelect={onProjectSelect}
            onSessionSelect={onSessionSelect}
            onDeleteSession={onDeleteSession}
            t={t}
          />
        ))
      )}

      {hasSessions && hasMoreSessions && (
        <SessionLoadMoreButton
          project={project}
          isLoadingSessions={isLoadingSessions}
          onLoadMoreSessions={onLoadMoreSessions}
          t={t}
        />
      )}
    </div>
  );
});

export default SidebarProjectSessions;
