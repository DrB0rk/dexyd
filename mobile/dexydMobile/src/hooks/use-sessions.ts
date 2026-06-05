import AsyncStorage from '@react-native-async-storage/async-storage';
import { useCallback, useEffect, useState } from 'react';
import { AppState } from 'react-native';
import {
  cancelSession,
  createDexydChatSession,
  createSession,
  deleteSession,
  DexydBridgeConnectionError,
  getHiddenSessions,
  getSessions,
  patchSessionStatus,
  restoreSession,
  type AuthTokens,
} from '../api/dexyd-client';
import {
  DexydSession,
  EventEnvelope,
  HiddenDexydSession,
} from '../types/dexyd';
import { errorMessage } from '../utils/error-message';

const SESSION_CACHE_KEY = 'dexyd.sessions.cache.v1';
const SESSION_POLL_INTERVAL_MS = 5000;

function cacheKeyForBridge(
  bridgeUrl: string,
  workspacePath?: string | null,
): string {
  return `${SESSION_CACHE_KEY}:${bridgeUrl || 'unconfigured'}:${
    workspacePath || 'all'
  }`;
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
  workspacePath?: string | null,
) {
  const [sessions, setSessions] = useState<DexydSession[]>([]);
  const [hiddenSessions, setHiddenSessions] = useState<HiddenDexydSession[]>(
    [],
  );
  const [hiddenLoading, setHiddenLoading] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [connectivity, setConnectivity] = useState<Connectivity>('idle');

  useEffect(() => {
    AsyncStorage.getItem(cacheKeyForBridge(bridgeUrl, workspacePath))
      .then(raw => {
        if (!raw) return;
        const cached = JSON.parse(raw) as DexydSession[];
        if (Array.isArray(cached)) setSessions(cached);
      })
      .catch(() => undefined);
  }, [bridgeUrl, workspacePath]);

  const persist = useCallback(
    async (items: DexydSession[]) => {
      setSessions(items);
      await AsyncStorage.setItem(
        cacheKeyForBridge(bridgeUrl, workspacePath),
        JSON.stringify(items.slice(0, 100)),
      );
    },
    [bridgeUrl, workspacePath],
  );

  const refresh = useCallback(
    async (options: { silent?: boolean } = {}) => {
      if (!tokens) {
        setConnectivity('idle');
        return;
      }

      if (!options.silent) {
        setLoading(true);
        setError(null);
      }
      try {
        const items = await getSessions(bridgeUrl, tokens, {
          workspacePath: workspacePath || undefined,
        });
        await persist(items);
        setError(null);
        setConnectivity('online');
      } catch (err) {
        const message = errorMessage(err, 'failed to load sessions');
        if (!options.silent || sessions.length === 0) {
          setError(message);
        }
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
    [bridgeUrl, persist, sessions.length, tokens, workspacePath],
  );

  const create = useCallback(
    async (targetWorkspacePath: string, title?: string) => {
      if (!tokens) return null;
      setError(null);
      try {
        const session = await createSession(
          bridgeUrl,
          targetWorkspacePath,
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

  const refreshHidden = useCallback(async () => {
    if (!tokens) {
      setHiddenSessions([]);
      return;
    }
    setHiddenLoading(true);
    try {
      const items = await getHiddenSessions(bridgeUrl, tokens);
      setHiddenSessions(items);
      setError(null);
    } catch (err) {
      setError(errorMessage(err, 'failed to load deleted sessions'));
    } finally {
      setHiddenLoading(false);
    }
  }, [bridgeUrl, tokens]);

  const restore = useCallback(
    async (sessionId: string) => {
      if (!tokens) return false;
      setError(null);
      try {
        await restoreSession(bridgeUrl, sessionId, tokens);
        await refresh();
        await refreshHidden();
        return true;
      } catch (err) {
        setError(errorMessage(err, 'failed to restore session'));
        return false;
      }
    },
    [bridgeUrl, refresh, refreshHidden, tokens],
  );

  const clearCache = useCallback(async () => {
    await AsyncStorage.removeItem(cacheKeyForBridge(bridgeUrl, workspacePath));
    setSessions([]);
    setError(null);
    setConnectivity('idle');
  }, [bridgeUrl, workspacePath]);

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
          cacheKeyForBridge(bridgeUrl, workspacePath),
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
          cacheKeyForBridge(bridgeUrl, workspacePath),
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
          cacheKeyForBridge(bridgeUrl, workspacePath),
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
      lastEvent.eventType === 'replay.expired' ||
      lastEvent.eventType === 'session.created' ||
      lastEvent.eventType === 'chat.message.assistant' ||
      lastEvent.eventType === 'chat.turn.completed' ||
      lastEvent.eventType === 'chat.turn.failed' ||
      lastEvent.eventType === 'chat.turn.cancelled'
    ) {
      refresh({ silent: true }).catch(() => undefined);
    }
  }, [bridgeUrl, lastEvent, refresh, tokens, workspacePath]);

  return {
    sessions,
    hiddenSessions,
    hiddenLoading,
    loading,
    error,
    connectivity,
    refresh,
    create,
    createDexydChat,
    setStatus,
    cancel,
    remove,
    restore,
    refreshHidden,
    clearCache,
  };
}
