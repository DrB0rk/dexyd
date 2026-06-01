import AsyncStorage from '@react-native-async-storage/async-storage';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { bridgeHttpToWsUrl, DEFAULT_BRIDGE_HTTP_URL, isLoopbackBridgeUrl, normalizeBridgeHttpUrl } from '../config/bridge';
import { errorMessage } from '../utils/error-message';

const STORAGE_KEY = 'dexyd.bridge.settings';

export type BridgeProfile = {
  id: string;
  label: string;
  bridgeUrl: string;
  lastUsedAt: string;
};

type StoredBridgeSettings = {
  bridgeUrl?: string;
  activeBridgeId?: string;
  bridges?: BridgeProfile[];
};

function profileId(url: string): string {
  return normalizeBridgeHttpUrl(url).replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 80) || 'bridge';
}

function labelFromUrl(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return 'Bridge';
  }
}

function upsertBridge(bridges: BridgeProfile[], bridgeUrl: string, label?: string): BridgeProfile[] {
  const normalized = normalizeBridgeHttpUrl(bridgeUrl);
  const id = profileId(normalized);
  const next: BridgeProfile = {
    id,
    bridgeUrl: normalized,
    label: label?.trim() || labelFromUrl(normalized),
    lastUsedAt: new Date().toISOString(),
  };
  return [next, ...bridges.filter(item => item.id !== id && item.bridgeUrl !== normalized)].slice(0, 12);
}

export function useBridgeSettings() {
  const [bridgeUrl, setBridgeUrlState] = useState(DEFAULT_BRIDGE_HTTP_URL);
  const [draftBridgeUrl, setDraftBridgeUrl] = useState(DEFAULT_BRIDGE_HTTP_URL);
  const [bridges, setBridges] = useState<BridgeProfile[]>([]);
  const [activeBridgeId, setActiveBridgeId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const persistState = useCallback(async (nextBridges: BridgeProfile[], nextActiveId: string | null) => {
    const active = nextBridges.find(item => item.id === nextActiveId) ?? nextBridges[0] ?? null;
    await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify({
      activeBridgeId: active?.id ?? null,
      bridgeUrl: active?.bridgeUrl ?? '',
      bridges: nextBridges,
    }));
    setBridges(nextBridges);
    setActiveBridgeId(active?.id ?? null);
    setBridgeUrlState(active?.bridgeUrl ?? DEFAULT_BRIDGE_HTTP_URL);
    setDraftBridgeUrl(active?.bridgeUrl ?? DEFAULT_BRIDGE_HTTP_URL);
  }, []);

  useEffect(() => {
    AsyncStorage.getItem(STORAGE_KEY)
      .then(async (raw) => {
        if (!raw) return;
        const parsed = JSON.parse(raw) as StoredBridgeSettings;
        let nextBridges = (parsed.bridges ?? []).filter(item => item.bridgeUrl && !isLoopbackBridgeUrl(item.bridgeUrl));
        if (parsed.bridgeUrl && !isLoopbackBridgeUrl(parsed.bridgeUrl)) {
          nextBridges = upsertBridge(nextBridges, parsed.bridgeUrl);
        }
        await persistState(nextBridges, parsed.activeBridgeId ?? nextBridges[0]?.id ?? null);
      })
      .catch((err) => setError(errorMessage(err, 'failed to load bridge settings')))
      .finally(() => setLoading(false));
  }, [persistState]);

  const persistBridgeUrl = useCallback(async (next: string, label?: string) => {
    if (isLoopbackBridgeUrl(next)) {
      throw new Error('Loopback bridge URLs are not supported. Use the LAN URL from the pairing QR or your Caddy domain.');
    }
    const normalized = normalizeBridgeHttpUrl(next);
    const nextBridges = upsertBridge(bridges, normalized, label);
    const activeId = profileId(normalized);
    await persistState(nextBridges, activeId);
    setError(null);
    return normalized;
  }, [bridges, persistState]);

  const saveBridgeUrl = useCallback(async () => {
    try {
      await persistBridgeUrl(draftBridgeUrl);
      return true;
    } catch (err) {
      setError(errorMessage(err, 'failed to save bridge URL'));
      return false;
    }
  }, [draftBridgeUrl, persistBridgeUrl]);

  const resetBridgeUrl = useCallback(async () => {
    try {
      await AsyncStorage.removeItem(STORAGE_KEY);
      setBridgeUrlState(DEFAULT_BRIDGE_HTTP_URL);
      setDraftBridgeUrl(DEFAULT_BRIDGE_HTTP_URL);
      setBridges([]);
      setActiveBridgeId(null);
      setError(null);
      return true;
    } catch (err) {
      setError(errorMessage(err, 'failed to clear bridge URL'));
      return false;
    }
  }, []);

  const setBridgeUrlFromPairing = useCallback(
    async (next: string) => {
      await persistBridgeUrl(next);
    },
    [persistBridgeUrl]
  );

  const switchBridge = useCallback(async (id: string) => {
    await persistState(bridges, id);
  }, [bridges, persistState]);

  const removeBridge = useCallback(async (id: string) => {
    const next = bridges.filter(item => item.id !== id);
    await persistState(next, activeBridgeId === id ? next[0]?.id ?? null : activeBridgeId);
  }, [activeBridgeId, bridges, persistState]);

  return useMemo(
    () => ({
      bridgeUrl,
      wsUrl: bridgeHttpToWsUrl(bridgeUrl),
      draftBridgeUrl,
      setDraftBridgeUrl,
      bridges,
      activeBridgeId,
      switchBridge,
      removeBridge,
      loading,
      error,
      saveBridgeUrl,
      resetBridgeUrl,
      setBridgeUrlFromPairing,
      setError
    }),
    [activeBridgeId, bridgeUrl, bridges, draftBridgeUrl, error, loading, removeBridge, resetBridgeUrl, saveBridgeUrl, setBridgeUrlFromPairing, switchBridge]
  );
}
