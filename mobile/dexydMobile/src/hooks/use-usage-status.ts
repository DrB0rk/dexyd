import { useCallback, useEffect, useMemo, useState } from 'react';
import { getUsageStatus, type AuthTokens } from '../api/dexyd-client';
import { UsageStatus } from '../types/api';
import { EventEnvelope } from '../types/dexyd';
import { errorMessage } from '../utils/error-message';

export function useUsageStatus(
  bridgeUrl: string,
  tokens: AuthTokens | null,
  sessionId: string | null,
  lastEvent: EventEnvelope | null,
) {
  const [usage, setUsage] = useState<UsageStatus | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!tokens) {
      setUsage(null);
      return;
    }

    setLoading(true);
    setError(null);
    try {
      setUsage(await getUsageStatus(bridgeUrl, tokens, sessionId));
    } catch (err) {
      setError(errorMessage(err, 'failed to load usage'));
    } finally {
      setLoading(false);
    }
  }, [bridgeUrl, sessionId, tokens]);

  useEffect(() => {
    refresh().catch(() => undefined);
  }, [refresh]);

  useEffect(() => {
    if (!tokens) return undefined;
    const timer = setInterval(() => {
      refresh().catch(() => undefined);
    }, 15000);
    return () => clearInterval(timer);
  }, [refresh, tokens]);

  useEffect(() => {
    if (
      !lastEvent ||
      !(
        lastEvent.eventType === 'token_count' ||
        lastEvent.eventType.startsWith('chat.') ||
        lastEvent.eventType === 'session.updated'
      )
    ) {
      return;
    }
    refresh().catch(() => undefined);
  }, [lastEvent, refresh]);

  return useMemo(
    () => ({ usage, loading, error, refresh }),
    [error, loading, refresh, usage],
  );
}
