import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AppState } from 'react-native';
import { normalizeBridgeHttpUrl } from '../config/bridge';
import { EventEnvelope } from '../types/dexyd';

type SocketState =
  | 'idle'
  | 'connecting'
  | 'open'
  | 'polling'
  | 'closed'
  | 'error';

const POLL_INTERVAL_MS = 2500;
const MAX_RECONNECT_DELAY_MS = 15000;
const POLL_TIMEOUT_MS = 10000;

type ReplayResponse = {
  events: EventEnvelope[];
  nextSequence: number;
  replayExpired: boolean;
  snapshot?: { sequence?: number };
};

export function useBridgeStream(
  wsBaseUrl: string,
  httpBaseUrl: string,
  accessToken: string | null,
  onUnauthorized?: () => Promise<void> | void,
) {
  const [socketState, setSocketState] = useState<SocketState>('idle');
  const [lastEvent, setLastEvent] = useState<EventEnvelope | null>(null);
  const [socketError, setSocketError] = useState<string | null>(null);
  const [retryNonce, setRetryNonce] = useState(0);
  const lastSeenSequenceRef = useRef(0);
  const reconnectAttemptsRef = useRef(0);
  const pollingRef = useRef(false);
  const onUnauthorizedRef = useRef(onUnauthorized);
  const streamKeyRef = useRef('');
  const eventQueueRef = useRef<EventEnvelope[]>([]);
  const eventDrainTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearQueuedEvents = useCallback(() => {
    eventQueueRef.current = [];
    if (eventDrainTimerRef.current) {
      clearTimeout(eventDrainTimerRef.current);
      eventDrainTimerRef.current = null;
    }
  }, []);

  const drainQueuedEvents = useCallback(() => {
    eventDrainTimerRef.current = null;
    const next = eventQueueRef.current.shift();
    if (!next) return;
    setLastEvent(next);
    if (eventQueueRef.current.length > 0) {
      eventDrainTimerRef.current = setTimeout(drainQueuedEvents, 0);
    }
  }, []);

  const enqueueEvent = useCallback(
    (event: EventEnvelope) => {
      eventQueueRef.current.push(event);
      if (!eventDrainTimerRef.current) {
        eventDrainTimerRef.current = setTimeout(drainQueuedEvents, 0);
      }
    },
    [drainQueuedEvents],
  );

  useEffect(() => {
    onUnauthorizedRef.current = onUnauthorized;
  }, [onUnauthorized]);

  useEffect(() => {
    if (!accessToken) {
      setSocketState('idle');
      setLastEvent(null);
      clearQueuedEvents();
      setSocketError(null);
      lastSeenSequenceRef.current = 0;
      reconnectAttemptsRef.current = 0;
      pollingRef.current = false;
      streamKeyRef.current = '';
      return;
    }

    if (!httpBaseUrl.trim()) {
      setSocketState('error');
      setSocketError(
        'Bridge URL is not configured. Re-pair or choose a bridge profile.',
      );
      pollingRef.current = false;
      return;
    }

    let normalizedHttpUrl = '';
    try {
      normalizedHttpUrl = normalizeBridgeHttpUrl(httpBaseUrl);
      const nextStreamKey = `${normalizedHttpUrl}|${accessToken.slice(0, 24)}`;
      if (streamKeyRef.current !== nextStreamKey) {
        lastSeenSequenceRef.current = 0;
        reconnectAttemptsRef.current = 0;
        streamKeyRef.current = nextStreamKey;
      }
    } catch (err) {
      setSocketState('error');
      setSocketError(
        err instanceof Error ? err.message : 'Bridge URL is invalid.',
      );
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
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), POLL_TIMEOUT_MS);
        let response: Response;
        try {
          response = await fetch(
            `${normalizedHttpUrl}/events/replay?lastSeenSequence=${lastSeenSequenceRef.current}`,
            {
              headers: { Authorization: `Bearer ${accessToken}` },
              signal: controller.signal,
            },
          );
        } finally {
          clearTimeout(timeout);
        }

        if (response.status === 401) {
          setSocketError(
            'Realtime polling unauthorized. Refreshing credentials…',
          );
          onUnauthorizedRef.current?.();
          return;
        }

        if (!response.ok) {
          throw new Error(`HTTP ${response.status}`);
        }

        const replay = (await response.json()) as ReplayResponse;
        setSocketError(null);
        if (replay.replayExpired) {
          const sequence = replay.snapshot?.sequence ?? replay.nextSequence;
          if (typeof sequence === 'number') {
            lastSeenSequenceRef.current = Math.max(
              lastSeenSequenceRef.current,
              sequence,
            );
            enqueueEvent({
              sequence,
              eventType: 'replay.expired',
              source: 'stream',
              sessionId: null,
              streamId: null,
              timestamp: new Date().toISOString(),
              payload: replay.snapshot ?? null,
            });
          }
        }
        for (const event of replay.events) {
          if (
            typeof event.sequence === 'number' &&
            typeof event.eventType === 'string'
          ) {
            lastSeenSequenceRef.current = Math.max(
              lastSeenSequenceRef.current,
              event.sequence,
            );
            enqueueEvent(event);
          }
        }
        lastSeenSequenceRef.current = Math.max(
          lastSeenSequenceRef.current,
          replay.nextSequence ?? lastSeenSequenceRef.current,
        );
      } catch (err) {
        const detail = err instanceof Error ? err.message : 'poll failed';
        if (reconnectAttemptsRef.current >= 2) {
          setSocketError(
            `Realtime socket unavailable; polling also failed (${detail}). Check LAN IP and firewall.`,
          );
        }
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
      if (closedByCleanup || reconnectScheduled) {
        return;
      }

      reconnectScheduled = true;
      reconnectAttemptsRef.current += 1;
      const delayMs = Math.min(
        1000 * 2 ** (reconnectAttemptsRef.current - 1),
        MAX_RECONNECT_DELAY_MS,
      );
      if (reconnectAttemptsRef.current >= 3) {
        setSocketError(
          `${reason} Using HTTP polling; retrying socket in ${Math.round(delayMs / 1000)}s…`,
        );
      }
      retryTimer = setTimeout(() => setRetryNonce(value => value + 1), delayMs);
    };

    setSocketState('connecting');

    if (!wsBaseUrl.trim()) {
      startPollingFallback();
      return () => {
        closedByCleanup = true;
        pollingRef.current = false;
        if (retryTimer) clearTimeout(retryTimer);
        if (pollTimer) clearTimeout(pollTimer);
        clearQueuedEvents();
      };
    }

    const separator = wsBaseUrl.includes('?') ? '&' : '?';
    const wsUrl = `${wsBaseUrl}${separator}access_token=${encodeURIComponent(accessToken)}`;
    const socket = new WebSocket(wsUrl);

    socket.onopen = () => {
      pollingRef.current = false;
      if (pollTimer) clearTimeout(pollTimer);
      reconnectAttemptsRef.current = 0;
      setSocketState('open');
      setSocketError(null);
      socket.send(
        JSON.stringify({
          type: 'replay.request',
          lastSeenSequence: lastSeenSequenceRef.current,
        }),
      );
    };

    socket.onclose = event => {
      if (closedByCleanup) return;

      setSocketState('closed');
      const detail = event.reason
        ? `${event.code} ${event.reason}`
        : String(event.code);

      if (event.code === 4401) {
        setSocketError('Realtime unauthorized. Refreshing credentials…');
        onUnauthorizedRef.current?.();
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

    socket.onmessage = message => {
      try {
        const parsed = JSON.parse(message.data as string) as EventEnvelope & {
          type?: string;
          nextSequence?: number;
          snapshot?: { sequence?: number };
        };
        if (
          typeof parsed.sequence === 'number' &&
          typeof parsed.eventType === 'string'
        ) {
          lastSeenSequenceRef.current = Math.max(
            lastSeenSequenceRef.current,
            parsed.sequence,
          );
          enqueueEvent(parsed);
          return;
        }
        if (
          parsed.type === 'replay.completed' &&
          typeof parsed.nextSequence === 'number'
        ) {
          lastSeenSequenceRef.current = Math.max(
            lastSeenSequenceRef.current,
            parsed.nextSequence,
          );
          return;
        }
        if (
          parsed.type === 'replay.expired' &&
          typeof parsed.snapshot?.sequence === 'number'
        ) {
          lastSeenSequenceRef.current = Math.max(
            lastSeenSequenceRef.current,
            parsed.snapshot.sequence,
          );
          enqueueEvent({
            sequence: parsed.snapshot.sequence,
            eventType: 'replay.expired',
            source: 'stream',
            sessionId: null,
            streamId: null,
            timestamp: new Date().toISOString(),
            payload: parsed.snapshot,
          });
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
      clearQueuedEvents();
      socket.close(1000, 'client reconnect/reset');
    };
  }, [accessToken, clearQueuedEvents, enqueueEvent, httpBaseUrl, retryNonce, wsBaseUrl]);

  useEffect(() => {
    if (!accessToken) return undefined;
    const subscription = AppState.addEventListener('change', state => {
      if (state === 'active' && socketState !== 'open') {
        setRetryNonce(value => value + 1);
      }
    });
    return () => subscription.remove();
  }, [accessToken, socketState]);

  return useMemo(
    () => ({
      socketState,
      lastEvent,
      socketError,
    }),
    [lastEvent, socketError, socketState],
  );
}
