import { deleteSession, pairingStart } from '../src/api/dexyd-client';

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
});
