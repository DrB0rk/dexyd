import AsyncStorage from '@react-native-async-storage/async-storage';
import { useCallback, useEffect, useState } from 'react';
import {
  cancelSession,
  createDexydChatSession,
  createSession,
  deleteSession,
  getSessions,
  patchSessionStatus,
  type AuthTokens,
} from '../api/dexyd-client';
import { DexydSession } from '../types/dexyd';
import { errorMessage } from '../utils/error-message';

const SESSION_CACHE_KEY = 'dexyd.sessions.cache.v1';

function cacheKeyForBridge(bridgeUrl: string): string {
  return `${SESSION_CACHE_KEY}:${bridgeUrl || 'unconfigured'}`;
}

type Connectivity = 'idle' | 'online' | 'offline' | 'error';

export function useSessions(bridgeUrl: string, tokens: AuthTokens | null) {
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

  const persist = useCallback(async (items: DexydSession[]) => {
    setSessions(items);
    await AsyncStorage.setItem(cacheKeyForBridge(bridgeUrl), JSON.stringify(items.slice(0, 100)));
  }, [bridgeUrl]);

  const refresh = useCallback(async () => {
    if (!tokens) {
      setConnectivity('idle');
      return;
    }

    setLoading(true);
    setError(null);
    try {
      const items = await getSessions(bridgeUrl, tokens);
      await persist(items);
      setConnectivity('online');
    } catch (err) {
      const message = errorMessage(err, 'failed to load sessions');
      setError(message);
      setConnectivity(message.toLowerCase().includes('network') || message.toLowerCase().includes('failed to fetch') ? 'offline' : 'error');
    } finally {
      setLoading(false);
    }
  }, [bridgeUrl, persist, tokens]);

  const create = useCallback(
    async (workspacePath: string, title?: string) => {
      if (!tokens) return null;
      setError(null);
      try {
        const session = await createSession(bridgeUrl, workspacePath, tokens, title);
        await refresh();
        return session;
      } catch (err) {
        setError(errorMessage(err, 'failed to create session'));
        return null;
      }
    },
    [bridgeUrl, refresh, tokens]
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
    [bridgeUrl, refresh, tokens]
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
    [bridgeUrl, refresh, tokens]
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
    [bridgeUrl, persist, refresh, sessions, tokens]
  );

  const clearCache = useCallback(async () => {
    await AsyncStorage.removeItem(cacheKeyForBridge(bridgeUrl));
    setSessions([]);
  }, [bridgeUrl]);

  useEffect(() => {
    refresh().catch(() => undefined);
  }, [refresh]);

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
