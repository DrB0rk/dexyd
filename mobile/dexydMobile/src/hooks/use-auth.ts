import AsyncStorage from '@react-native-async-storage/async-storage';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AppState } from 'react-native';
import {
  DexydApiError,
  DexydBridgeConnectionError,
  pairingComplete,
  refreshTokens,
  revoke,
} from '../api/dexyd-client';
import { normalizeBridgeHttpUrl } from '../config/bridge';
import { errorMessage } from '../utils/error-message';

declare const atob: (input: string) => string;

const LEGACY_STORAGE_KEY = 'dexyd.auth.tokens';
const STORAGE_KEY = 'dexyd.auth.tokens.byBridge.v1';
const ACCESS_REFRESH_SKEW_MS = 2 * 60 * 1000;
const MIN_REFRESH_DELAY_MS = 15 * 1000;

type AuthState = {
  deviceId: string;
  accessToken: string;
  refreshToken: string;
  accessExpiresAt: string;
  refreshExpiresAt: string;
};

type StoredAuthState = {
  activeBridgeUrl?: string;
  tokensByBridge?: Record<string, AuthState>;
};

type PairingCompleteInput = {
  pairingId?: string;
  challenge?: string;
  pairingUri?: string;
  deviceLabel: string;
};

type ParsedPairing = {
  request: PairingCompleteInput;
  bridgeBaseUrl?: string;
};

function safeBridgeKey(input: string): string {
  try {
    return normalizeBridgeHttpUrl(input);
  } catch {
    return '';
  }
}

function parsePairingQuery(pairingUri: string): Record<string, string> {
  const queryStart = pairingUri.indexOf('?');
  if (queryStart === -1) {
    return {};
  }

  return pairingUri
    .slice(queryStart + 1)
    .split('&')
    .filter(Boolean)
    .reduce<Record<string, string>>((acc, part) => {
      const [rawKey, rawValue = ''] = part.split('=');
      const key = decodeURIComponent(rawKey);
      acc[key] = decodeURIComponent(rawValue.replace(/\+/g, ' '));
      return acc;
    }, {});
}

function decodeBase64Url(value: string): string {
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4);
  return atob(padded);
}

function buildPairingCompleteInput(
  pairingUri: string,
  deviceLabel: string,
): ParsedPairing {
  const trimmed = pairingUri.trim();
  const params = parsePairingQuery(trimmed);

  if (trimmed.startsWith('dexyd://pair') && params.payload) {
    try {
      const payload = JSON.parse(decodeBase64Url(params.payload)) as {
        pairingId?: string;
        challenge?: string;
        bridgeBaseUrl?: string;
      };

      if (payload.pairingId && payload.challenge) {
        return {
          request: {
            pairingId: payload.pairingId,
            challenge: payload.challenge,
            deviceLabel,
          },
          bridgeBaseUrl: payload.bridgeBaseUrl,
        };
      }
    } catch {}
  }

  if (
    trimmed.startsWith('dexyd://pair') &&
    params.pairingId &&
    params.challenge
  ) {
    return {
      request: {
        pairingId: params.pairingId,
        challenge: params.challenge,
        deviceLabel,
      },
      bridgeBaseUrl: params.bridgeBaseUrl,
    };
  }

  return {
    request: {
      pairingUri: trimmed,
      deviceLabel,
    },
  };
}

async function readStoredAuth(): Promise<StoredAuthState> {
  const raw = await AsyncStorage.getItem(STORAGE_KEY);
  if (raw) {
    const parsed = JSON.parse(raw) as StoredAuthState;
    return {
      activeBridgeUrl: parsed.activeBridgeUrl,
      tokensByBridge: parsed.tokensByBridge ?? {},
    };
  }

  const legacy = await AsyncStorage.getItem(LEGACY_STORAGE_KEY);
  if (!legacy) {
    return { tokensByBridge: {} };
  }

  const parsedLegacy = JSON.parse(legacy) as AuthState;
  return { tokensByBridge: { legacy: parsedLegacy } };
}

async function writeStoredAuth(next: StoredAuthState): Promise<void> {
  await AsyncStorage.setItem(
    STORAGE_KEY,
    JSON.stringify({
      activeBridgeUrl: next.activeBridgeUrl ?? '',
      tokensByBridge: next.tokensByBridge ?? {},
    }),
  );
  await AsyncStorage.removeItem(LEGACY_STORAGE_KEY);
}

export function useAuth(
  bridgeUrl: string,
  onBridgeUrlFromPairing?: (bridgeUrl: string) => Promise<void> | void,
) {
  const [state, setState] = useState<AuthState | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const refreshInFlightRef = useRef<Promise<void> | null>(null);
  const bridgeKey = useMemo(() => safeBridgeKey(bridgeUrl), [bridgeUrl]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    readStoredAuth()
      .then(async stored => {
        if (cancelled) return;
        const tokensByBridge = stored.tokensByBridge ?? {};
        let nextState = bridgeKey ? (tokensByBridge[bridgeKey] ?? null) : null;

        if (!nextState && bridgeKey && tokensByBridge.legacy) {
          nextState = tokensByBridge.legacy;
          delete tokensByBridge.legacy;
          tokensByBridge[bridgeKey] = nextState;
          await writeStoredAuth({ activeBridgeUrl: bridgeKey, tokensByBridge });
        }

        setState(nextState);
        setError(null);
      })
      .catch(err => setError(errorMessage(err, 'failed to load auth state')))
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [bridgeKey]);

  const persist = useCallback(
    async (next: AuthState | null, targetBridgeUrl = bridgeUrl) => {
      const key = safeBridgeKey(targetBridgeUrl);
      if (!key) {
        setState(null);
        return;
      }

      const stored = await readStoredAuth();
      const tokensByBridge = { ...(stored.tokensByBridge ?? {}) };
      delete tokensByBridge.legacy;

      if (next) {
        tokensByBridge[key] = next;
      } else {
        delete tokensByBridge[key];
      }

      await writeStoredAuth({
        activeBridgeUrl: next
          ? key
          : stored.activeBridgeUrl === key
            ? ''
            : stored.activeBridgeUrl,
        tokensByBridge,
      });

      if (next || key === bridgeKey) {
        setState(next);
      }
    },
    [bridgeKey, bridgeUrl],
  );

  const pairFromUri = useCallback(
    async (pairingUri: string, deviceLabel: string) => {
      setError(null);
      const parsed = buildPairingCompleteInput(pairingUri, deviceLabel);
      const requestBridgeUrl = parsed.bridgeBaseUrl
        ? normalizeBridgeHttpUrl(parsed.bridgeBaseUrl)
        : bridgeUrl;

      if (!requestBridgeUrl.trim()) {
        throw new Error(
          'Pairing QR must include a bridge URL, or set the bridge URL in Settings first.',
        );
      }

      if (parsed.bridgeBaseUrl) {
        await onBridgeUrlFromPairing?.(requestBridgeUrl);
      }

      const response = await pairingComplete(parsed.request, requestBridgeUrl);
      await persist(response, requestBridgeUrl);
      setState(response);
      setError(null);
      return requestBridgeUrl;
    },
    [bridgeUrl, onBridgeUrlFromPairing, persist],
  );

  const refresh = useCallback(async () => {
    if (!state) {
      return;
    }

    if (!bridgeUrl.trim()) {
      setError('Bridge URL is not configured.');
      return;
    }

    if (refreshInFlightRef.current) {
      await refreshInFlightRef.current;
      return;
    }

    const task = (async () => {
      try {
        const next = await refreshTokens(bridgeUrl, state.refreshToken);
        await persist(next, bridgeUrl);
        setError(null);
      } catch (err) {
        const message = errorMessage(err, 'refresh failed');
        const invalidRefreshToken =
          err instanceof DexydApiError &&
          err.status === 401 &&
          (err.code === 'invalid_refresh_token' || err.code === null);

        if (invalidRefreshToken) {
          await persist(null, bridgeUrl);
          setError(message);
          return;
        }

        if (err instanceof DexydBridgeConnectionError) {
          setError(null);
          return;
        }

        setError(message);
      }
    })();

    refreshInFlightRef.current = task;
    try {
      await task;
    } finally {
      if (refreshInFlightRef.current === task) {
        refreshInFlightRef.current = null;
      }
    }
  }, [bridgeUrl, persist, state]);

  useEffect(() => {
    if (!state || !bridgeUrl.trim()) return undefined;
    const expiresAt = Date.parse(state.accessExpiresAt);
    if (!Number.isFinite(expiresAt)) return undefined;
    const delay = Math.max(
      expiresAt - Date.now() - ACCESS_REFRESH_SKEW_MS,
      MIN_REFRESH_DELAY_MS,
    );
    const timer = setTimeout(() => {
      refresh().catch(() => undefined);
    }, delay);
    return () => clearTimeout(timer);
  }, [bridgeUrl, refresh, state]);

  useEffect(() => {
    if (!state || !bridgeUrl.trim()) return undefined;
    const subscription = AppState.addEventListener('change', appState => {
      if (appState !== 'active') return;
      const expiresAt = Date.parse(state.accessExpiresAt);
      if (
        !Number.isFinite(expiresAt) ||
        expiresAt - Date.now() <= ACCESS_REFRESH_SKEW_MS
      ) {
        refresh().catch(() => undefined);
      }
    });
    return () => subscription.remove();
  }, [bridgeUrl, refresh, state]);

  const signOut = useCallback(async () => {
    if (state && bridgeUrl.trim()) {
      try {
        await revoke(bridgeUrl, {
          accessToken: state.accessToken,
          refreshToken: state.refreshToken,
        });
      } catch {}
    }

    await persist(null, bridgeUrl);
    setError(null);
  }, [bridgeUrl, persist, state]);

  return useMemo(
    () => ({
      auth: state,
      loading,
      error,
      pairFromUri,
      refresh,
      signOut,
      setError,
    }),
    [error, loading, pairFromUri, refresh, signOut, state],
  );
}
