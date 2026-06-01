import { useCallback, useEffect, useMemo, useState } from 'react';
import { listFiles, readFile, type AuthTokens } from '../api/dexyd-client';
import { FileEntry, FileReadResponse } from '../types/api';
import { errorMessage } from '../utils/error-message';

export function useFiles(bridgeUrl: string, tokens: AuthTokens | null, sessionId: string | null) {
  const [path, setPath] = useState('');
  const [entries, setEntries] = useState<FileEntry[]>([]);
  const [preview, setPreview] = useState<FileReadResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!tokens || !sessionId) {
      setEntries([]);
      setPreview(null);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const result = await listFiles(bridgeUrl, sessionId, path, tokens);
      setEntries(result.entries);
      setPreview(null);
    } catch (err) {
      setError(errorMessage(err, 'failed to list files'));
    } finally {
      setLoading(false);
    }
  }, [bridgeUrl, path, sessionId, tokens]);

  const openEntry = useCallback(
    async (entry: FileEntry) => {
      if (entry.type === 'directory') {
        setPath(entry.path);
        return;
      }
      if (!tokens || !sessionId || entry.type !== 'file') return;
      setLoading(true);
      setError(null);
      try {
        setPreview(await readFile(bridgeUrl, sessionId, entry.path, tokens));
      } catch (err) {
        setError(errorMessage(err, 'failed to read file'));
      } finally {
        setLoading(false);
      }
    },
    [bridgeUrl, sessionId, tokens]
  );

  const goUp = useCallback(() => {
    setPath((current) => current.split('/').filter(Boolean).slice(0, -1).join('/'));
  }, []);

  useEffect(() => {
    refresh().catch(() => undefined);
  }, [refresh]);

  return useMemo(() => ({ path, entries, preview, loading, error, refresh, openEntry, goUp }), [entries, error, goUp, loading, openEntry, path, preview, refresh]);
}
