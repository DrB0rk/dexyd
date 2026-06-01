import { useCallback, useEffect, useState } from 'react';
import { getProjects, suggestProjects, type AuthTokens } from '../api/dexyd-client';
import { ProjectBrowseResponse, ProjectSuggestResponse } from '../types/api';
import { errorMessage } from '../utils/error-message';

export function useProjects(bridgeUrl: string, tokens: AuthTokens | null) {
  const [projects, setProjects] = useState<ProjectBrowseResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [suggestions, setSuggestions] = useState<ProjectSuggestResponse | null>(null);

  const refresh = useCallback(async () => {
    if (!tokens) {
      setProjects(null);
      return;
    }

    setLoading(true);
    setError(null);
    try {
      setProjects(await getProjects(bridgeUrl, tokens));
    } catch (err) {
      setError(errorMessage(err, 'failed to load projects'));
    } finally {
      setLoading(false);
    }
  }, [bridgeUrl, tokens]);

  const browse = useCallback(
    async (path = '') => {
      if (!tokens) return null;
      setLoading(true);
      setError(null);
      try {
        const next = await getProjects(bridgeUrl, tokens, path);
        setProjects(next);
        return next;
      } catch (err) {
        setError(errorMessage(err, 'failed to browse projects'));
        return null;
      } finally {
        setLoading(false);
      }
    },
    [bridgeUrl, tokens],
  );

  const suggest = useCallback(
    async (path = '') => {
      if (!tokens) return null;
      setError(null);
      try {
        const next = await suggestProjects(bridgeUrl, tokens, path);
        setSuggestions(next);
        return next;
      } catch (err) {
        setError(errorMessage(err, 'failed to suggest projects'));
        setSuggestions(null);
        return null;
      }
    },
    [bridgeUrl, tokens],
  );

  useEffect(() => {
    refresh().catch(() => undefined);
  }, [refresh]);

  return {
    projects,
    loading,
    error,
    refresh,
    browse,
    suggestions,
    suggest,
  };
}
