import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { useAuth } from '../components/auth/context/AuthContext';
import { IS_PLATFORM } from '../constants/config';

type WebSocketContextType = {
  ws: WebSocket | null;
  sendMessage: (message: any) => void;
  latestMessage: any | null;
  isConnected: boolean;
};

const WebSocketContext = createContext<WebSocketContextType | null>(null);

export const useWebSocket = () => {
  const context = useContext(WebSocketContext);
  if (!context) {
    throw new Error('useWebSocket must be used within a WebSocketProvider');
  }
  return context;
};

const buildWebSocketUrl = () => {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  // No token in URL - token will be passed via subprotocol
  return `${protocol}//${window.location.host}/ws`;
};

const useWebSocketProviderState = (): WebSocketContextType => {
  const wsRef = useRef<WebSocket | null>(null);
  const unmountedRef = useRef(false); // Track if component is unmounted
  const [latestMessage, setLatestMessage] = useState<any>(null);
  const [isConnected, setIsConnected] = useState(false);
  const reconnectTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const connectRef = useRef<() => void>(() => {});
  const { token } = useAuth();

  useEffect(() => {
    unmountedRef.current = false; // Reset on each token change
    connectRef.current();

    return () => {
      if (reconnectTimeoutRef.current) {
        clearTimeout(reconnectTimeoutRef.current);
      }
      if (wsRef.current) {
        wsRef.current.close();
        wsRef.current = null;
      }
    };
  }, [token]); // everytime token changes, we reconnect

  // Track actual unmount separately
  useEffect(() => {
    return () => {
      unmountedRef.current = true;
    };
  }, []);

  // Setup WebSocket event handlers
  const setupWebSocketHandlers = useCallback((websocket: WebSocket) => {
    websocket.onopen = () => {
      setIsConnected(true);
      wsRef.current = websocket;
    };

    websocket.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        setLatestMessage(data);
      } catch (error) {
        console.error('Error parsing WebSocket message:', error);
      }
    };

    websocket.onclose = () => {
      setIsConnected(false);
      wsRef.current = null;

      // Attempt to reconnect after 3 seconds
      reconnectTimeoutRef.current = setTimeout(() => {
        if (unmountedRef.current) return; // Prevent reconnection if unmounted
        connectRef.current();
      }, 3000);
    };

    websocket.onerror = (error) => {
      console.error('WebSocket error:', error);
    };
  }, []);

  const connect = useCallback(() => {
    if (unmountedRef.current) return; // Prevent connection if unmounted
    try {
      // Construct WebSocket URL (without token)
      const wsUrl = buildWebSocketUrl();

      // Platform mode: connect without token
      if (IS_PLATFORM) {
        const websocket = new WebSocket(wsUrl);
        setupWebSocketHandlers(websocket);
        return;
      }

      // OSS mode: pass token via subprotocol (not in URL for security)
      if (!token) {
        console.warn('No authentication token found for WebSocket connection');
        return;
      }

      // Create WebSocket with token in subprotocol
      // The subprotocol format is "token.<actual_token>"
      const websocket = new WebSocket(wsUrl, [`token.${token}`]);
      setupWebSocketHandlers(websocket);

    } catch (error) {
      console.error('Error creating WebSocket connection:', error);
    }
  }, [token, setupWebSocketHandlers]);

  // Keep connectRef in sync with the latest connect function
  useEffect(() => {
    connectRef.current = connect;
  }, [connect]);

  const sendMessage = useCallback((message: any) => {
    const socket = wsRef.current;
    if (socket && socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify(message));
    } else {
      console.warn('WebSocket not connected');
    }
  }, []);

  const value: WebSocketContextType = useMemo(() =>
  ({
    ws: isConnected ? wsRef.current : null,
    sendMessage,
    latestMessage,
    isConnected
  }), [sendMessage, latestMessage, isConnected]);

  return value;
};

export const WebSocketProvider = ({ children }: { children: React.ReactNode }) => {
  const webSocketData = useWebSocketProviderState();

  return (
    <WebSocketContext.Provider value={webSocketData}>
      {children}
    </WebSocketContext.Provider>
  );
};

export default WebSocketContext;
