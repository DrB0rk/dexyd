import { useCallback, useEffect, useState } from 'react';
import {
  getCodexAuthStatus,
  switchCodexAuthAccount,
  type AuthTokens,
} from '../api/dexyd-client';
import { CodexAuthStatus } from '../types/api';
import { errorMessage } from '../utils/error-message';

export function useCodexAuth(bridgeUrl: string, tokens: AuthTokens | null) {
  const [status, setStatus] = useState<CodexAuthStatus | null>(null);
  const [loading, setLoading] = useState(false);
  const [switching, setSwitching] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!tokens) {
      setStatus(null);
      return;
    }

    setLoading(true);
    setError(null);
    try {
      setStatus(await getCodexAuthStatus(bridgeUrl, tokens));
    } catch (err) {
      setError(errorMessage(err, 'failed to load codex-auth status'));
    } finally {
      setLoading(false);
    }
  }, [bridgeUrl, tokens]);

  const switchAccount = useCallback(
    async (query: string) => {
      if (!tokens) return false;
      setSwitching(query);
      setError(null);
      try {
        setStatus(await switchCodexAuthAccount(bridgeUrl, tokens, query));
        return true;
      } catch (err) {
        setError(errorMessage(err, 'failed to switch account'));
        return false;
      } finally {
        setSwitching(null);
      }
    },
    [bridgeUrl, tokens],
  );

  useEffect(() => {
    refresh().catch(() => undefined);
  }, [refresh]);

  return {
    status,
    loading,
    switching,
    error,
    refresh,
    switchAccount,
  };
}
