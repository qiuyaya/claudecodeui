import { Folder } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { MainContentStateViewProps } from '../../types/types';
import MobileMenuButton from './MobileMenuButton';

export default function MainContentStateView({ mode, isMobile, onMenuClick }: MainContentStateViewProps) {
  const { t } = useTranslation();

  const isLoading = mode === 'loading';

  return (
    <div className="flex h-full flex-col">
      {isMobile && (
        <div className="pwa-header-safe flex-shrink-0 border-b border-border/50 bg-background/80 p-2 backdrop-blur-sm sm:p-3">
          <MobileMenuButton onMenuClick={onMenuClick} compact />
        </div>
      )}

      {isLoading ? (
        <div className="flex flex-1 flex-col overflow-hidden">
          {/* Skeleton header tabs */}
          <div className="flex animate-pulse items-center gap-2 border-b border-border/50 px-4 py-3">
            {[48, 40, 36, 32].map((w, i) => (
              <div key={i} className="h-7 rounded-md bg-muted/60" style={{ width: `${w}px` }} />
            ))}
          </div>
          {/* Skeleton chat messages */}
          <div className="flex-1 space-y-4 overflow-hidden p-4">
            {/* Assistant message skeleton */}
            <div className="flex items-start gap-3 animate-pulse">
              <div className="h-8 w-8 flex-shrink-0 rounded-full bg-muted/60" />
              <div className="flex-1 space-y-2">
                <div className="h-3.5 w-24 rounded bg-muted/60" />
                <div className="h-3 w-3/4 rounded bg-muted/40" />
                <div className="h-3 w-1/2 rounded bg-muted/40" />
              </div>
            </div>
            {/* User message skeleton */}
            <div className="flex justify-end animate-pulse" style={{ animationDelay: '150ms' }}>
              <div className="h-10 w-48 rounded-2xl bg-blue-600/20" />
            </div>
            {/* Assistant message skeleton */}
            <div className="flex items-start gap-3 animate-pulse" style={{ animationDelay: '300ms' }}>
              <div className="h-8 w-8 flex-shrink-0 rounded-full bg-muted/60" />
              <div className="flex-1 space-y-2">
                <div className="h-3.5 w-24 rounded bg-muted/60" />
                <div className="h-3 w-5/6 rounded bg-muted/40" />
                <div className="h-3 w-2/3 rounded bg-muted/40" />
                <div className="h-3 w-3/5 rounded bg-muted/40" />
              </div>
            </div>
          </div>
          {/* Skeleton input */}
          <div className="animate-pulse border-t border-border/50 p-3">
            <div className="h-12 rounded-xl bg-muted/40" />
          </div>
        </div>
      ) : (
        <div className="flex flex-1 items-center justify-center">
          <div className="mx-auto max-w-md px-6 text-center">
            <div className="mx-auto mb-5 flex h-14 w-14 items-center justify-center rounded-2xl bg-muted/50">
              <Folder className="h-7 w-7 text-muted-foreground" />
            </div>
            <h2 className="mb-2 text-xl font-semibold text-foreground">{t('mainContent.chooseProject')}</h2>
            <p className="mb-5 text-sm leading-relaxed text-muted-foreground">{t('mainContent.selectProjectDescription')}</p>
            <div className="rounded-xl border border-primary/10 bg-primary/5 p-3.5">
              <p className="text-sm text-primary">
                <strong>{t('mainContent.tip')}:</strong> {isMobile ? t('mainContent.createProjectMobile') : t('mainContent.createProjectDesktop')}
              </p>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
