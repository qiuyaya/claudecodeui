import { useEffect, useRef } from 'react';
import { useWebSocketConnection } from '../../contexts/WebSocketContext';
import { useToast } from '../../contexts/ToastContext';

export default function ConnectionStatusBar() {
  const { isConnected } = useWebSocketConnection();
  const { success } = useToast();
  const wasDisconnectedRef = useRef(false);

  useEffect(() => {
    if (!isConnected) {
      wasDisconnectedRef.current = true;
    } else if (wasDisconnectedRef.current) {
      wasDisconnectedRef.current = false;
      success('Connection restored');
    }
  }, [isConnected, success]);

  if (isConnected) return null;

  return (
    <div className="fixed left-0 right-0 top-0 z-50 flex items-center justify-center gap-2 bg-red-600 px-3 py-1.5 text-xs font-medium text-white shadow-lg">
      <span className="relative flex h-2 w-2">
        <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-red-300 opacity-75" />
        <span className="relative inline-flex h-2 w-2 rounded-full bg-red-200" />
      </span>
      <span>Connection lost. Reconnecting...</span>
    </div>
  );
}
