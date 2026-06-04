import AsyncStorage from '@react-native-async-storage/async-storage';
import { useCallback, useEffect, useState } from 'react';
import { AppState } from 'react-native';
import {
  cancelSession,
  createDexydChatSession,
  createSession,
  deleteSession,
  DexydBridgeConnectionError,
  getSessions,
  patchSessionStatus,
  type AuthTokens,
} from '../api/dexyd-client';
import { DexydSession, EventEnvelope } from '../types/dexyd';
import { errorMessage } from '../utils/error-message';

const SESSION_CACHE_KEY = 'dexyd.sessions.cache.v1';
const SESSION_POLL_INTERVAL_MS = 5000;

function cacheKeyForBridge(bridgeUrl: string): string {
  return `${SESSION_CACHE_KEY}:${bridgeUrl || 'unconfigured'}`;
}

type Connectivity = 'idle' | 'online' | 'offline' | 'error';

function isDexydSession(value: unknown): value is DexydSession {
  if (!value || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.id === 'string' &&
    typeof record.status === 'string' &&
    typeof record.workspacePath === 'string'
  );
}

function mergeSession(
  items: DexydSession[],
  next: DexydSession,
): DexydSession[] {
  const found = items.some(session => session.id === next.id);
  const merged = found
    ? items.map(session =>
        session.id === next.id ? { ...session, ...next } : session,
      )
    : [next, ...items];
  return merged.sort(
    (a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt),
  );
}

function patchSessionActivity(
  items: DexydSession[],
  sessionId: string,
  status: DexydSession['status'],
): DexydSession[] {
  const now = new Date().toISOString();
  const found = items.some(session => session.id === sessionId);
  if (!found) return items;
  return items
    .map(session =>
      session.id === sessionId
        ? {
            ...session,
            status,
            updatedAt: now,
          }
        : session,
    )
    .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
}

export function useSessions(
  bridgeUrl: string,
  tokens: AuthTokens | null,
  lastEvent?: EventEnvelope | null,
) {
  const [sessions, setSessions] = useState<DexydSession[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [connectivity, setConnectivity] = useState<Connectivity>('idle');

  useEffect(() => {
    AsyncStorage.getItem(cacheKeyForBridge(bridgeUrl))
      .then(raw => {
        if (!raw) return;
        const cached = JSON.parse(raw) as DexydSession[];
        if (Array.isArray(cached)) setSessions(cached);
      })
      .catch(() => undefined);
  }, [bridgeUrl]);

  const persist = useCallback(
    async (items: DexydSession[]) => {
      setSessions(items);
      await AsyncStorage.setItem(
        cacheKeyForBridge(bridgeUrl),
        JSON.stringify(items.slice(0, 100)),
      );
    },
    [bridgeUrl],
  );

  const refresh = useCallback(
    async (options: { silent?: boolean } = {}) => {
      if (!tokens) {
        setConnectivity('idle');
        return;
      }

      if (!options.silent) setLoading(true);
      setError(null);
      try {
        const items = await getSessions(bridgeUrl, tokens);
        await persist(items);
        setConnectivity('online');
      } catch (err) {
        const message = errorMessage(err, 'failed to load sessions');
        setError(message);
        setConnectivity(
          err instanceof DexydBridgeConnectionError ||
            message.toLowerCase().includes("can't reach dexyd bridge")
            ? 'offline'
            : 'error',
        );
      } finally {
        if (!options.silent) setLoading(false);
      }
    },
    [bridgeUrl, persist, tokens],
  );

  const create = useCallback(
    async (workspacePath: string, title?: string) => {
      if (!tokens) return null;
      setError(null);
      try {
        const session = await createSession(
          bridgeUrl,
          workspacePath,
          tokens,
          title,
        );
        await refresh();
        return session;
      } catch (err) {
        setError(errorMessage(err, 'failed to create session'));
        return null;
      }
    },
    [bridgeUrl, refresh, tokens],
  );

  const createDexydChat = useCallback(async () => {
    if (!tokens) return null;
    setError(null);
    try {
      const session = await createDexydChatSession(bridgeUrl, tokens);
      await refresh();
      return session;
    } catch (err) {
      setError(errorMessage(err, 'failed to create dexyd help chat'));
      return null;
    }
  }, [bridgeUrl, refresh, tokens]);

  const setStatus = useCallback(
    async (sessionId: string, status: DexydSession['status']) => {
      if (!tokens) return;
      setError(null);
      try {
        await patchSessionStatus(bridgeUrl, sessionId, status, tokens);
        await refresh();
      } catch (err) {
        setError(errorMessage(err, 'failed to update session'));
      }
    },
    [bridgeUrl, refresh, tokens],
  );

  const cancel = useCallback(
    async (sessionId: string) => {
      if (!tokens) return;
      setError(null);
      try {
        await cancelSession(bridgeUrl, sessionId, tokens);
        await refresh();
      } catch (err) {
        setError(errorMessage(err, 'failed to cancel session'));
      }
    },
    [bridgeUrl, refresh, tokens],
  );

  const remove = useCallback(
    async (sessionId: string) => {
      if (!tokens) return false;
      setError(null);
      try {
        await deleteSession(bridgeUrl, sessionId, tokens);
        await persist(sessions.filter(session => session.id !== sessionId));
        await refresh();
        return true;
      } catch (err) {
        setError(errorMessage(err, 'failed to delete session'));
        return false;
      }
    },
    [bridgeUrl, persist, refresh, sessions, tokens],
  );

  const clearCache = useCallback(async () => {
    await AsyncStorage.removeItem(cacheKeyForBridge(bridgeUrl));
    setSessions([]);
    setError(null);
    setConnectivity('idle');
  }, [bridgeUrl]);

  useEffect(() => {
    refresh().catch(() => undefined);
  }, [refresh]);

  useEffect(() => {
    if (!tokens) return undefined;
    const timer = setInterval(() => {
      refresh({ silent: true }).catch(() => undefined);
    }, SESSION_POLL_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [refresh, tokens]);

  useEffect(() => {
    if (!tokens) return undefined;
    const subscription = AppState.addEventListener('change', state => {
      if (state === 'active') {
        refresh({ silent: true }).catch(() => undefined);
      }
    });
    return () => subscription.remove();
  }, [refresh, tokens]);

  useEffect(() => {
    if (!lastEvent) return;
    if (
      lastEvent.eventType === 'session.updated' &&
      isDexydSession(lastEvent.payload)
    ) {
      const next = lastEvent.payload;
      setSessions(current => {
        const merged = mergeSession(current, next);
        AsyncStorage.setItem(
          cacheKeyForBridge(bridgeUrl),
          JSON.stringify(merged.slice(0, 100)),
        ).catch(() => undefined);
        return merged;
      });
      return;
    }
    if (lastEvent.eventType === 'session.deleted' && lastEvent.sessionId) {
      setSessions(current => {
        const next = current.filter(
          session => session.id !== lastEvent.sessionId,
        );
        AsyncStorage.setItem(
          cacheKeyForBridge(bridgeUrl),
          JSON.stringify(next.slice(0, 100)),
        ).catch(() => undefined);
        return next;
      });
      return;
    }
    if (
      (lastEvent.eventType === 'chat.turn.started' ||
        lastEvent.eventType === 'chat.output.delta') &&
      lastEvent.sessionId
    ) {
      setSessions(current => {
        const next = patchSessionActivity(
          current,
          lastEvent.sessionId!,
          'running',
        );
        AsyncStorage.setItem(
          cacheKeyForBridge(bridgeUrl),
          JSON.stringify(next.slice(0, 100)),
        ).catch(() => undefined);
        return next;
      });
      if (lastEvent.eventType === 'chat.turn.started') {
        refresh({ silent: true }).catch(() => undefined);
      }
      return;
    }
    if (
      lastEvent.eventType === 'session.created' ||
      lastEvent.eventType === 'chat.message.assistant' ||
      lastEvent.eventType === 'chat.turn.completed' ||
      lastEvent.eventType === 'chat.turn.failed' ||
      lastEvent.eventType === 'chat.turn.cancelled'
    ) {
      refresh({ silent: true }).catch(() => undefined);
    }
  }, [bridgeUrl, lastEvent, refresh, tokens]);

  return {
    sessions,
    loading,
    error,
    connectivity,
    refresh,
    create,
    createDexydChat,
    setStatus,
    cancel,
    remove,
    clearCache,
  };
}
