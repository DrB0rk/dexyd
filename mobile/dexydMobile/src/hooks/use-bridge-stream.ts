import { useEffect, useMemo, useRef, useState } from 'react';
import { normalizeBridgeHttpUrl } from '../config/bridge';
import { EventEnvelope } from '../types/dexyd';

type SocketState = 'idle' | 'connecting' | 'open' | 'polling' | 'closed' | 'error';

const MAX_RECONNECT_ATTEMPTS = 8;
const POLL_INTERVAL_MS = 2500;

type ReplayResponse = {
  events: EventEnvelope[];
  nextSequence: number;
  replayExpired: boolean;
};

export function useBridgeStream(
  wsBaseUrl: string,
  httpBaseUrl: string,
  accessToken: string | null,
  onUnauthorized?: () => Promise<void> | void
) {
  const [socketState, setSocketState] = useState<SocketState>('idle');
  const [lastEvent, setLastEvent] = useState<EventEnvelope | null>(null);
  const [socketError, setSocketError] = useState<string | null>(null);
  const [retryNonce, setRetryNonce] = useState(0);
  const lastSeenSequenceRef = useRef(0);
  const reconnectAttemptsRef = useRef(0);
  const pollingRef = useRef(false);

  useEffect(() => {
    if (!accessToken || !wsBaseUrl.trim() || !httpBaseUrl.trim()) {
      setSocketState('idle');
      setLastEvent(null);
      setSocketError(null);
      lastSeenSequenceRef.current = 0;
      reconnectAttemptsRef.current = 0;
      pollingRef.current = false;
      return;
    }

    let closedByCleanup = false;
    let reconnectScheduled = false;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    let pollTimer: ReturnType<typeof setTimeout> | null = null;

    const pollReplay = async () => {
      if (closedByCleanup || !pollingRef.current) return;

      try {
        const response = await fetch(
          `${normalizeBridgeHttpUrl(httpBaseUrl)}/events/replay?lastSeenSequence=${lastSeenSequenceRef.current}`,
          { headers: { Authorization: `Bearer ${accessToken}` } }
        );

        if (response.status === 401) {
          setSocketError('Realtime polling unauthorized. Refreshing credentials…');
          onUnauthorized?.();
          return;
        }

        if (!response.ok) {
          throw new Error(`HTTP ${response.status}`);
        }

        const replay = (await response.json()) as ReplayResponse;
        setSocketError(null);
        for (const event of replay.events) {
          if (typeof event.sequence === 'number' && typeof event.eventType === 'string') {
            lastSeenSequenceRef.current = Math.max(lastSeenSequenceRef.current, event.sequence);
            setLastEvent(event);
          }
        }
        lastSeenSequenceRef.current = Math.max(lastSeenSequenceRef.current, replay.nextSequence ?? lastSeenSequenceRef.current);
      } catch (err) {
        const detail = err instanceof Error ? err.message : 'poll failed';
        setSocketError(`Realtime socket unavailable; polling also failed (${detail}). Check LAN IP and firewall.`);
      } finally {
        if (!closedByCleanup && pollingRef.current) {
          pollTimer = setTimeout(() => {
            pollReplay().catch(() => undefined);
          }, POLL_INTERVAL_MS);
        }
      }
    };

    const startPollingFallback = () => {
      if (pollingRef.current || closedByCleanup) return;
      pollingRef.current = true;
      setSocketState('polling');
      setSocketError(null);
      pollReplay().catch(() => undefined);
    };

    const scheduleReconnect = (reason: string) => {
      startPollingFallback();
      if (closedByCleanup || reconnectScheduled || reconnectAttemptsRef.current >= MAX_RECONNECT_ATTEMPTS) {
        return;
      }

      reconnectScheduled = true;
      reconnectAttemptsRef.current += 1;
      const delayMs = Math.min(1000 * 2 ** (reconnectAttemptsRef.current - 1), 10000);
      if (reconnectAttemptsRef.current >= 3) {
        setSocketError(`${reason} Using HTTP polling; retrying socket in ${Math.round(delayMs / 1000)}s…`);
      }
      retryTimer = setTimeout(() => setRetryNonce((value) => value + 1), delayMs);
    };

    setSocketState('connecting');

    const separator = wsBaseUrl.includes('?') ? '&' : '?';
    const wsUrl = `${wsBaseUrl}${separator}access_token=${encodeURIComponent(accessToken)}`;
    const socket = new WebSocket(wsUrl);

    socket.onopen = () => {
      pollingRef.current = false;
      if (pollTimer) clearTimeout(pollTimer);
      reconnectAttemptsRef.current = 0;
      setSocketState('open');
      setSocketError(null);
      socket.send(JSON.stringify({ type: 'replay.request', lastSeenSequence: lastSeenSequenceRef.current }));
    };

    socket.onclose = (event) => {
      if (closedByCleanup) return;

      setSocketState('closed');
      const detail = event.reason ? `${event.code} ${event.reason}` : String(event.code);

      if (event.code === 4401) {
        setSocketError('Realtime unauthorized. Refreshing credentials…');
        onUnauthorized?.();
        return;
      }

      if (event.code !== 1000) {
        scheduleReconnect(`Realtime connection closed (${detail}).`);
      }
    };

    socket.onerror = () => {
      if (closedByCleanup) return;
      scheduleReconnect(`Cannot open realtime socket at ${wsBaseUrl}.`);
    };

    socket.onmessage = (message) => {
      try {
        const parsed = JSON.parse(message.data as string) as EventEnvelope;
        if (typeof parsed.sequence === 'number' && typeof parsed.eventType === 'string') {
          lastSeenSequenceRef.current = Math.max(lastSeenSequenceRef.current, parsed.sequence);
          setLastEvent(parsed);
        }
      } catch {
        // Ignore non-envelope payloads in this basic client.
      }
    };

    return () => {
      closedByCleanup = true;
      pollingRef.current = false;
      if (retryTimer) clearTimeout(retryTimer);
      if (pollTimer) clearTimeout(pollTimer);
      socket.close(1000, 'client reconnect/reset');
    };
  }, [accessToken, httpBaseUrl, onUnauthorized, retryNonce, wsBaseUrl]);

  return useMemo(
    () => ({
      socketState,
      lastEvent,
      socketError
    }),
    [lastEvent, socketError, socketState]
  );
}
