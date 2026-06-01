import { FastifyInstance } from 'fastify';

export async function pairTestDevice(app: FastifyInstance<any, any, any, any>): Promise<{
  accessToken: string;
  refreshToken: string;
}> {
  const start = await app.inject({ method: 'POST', url: '/pairing/start', payload: {} });
  if (start.statusCode !== 201) {
    throw new Error(`pairing start failed: ${start.statusCode} ${start.body}`);
  }

  const startBody = start.json() as {
    pairingId: string;
    payload: { challenge: string };
  };

  const complete = await app.inject({
    method: 'POST',
    url: '/pairing/complete',
    payload: {
      pairingId: startBody.pairingId,
      challenge: startBody.payload.challenge,
      deviceLabel: 'test-device'
    }
  });

  if (complete.statusCode !== 201) {
    throw new Error(`pairing complete failed: ${complete.statusCode} ${complete.body}`);
  }

  const completeBody = complete.json() as {
    accessToken: string;
    refreshToken: string;
  };

  return {
    accessToken: completeBody.accessToken,
    refreshToken: completeBody.refreshToken
  };
}
