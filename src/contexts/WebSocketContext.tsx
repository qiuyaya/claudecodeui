import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { useAuth } from '../components/auth/context/AuthContext';
import { IS_PLATFORM } from '../constants/config';

type MessageHandler = (message: any) => void;

// Stable context - rarely changes (only on connect/disconnect)
type WebSocketConnectionContextType = {
  ws: WebSocket | null;
  sendMessage: (message: any) => void;
  isConnected: boolean;
  subscribe: (handler: MessageHandler) => () => void;
};

// Dynamic context - changes on every message
type WebSocketMessageContextType = {
  latestMessage: any | null;
};

// Combined type for backward compatibility via useWebSocket()
type WebSocketContextType = WebSocketConnectionContextType & WebSocketMessageContextType;

const WebSocketConnectionContext = createContext<WebSocketConnectionContextType | null>(null);
const WebSocketMessageContext = createContext<WebSocketMessageContextType>({ latestMessage: null });

/**
 * Use this hook when you need ALL WebSocket state including latestMessage.
 * Note: This will re-render on every WebSocket message.
 * If you only need sendMessage/subscribe/isConnected, use useWebSocketConnection() instead.
 */
export const useWebSocket = (): WebSocketContextType => {
  const connection = useContext(WebSocketConnectionContext);
  const message = useContext(WebSocketMessageContext);
  if (!connection) {
    throw new Error('useWebSocket must be used within a WebSocketProvider');
  }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  return useMemo(() => ({ ...connection, ...message }), [connection, message]);
};

/**
 * Use this hook when you only need connection state (sendMessage, subscribe, isConnected).
 * This does NOT re-render when messages arrive - use subscribe() for message handling.
 */
export const useWebSocketConnection = (): WebSocketConnectionContextType => {
  const context = useContext(WebSocketConnectionContext);
  if (!context) {
    throw new Error('useWebSocketConnection must be used within a WebSocketProvider');
  }
  return context;
};

const MAX_RECONNECT_DELAY = 30000;
const HEARTBEAT_INTERVAL = 30000;
const MAX_MISSED_PONGS = 2;

const buildWebSocketUrl = () => {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  // No token in URL - token will be passed via subprotocol
  return `${protocol}//${window.location.host}/ws`;
};

export const WebSocketProvider = ({ children }: { children: React.ReactNode }) => {
  const wsRef = useRef<WebSocket | null>(null);
  const unmountedRef = useRef(false);
  const [latestMessage, setLatestMessage] = useState<any>(null);
  const [isConnected, setIsConnected] = useState(false);
  const reconnectTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const heartbeatIntervalRef = useRef<NodeJS.Timeout | null>(null);
  const missedPongsRef = useRef(0);
  const connectRef = useRef<() => void>(() => {});
  const subscribersRef = useRef<Set<MessageHandler>>(new Set());
  const reconnectAttemptsRef = useRef(0);
  const { token } = useAuth();

  // Heartbeat management
  const stopHeartbeat = useCallback(() => {
    if (heartbeatIntervalRef.current) {
      clearInterval(heartbeatIntervalRef.current);
      heartbeatIntervalRef.current = null;
    }
  }, []);

  const startHeartbeat = useCallback(() => {
    stopHeartbeat();
    missedPongsRef.current = 0;
    heartbeatIntervalRef.current = setInterval(() => {
      const socket = wsRef.current;
      if (socket && socket.readyState === WebSocket.OPEN) {
        missedPongsRef.current++;
        if (missedPongsRef.current > MAX_MISSED_PONGS) {
          socket.close(4000, 'Heartbeat timeout');
          return;
        }
        try {
          socket.send(JSON.stringify({ type: 'ping', ts: Date.now() }));
        } catch {
          // Send failed, connection is likely dead
        }
      }
    }, HEARTBEAT_INTERVAL);
  }, [stopHeartbeat]);

  useEffect(() => {
    unmountedRef.current = false;
    connectRef.current();

    return () => {
      if (reconnectTimeoutRef.current) {
        clearTimeout(reconnectTimeoutRef.current);
      }
      stopHeartbeat();
      if (wsRef.current) {
        wsRef.current.close();
        wsRef.current = null;
      }
    };
  }, [token, stopHeartbeat]);

  useEffect(() => {
    return () => {
      unmountedRef.current = true;
    };
  }, []);

  const setupWebSocketHandlers = useCallback((websocket: WebSocket) => {
    websocket.onopen = () => {
      setIsConnected(true);
      wsRef.current = websocket;
      reconnectAttemptsRef.current = 0;
      startHeartbeat();
    };

    websocket.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        if (data.type === 'pong') {
          missedPongsRef.current = 0;
          return;
        }
        setLatestMessage(data);
        subscribersRef.current.forEach(handler => {
          try {
            handler(data);
          } catch (err) {
            console.error('WebSocket subscriber error:', err);
          }
        });
      } catch (error) {
        console.error('Error parsing WebSocket message:', error);
      }
    };

    websocket.onclose = (event) => {
      setIsConnected(false);
      wsRef.current = null;
      stopHeartbeat();

      if (event.code === 1000 || unmountedRef.current) return;

      const attempt = reconnectAttemptsRef.current;
      const baseDelay = Math.min(1000 * Math.pow(2, attempt), MAX_RECONNECT_DELAY);
      const jitter = Math.random() * 1000;
      const delay = baseDelay + jitter;

      reconnectTimeoutRef.current = setTimeout(() => {
        if (unmountedRef.current) return;
        reconnectAttemptsRef.current += 1;
        connectRef.current();
      }, delay);
    };

    websocket.onerror = (error) => {
      console.error('WebSocket error:', error);
    };
  }, [startHeartbeat, stopHeartbeat]);

  const connect = useCallback(() => {
    if (unmountedRef.current) return;
    try {
      const wsUrl = buildWebSocketUrl();

      if (IS_PLATFORM) {
        const websocket = new WebSocket(wsUrl);
        setupWebSocketHandlers(websocket);
        return;
      }

      if (!token) {
        console.warn('No authentication token found for WebSocket connection');
        return;
      }

      const websocket = new WebSocket(wsUrl, [`token.${token}`]);
      setupWebSocketHandlers(websocket);
    } catch (error) {
      console.error('Error creating WebSocket connection:', error);
    }
  }, [token, setupWebSocketHandlers]);

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

  const subscribe = useCallback((handler: MessageHandler) => {
    subscribersRef.current.add(handler);
    return () => { subscribersRef.current.delete(handler); };
  }, []);

  // Connection context value - only changes on connect/disconnect
  const connectionValue: WebSocketConnectionContextType = useMemo(() => ({
    ws: isConnected ? wsRef.current : null,
    sendMessage,
    isConnected,
    subscribe,
  }), [sendMessage, isConnected, subscribe]);

  // Message context value - changes on every message
  const messageValue: WebSocketMessageContextType = useMemo(() => ({
    latestMessage,
  }), [latestMessage]);

  return (
    <WebSocketConnectionContext.Provider value={connectionValue}>
      <WebSocketMessageContext.Provider value={messageValue}>
        {children}
      </WebSocketMessageContext.Provider>
    </WebSocketConnectionContext.Provider>
  );
};

export default WebSocketConnectionContext;
