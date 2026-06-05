import { useCallback, useEffect, useMemo, useState } from 'react';
import { getCommands, type AuthTokens } from '../api/dexyd-client';
import { SlashCommand } from '../types/api';
import { errorMessage } from '../utils/error-message';

export function useSlashCommands(
  bridgeUrl: string,
  tokens: AuthTokens | null,
  sessionId: string | null,
) {
  const [commands, setCommands] = useState<SlashCommand[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!tokens) {
      setCommands([]);
      setError(null);
      return;
    }

    setLoading(true);
    setError(null);
    try {
      const next = await getCommands(bridgeUrl, tokens, sessionId);
      setCommands(next.commands);
      setError(null);
    } catch (err) {
      setError(errorMessage(err, 'failed to load commands'));
    } finally {
      setLoading(false);
    }
  }, [bridgeUrl, sessionId, tokens]);

  useEffect(() => {
    refresh().catch(() => undefined);
  }, [refresh]);

  return useMemo(
    () => ({ commands, loading, error, refresh }),
    [commands, error, loading, refresh],
  );
}
