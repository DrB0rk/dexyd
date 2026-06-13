import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createServer, Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { OpenCodeApiClient, OpenCodeApiError } from '../src/services/opencode-api-client.js';

const listeners: Array<{ method: string; path: string; handler: (body: unknown) => unknown }> = [];
let mockServer: Server | null = null;
let baseUrl = '';

function startMock(handlers: typeof listeners): Promise<void> {
  return new Promise((resolve) => {
    mockServer = createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://localhost');
      const matched = handlers.find((h) => h.method === req.method && url.pathname === h.path);
      if (!matched) {
        res.statusCode = 404;
        res.end(JSON.stringify({ error: 'not_found' }));
        return;
      }
      let body: unknown = null;
      let raw = '';
      req.on('data', (chunk: Buffer) => {
        raw += chunk.toString();
      });
      req.on('end', () => {
        try {
          body = raw ? JSON.parse(raw) : null;
        } catch {
          body = raw;
        }
        const result = matched.handler(body);
        res.statusCode = 200;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify(result));
      });
    });
    mockServer.listen(0, '127.0.0.1', () => {
      const address = mockServer!.address() as AddressInfo;
      baseUrl = `http://127.0.0.1:${address.port}`;
      resolve();
    });
  });
}

function stopMock(): Promise<void> {
  return new Promise((resolve) => {
    if (!mockServer) return resolve();
    mockServer.close(() => {
      mockServer = null;
      resolve();
    });
  });
}

describe('OpenCodeApiClient', () => {
  afterEach(async () => {
    listeners.length = 0;
    if (mockServer) await stopMock();
  });

  it('listSessions returns parsed JSON', async () => {
    await startMock([
      {
        method: 'GET',
        path: '/session',
        handler: () => [{ id: 'ses-1', title: 'Hello' }]
      }
    ]);
    const client = new OpenCodeApiClient({ baseUrl, timeoutMs: 1000, retries: 0 });
    const sessions = await client.listSessions();
    expect(sessions).toHaveLength(1);
    expect(sessions[0]?.id).toBe('ses-1');
  });

  it('listSkills/Agents/Tools/Commands/Providers/Models surface typed data', async () => {
    await startMock([
      { method: 'GET', path: '/agent', handler: () => [{ name: 'build', mode: 'primary' }] },
      { method: 'GET', path: '/skill', handler: () => [{ name: 'plan' }] },
      { method: 'GET', path: '/experimental/tool', handler: () => [{ id: 'bash' }] },
      { method: 'GET', path: '/command', handler: () => [{ name: 'commit' }] },
      { method: 'GET', path: '/config/providers', handler: () => ({ connected: [{ id: 'anthropic' }] }) }
    ]);
    const client = new OpenCodeApiClient({ baseUrl, timeoutMs: 1000, retries: 0 });
    expect(await client.listAgents()).toEqual([{ name: 'build', mode: 'primary' }]);
    expect(await client.listSkills()).toEqual([{ name: 'plan' }]);
    expect(await client.listTools()).toEqual([{ id: 'bash' }]);
    expect(await client.listCommands()).toEqual([{ name: 'commit' }]);
    expect(await client.listProviders()).toEqual([{ id: 'anthropic' }]);
  });

  it('falls back to /experimental/tool/ids when /experimental/tool returns 404', async () => {
    const server = createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://localhost');
      if (req.method === 'GET' && url.pathname === '/experimental/tool') {
        res.statusCode = 404;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: 'not_found' }));
        return;
      }
      if (req.method === 'GET' && url.pathname === '/experimental/tool/ids') {
        res.statusCode = 200;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ ids: ['bash', 'read'] }));
        return;
      }
      res.statusCode = 404;
      res.end();
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const address = server.address() as AddressInfo;
    const client = new OpenCodeApiClient({ baseUrl: `http://127.0.0.1:${address.port}`, timeoutMs: 1000, retries: 0 });
    const tools = await client.listTools();
    expect(tools).toEqual([{ id: 'bash' }, { id: 'read' }]);
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('createSession sends POST with payload', async () => {
    let received: { method: string; url: string; body: unknown } | null = null;
    await startMock([
      {
        method: 'POST',
        path: '/session',
        handler: (body: unknown) => {
          received = { method: 'POST', url: '/session', body };
          return { id: 'new', title: 'demo' };
        }
      }
    ]);
    const client = new OpenCodeApiClient({ baseUrl, timeoutMs: 1000, retries: 0 });
    const result = await client.createSession({ title: 'demo', agent: 'build' });
    expect(result.id).toBe('new');
    expect(received?.body).toEqual({ title: 'demo', agent: 'build' });
  });

  it('replyPermission/replyQuestion send POST', async () => {
    let lastBody: unknown = null;
    await startMock([
      {
        method: 'POST',
        path: '/permission/req-1/reply',
        handler: (body: unknown) => {
          lastBody = body;
          return { ok: true };
        }
      },
      {
        method: 'POST',
        path: '/question/q-1/reply',
        handler: (body: unknown) => {
          lastBody = body;
          return { ok: true };
        }
      }
    ]);
    const client = new OpenCodeApiClient({ baseUrl, timeoutMs: 1000, retries: 0 });
    await client.replyPermission('req-1', 'allow');
    expect(lastBody).toEqual({ decision: 'allow' });
    await client.replyQuestion('q-1', ['yes']);
    expect(lastBody).toEqual({ answers: ['yes'] });
  });

  it('getSession returns null on 404', async () => {
    const server = createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://localhost');
      if (req.method === 'GET' && url.pathname === '/session/missing') {
        res.statusCode = 404;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: 'not_found' }));
        return;
      }
      res.statusCode = 404;
      res.end();
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const address = server.address() as AddressInfo;
    const client = new OpenCodeApiClient({ baseUrl: `http://127.0.0.1:${address.port}`, timeoutMs: 1000, retries: 0 });
    const result = await client.getSession('missing');
    expect(result).toBeNull();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('throws OpenCodeApiError on 500', async () => {
    const server = createServer((_req, res) => {
      res.statusCode = 500;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ error: 'internal' }));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const address = server.address() as AddressInfo;
    const client = new OpenCodeApiClient({ baseUrl: `http://127.0.0.1:${address.port}`, timeoutMs: 1000, retries: 0 });
    await expect(client.listSessions()).rejects.toThrow(OpenCodeApiError);
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('addEventListener fires for emitted events', () => {
    const client = new OpenCodeApiClient({ baseUrl, timeoutMs: 1000, retries: 0 });
    const events: unknown[] = [];
    client.addEventListener((event) => events.push(event));
    expect(typeof client.addEventListener).toBe('function');
  });

  it('subscribeEvents yields parsed events from SSE stream', async () => {
    const handlers: typeof listeners = [];
    const server = createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://localhost');
      if (req.method === 'GET' && url.pathname === '/event') {
        res.statusCode = 200;
        res.setHeader('Content-Type', 'text/event-stream');
        res.write('event: server.connected\ndata: {"baseUrl":"http://x"}\n\n');
        res.write('event: session.next.text.delta\ndata: {"sessionID":"s1","messageID":"m1","text":"hi"}\n\n');
        res.end();
        return;
      }
      res.statusCode = 404;
      res.end();
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const address = server.address() as AddressInfo;
    const client = new OpenCodeApiClient({ baseUrl: `http://127.0.0.1:${address.port}`, timeoutMs: 1000, retries: 0 });

    const collected: unknown[] = [];
    for await (const event of client.subscribeEvents()) {
      collected.push(event);
      if (collected.length >= 2) break;
    }
    expect(collected).toHaveLength(2);
    expect((collected[0] as { type: string }).type).toBe('server.connected');
    expect((collected[1] as { type: string }).type).toBe('session.next.text.delta');

    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
});
