import { afterEach, describe, expect, it, vi } from 'vitest';
import { OpenCodeServerError, OpenCodeServerManager } from '../src/services/opencode-server-manager.js';

type LoggerLike = {
  info: (obj: unknown, msg?: string) => void;
  warn: (obj: unknown, msg?: string) => void;
  error: (obj: unknown, msg?: string) => void;
  debug: (obj: unknown, msg?: string) => void;
};

function makeLogger(): LoggerLike {
  return { info: () => undefined, warn: () => undefined, error: () => undefined, debug: () => undefined };
}

describe('OpenCodeServerManager', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('reports disabled when enabled=false', () => {
    const manager = new OpenCodeServerManager(
      {
        enabled: false,
        runtimePath: 'opencode',
        host: '127.0.0.1',
        port: 4243,
        startTimeoutMs: 1000,
        healthTimeoutMs: 500,
        cors: [],
        mdns: false,
        mdnsDomain: 'opencode.local',
        extraArgs: []
      },
      makeLogger()
    );

    expect(manager.isEnabled()).toBe(false);
    // The initial state is "stopped" until start() flips it to "disabled"
    expect(manager.state.status).toBe('stopped');
  });

  it('builds serve args with cors and mdns', () => {
    const manager = new OpenCodeServerManager(
      {
        enabled: true,
        runtimePath: 'opencode',
        host: '127.0.0.1',
        port: 4243,
        startTimeoutMs: 1000,
        healthTimeoutMs: 500,
        cors: ['https://example.com'],
        mdns: true,
        mdnsDomain: 'foo.local',
        extraArgs: ['--verbose']
      },
      makeLogger()
    );

    const args = manager.buildServeArgs();
    expect(args).toContain('serve');
    expect(args).toContain('--hostname');
    expect(args).toContain('127.0.0.1');
    expect(args).toContain('--port');
    expect(args).toContain('4243');
    expect(args).toContain('--mdns');
    expect(args).toContain('--mdns-domain');
    expect(args).toContain('foo.local');
    expect(args).toContain('--cors');
    expect(args).toContain('https://example.com');
    expect(args).toContain('--verbose');
  });

  it('omits empty mdns domain', () => {
    const manager = new OpenCodeServerManager(
      {
        enabled: true,
        runtimePath: 'opencode',
        host: '127.0.0.1',
        port: 4243,
        startTimeoutMs: 1000,
        healthTimeoutMs: 500,
        cors: [],
        mdns: false,
        mdnsDomain: '',
        extraArgs: []
      },
      makeLogger()
    );

    const args = manager.buildServeArgs();
    expect(args).not.toContain('--mdns-domain');
  });

  it('injects OPENCODE_SERVER_PASSWORD env when password is set', () => {
    const manager = new OpenCodeServerManager(
      {
        enabled: true,
        runtimePath: 'opencode',
        host: '127.0.0.1',
        port: 4243,
        startTimeoutMs: 1000,
        healthTimeoutMs: 500,
        password: 'secret',
        cors: [],
        mdns: false,
        mdnsDomain: 'opencode.local',
        extraArgs: []
      },
      makeLogger()
    );

    const env = manager.buildEnv();
    expect(env.OPENCODE_SERVER_PASSWORD).toBe('secret');
  });

  it('throws OpenCodeServerError on start when disabled', async () => {
    const manager = new OpenCodeServerManager(
      {
        enabled: false,
        runtimePath: 'opencode',
        host: '127.0.0.1',
        port: 4243,
        startTimeoutMs: 1000,
        healthTimeoutMs: 500,
        cors: [],
        mdns: false,
        mdnsDomain: 'opencode.local',
        extraArgs: []
      },
      makeLogger()
    );

    await expect(manager.start()).rejects.toThrow(OpenCodeServerError);
  });

  it('resolveInstallHint returns a useful message', () => {
    const manager = new OpenCodeServerManager(
      {
        enabled: true,
        runtimePath: 'opencode',
        host: '127.0.0.1',
        port: 4243,
        startTimeoutMs: 1000,
        healthTimeoutMs: 500,
        cors: [],
        mdns: false,
        mdnsDomain: 'opencode.local',
        extraArgs: []
      },
      makeLogger()
    );
    expect(manager.resolveInstallHint()).toContain('Install OpenCode');
  });
});
