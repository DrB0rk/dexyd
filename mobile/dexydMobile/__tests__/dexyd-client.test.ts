import { createSession, deleteSession, getQueuedMessages, getSessions, pairingStart, removeQueuedMessage, steerQueuedMessage } from '../src/api/dexyd-client';

const mockFetch = jest.fn();

globalThis.fetch = mockFetch as unknown as typeof fetch;

describe('dexyd client request headers', () => {
  beforeEach(() => {
    mockFetch.mockReset();
    mockFetch.mockResolvedValue({
      ok: true,
      json: jest.fn().mockResolvedValue({ deleted: true, hidden: false, pairingUri: 'dexyd://pair' }),
      text: jest.fn().mockResolvedValue('')
    });
  });

  it('does not send json content-type for empty-body DELETE requests', async () => {
    await deleteSession('http://bridge.local', 'omx-1780346116228-qdcfss', {
      accessToken: 'access-token',
      refreshToken: 'refresh-token'
    });

    expect(mockFetch).toHaveBeenCalledWith(
      'http://bridge.local/sessions/omx-1780346116228-qdcfss',
      expect.objectContaining({
        method: 'DELETE',
        headers: expect.not.objectContaining({ 'Content-Type': 'application/json' })
      })
    );
    expect(mockFetch.mock.calls[0][1].headers).toEqual({ Authorization: 'Bearer access-token' });
  });

  it('sends json content-type when a request has a body', async () => {
    await pairingStart('http://bridge.local');

    expect(mockFetch).toHaveBeenCalledWith(
      'http://bridge.local/pairing/start',
      expect.objectContaining({
        method: 'POST',
        body: '{}',
        headers: expect.objectContaining({ 'Content-Type': 'application/json' })
      })
    );
  });

  it('explains bridge connectivity failures', async () => {
    mockFetch.mockRejectedValueOnce(new Error('Network request failed'));

    await expect(getSessions('http://10.0.0.88:4242', {
      accessToken: 'access-token',
      refreshToken: 'refresh-token'
    })).rejects.toThrow(
      "Can't reach Dexyd bridge at http://10.0.0.88:4242/sessions?limit=2000. Check that the bridge service is running"
    );
  });

  it('includes endpoint context for HTTP API failures', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 503,
      json: jest.fn(),
      text: jest.fn().mockResolvedValue(JSON.stringify({ error: 'bridge_degraded', detail: 'database down' }))
    });

    await expect(getSessions('http://bridge.local', {
      accessToken: 'access-token',
      refreshToken: 'refresh-token'
    })).rejects.toThrow('Bridge returned HTTP 503 for /sessions?limit=2000: database down');
  });

  it('supports queued chat message APIs', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: jest.fn().mockResolvedValue({ queue: [{ queueId: 'queue-1', content: 'queued' }] }),
      text: jest.fn().mockResolvedValue('')
    });

    await expect(getQueuedMessages('http://bridge.local', 'session-1', {
      accessToken: 'access-token',
      refreshToken: 'refresh-token'
    })).resolves.toHaveLength(1);

    await steerQueuedMessage('http://bridge.local', 'session-1', 'queue-1', 'steer it', {
      accessToken: 'access-token',
      refreshToken: 'refresh-token'
    });
    expect(mockFetch).toHaveBeenLastCalledWith(
      'http://bridge.local/sessions/session-1/queue/queue-1/steer',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ message: 'steer it' }),
        headers: expect.objectContaining({ 'Content-Type': 'application/json' })
      })
    );

    await removeQueuedMessage('http://bridge.local', 'session-1', 'queue-1', {
      accessToken: 'access-token',
      refreshToken: 'refresh-token'
    });
    expect(mockFetch).toHaveBeenLastCalledWith(
      'http://bridge.local/sessions/session-1/queue/queue-1',
      expect.objectContaining({
        method: 'DELETE',
        headers: expect.not.objectContaining({ 'Content-Type': 'application/json' })
      })
    );
  });

  it('routes opencode-mode session creation to the OpenCode endpoint', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: jest.fn().mockResolvedValue({
        session: {
          id: 'ses-opencode',
          status: 'idle',
          workspacePath: '/workspace',
          createdAt: '2026-06-12T00:00:00.000Z',
          updatedAt: '2026-06-12T00:00:00.000Z',
          source: 'opencode'
        }
      }),
      text: jest.fn().mockResolvedValue('')
    });

    await expect(createSession('http://bridge.local', '/workspace', {
      accessToken: 'access-token',
      refreshToken: 'refresh-token'
    }, 'New OpenCode', 'opencode')).resolves.toMatchObject({ id: 'ses-opencode', source: 'opencode' });

    expect(mockFetch).toHaveBeenCalledWith(
      'http://bridge.local/opencode/sessions',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ workspacePath: '/workspace', title: 'New OpenCode' }),
        headers: expect.objectContaining({ 'Content-Type': 'application/json' })
      })
    );
  });


});
