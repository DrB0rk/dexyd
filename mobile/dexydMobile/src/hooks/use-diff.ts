import { useCallback, useEffect, useMemo, useState } from 'react';
import { getDiff, type AuthTokens } from '../api/dexyd-client';
import { DiffSummary } from '../types/api';
import { errorMessage } from '../utils/error-message';

export function useDiff(bridgeUrl: string, tokens: AuthTokens | null, sessionId: string | null) {
  const [diff, setDiff] = useState<DiffSummary | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!tokens || !sessionId) {
      setDiff(null);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      setDiff(await getDiff(bridgeUrl, sessionId, tokens));
    } catch (err) {
      setError(errorMessage(err, 'failed to load diff'));
    } finally {
      setLoading(false);
    }
  }, [bridgeUrl, sessionId, tokens]);

  useEffect(() => {
    refresh().catch(() => undefined);
  }, [refresh]);

  return useMemo(() => ({ diff, loading, error, refresh }), [diff, error, loading, refresh]);
}
