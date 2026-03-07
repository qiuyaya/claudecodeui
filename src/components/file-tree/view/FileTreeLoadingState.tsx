import { useTranslation } from 'react-i18next';

export default function FileTreeLoadingState() {
  const { t } = useTranslation();

  return (
    <div className="flex h-full flex-col gap-2 p-3">
      {/* Skeleton file tree items */}
      {[85, 120, 65, 100, 140, 75, 110, 90].map((width, i) => (
        <div key={i} className="flex animate-pulse items-center gap-2" style={{ paddingLeft: `${(i % 3) * 12}px` }}>
          <div className="h-4 w-4 rounded bg-gray-200 dark:bg-gray-700" />
          <div
            className="h-3.5 rounded bg-gray-200 dark:bg-gray-700"
            style={{ width: `${width}px` }}
          />
        </div>
      ))}
      <div className="mt-2 text-center text-xs text-muted-foreground">{t('fileTree.loading')}</div>
    </div>
  );
}
