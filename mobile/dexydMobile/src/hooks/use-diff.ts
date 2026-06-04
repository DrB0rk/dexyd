import { useCallback, useMemo, useState } from 'react';
import { getDiff, type AuthTokens } from '../api/dexyd-client';
import { DiffSummary } from '../types/api';
import { errorMessage } from '../utils/error-message';

export function useDiff(bridgeUrl: string, tokens: AuthTokens | null, sessionId: string | null) {
  const [diff, setDiff] = useState<DiffSummary | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadingTurnId, setLoadingTurnId] = useState<string | null>(null);
  const [activeTurnId, setActiveTurnId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async (turnId?: string | null) => {
    const normalizedTurnId = turnId?.trim() || null;
    setActiveTurnId(normalizedTurnId);
    if (!tokens || !sessionId) {
      setDiff(null);
      return;
    }
    setLoading(true);
    setLoadingTurnId(normalizedTurnId);
    setError(null);
    try {
      setDiff(await getDiff(bridgeUrl, sessionId, tokens, normalizedTurnId));
    } catch (err) {
      setDiff(null);
      setError(errorMessage(err, 'failed to load diff'));
    } finally {
      setLoading(false);
      setLoadingTurnId(null);
    }
  }, [bridgeUrl, sessionId, tokens]);

  return useMemo(
    () => ({ diff, loading, loadingTurnId, activeTurnId, error, refresh }),
    [activeTurnId, diff, error, loading, loadingTurnId, refresh],
  );
}
