import { useCallback, useEffect, useState } from 'react';
import { getDevices, revokeDevice, type AuthTokens } from '../api/dexyd-client';
import { DeviceRecord } from '../types/api';
import { errorMessage } from '../utils/error-message';

export function useDevices(bridgeUrl: string, tokens: AuthTokens | null) {
  const [devices, setDevices] = useState<DeviceRecord[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!tokens) {
      setDevices([]);
      return;
    }

    setLoading(true);
    setError(null);
    try {
      const items = await getDevices(bridgeUrl, tokens);
      setDevices(items);
    } catch (err) {
      setError(errorMessage(err, 'failed to load devices'));
    } finally {
      setLoading(false);
    }
  }, [bridgeUrl, tokens]);

  const revoke = useCallback(
    async (deviceId: string) => {
      if (!tokens) return;
      setError(null);
      try {
        setDevices(current => current.filter(device => device.id !== deviceId));
        await revokeDevice(bridgeUrl, deviceId, tokens);
        await refresh();
      } catch (err) {
        setError(errorMessage(err, 'failed to revoke device'));
      }
    },
    [bridgeUrl, refresh, tokens]
  );

  useEffect(() => {
    refresh().catch(() => undefined);
  }, [refresh]);

  return {
    devices,
    loading,
    error,
    refresh,
    revoke
  };
}
