import { ChildProcess, spawn } from 'node:child_process';
import { connect } from 'node:net';
import { setTimeout as wait } from 'node:timers/promises';

type LoggerLike = {
  info: (obj: unknown, msg?: string) => void;
  warn: (obj: unknown, msg?: string) => void;
  error: (obj: unknown, msg?: string) => void;
  debug: (obj: unknown, msg?: string) => void;
};

export type OpenCodeServerConfig = {
  enabled: boolean;
  runtimePath: string;
  host: string;
  port: number;
  startTimeoutMs: number;
  healthTimeoutMs: number;
  password?: string;
  cors: string[];
  mdns: boolean;
  mdnsDomain: string;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  extraArgs: string[];
};

export type OpenCodeServerHandle = {
  baseUrl: string;
  host: string;
  port: number;
  pid: number | null;
  startedAt: string;
};

export type OpenCodeServerState = {
  status: 'disabled' | 'starting' | 'ready' | 'degraded' | 'failed' | 'stopped';
  handle: OpenCodeServerHandle | null;
  error: string | null;
  checkedAt: string;
  version: string | null;
  installHint: string | null;
};

export class OpenCodeServerError extends Error {
  readonly code: string;
  constructor(message: string, code = 'opencode_server_error') {
    super(message);
    this.name = 'OpenCodeServerError';
    this.code = code;
  }
}

const DEFAULT_START_TIMEOUT_MS = 15_000;
const DEFAULT_HEALTH_TIMEOUT_MS = 4_000;

export class OpenCodeServerManager {
  #child: ChildProcess | null = null;
  #state: OpenCodeServerState = {
    status: 'stopped',
    handle: null,
    error: null,
    checkedAt: new Date(0).toISOString(),
    version: null,
    installHint: null
  };

  constructor(
    private readonly config: OpenCodeServerConfig,
    private readonly logger: LoggerLike
  ) {}

  get state(): OpenCodeServerState {
    return { ...this.#state };
  }

  isEnabled(): boolean {
    return Boolean(this.config.enabled);
  }

  baseUrl(): string | null {
    if (this.#state.status === 'ready' && this.#state.handle) {
      return this.#state.handle.baseUrl;
    }
    return `http://${this.config.host}:${this.config.port}`;
  }

  resolveInstallHint(): string {
    return 'Install OpenCode: https://opencode.ai (or `npm i -g opencode-ai@latest`) and ensure `opencode` is on PATH.';
  }

  async start(): Promise<OpenCodeServerHandle> {
    if (!this.config.enabled) {
      const error = 'opencode integration is disabled in config';
      this.#updateState({ status: 'disabled', error });
      throw new OpenCodeServerError(error, 'opencode_disabled');
    }

    if (this.#child && this.#state.status === 'ready' && this.#state.handle) {
      return this.#state.handle;
    }

    if (this.#child && this.#state.status === 'starting') {
      return this.waitForHandle(this.config.startTimeoutMs || DEFAULT_START_TIMEOUT_MS);
    }

    this.#updateState({ status: 'starting', error: null });

    const args = this.buildServeArgs();
    const env = this.buildEnv();
    const cwd = this.config.cwd ?? process.cwd();

    this.logger.info(
      { runtimePath: this.config.runtimePath, host: this.config.host, port: this.config.port, args },
      'starting opencode serve daemon'
    );

    let child: ChildProcess;
    try {
      child = spawn(this.config.runtimePath, args, {
        cwd,
        env,
        stdio: ['ignore', 'pipe', 'pipe']
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'spawn failed';
      this.#updateState({ status: 'failed', error: `failed to spawn opencode: ${message}` });
      throw new OpenCodeServerError(`failed to spawn opencode: ${message}`, 'spawn_failed');
    }

    this.#child = child;

    child.stdout?.on('data', (chunk: Buffer) => {
      this.logger.debug({ opencode: chunk.toString('utf8').trim() }, 'opencode stdout');
    });

    child.stderr?.on('data', (chunk: Buffer) => {
      this.logger.debug({ opencode: chunk.toString('utf8').trim() }, 'opencode stderr');
    });

    child.on('error', (error) => {
      this.logger.warn({ error }, 'opencode process errored');
      this.#updateState({ status: 'failed', error: `opencode process errored: ${error.message}` });
      this.#child = null;
    });

    child.on('exit', (code, signal) => {
      this.logger.warn({ code, signal }, 'opencode process exited');
      this.#updateState({
        status: 'failed',
        error:
          code === 0
            ? 'opencode exited before being ready'
            : `opencode exited with code ${code ?? 'null'} signal ${signal ?? 'none'}`
      });
      this.#child = null;
    });

    const startTimeoutMs = this.config.startTimeoutMs || DEFAULT_START_TIMEOUT_MS;
    try {
      const handle = await this.waitForHandle(startTimeoutMs);
      this.#updateState({ status: 'ready', error: null, handle });
      this.logger.info({ baseUrl: handle.baseUrl, pid: handle.pid }, 'opencode serve daemon ready');
      return handle;
    } catch (error) {
      this.#updateState({
        status: 'failed',
        error: error instanceof Error ? error.message : 'opencode failed to become ready'
      });
      this.stop();
      throw error;
    }
  }

  async ensureReady(): Promise<OpenCodeServerHandle | null> {
    if (!this.config.enabled) return null;
    if (this.#state.status === 'ready' && this.#state.handle) {
      const healthy = await this.healthCheck(this.#state.handle);
      if (healthy.healthy) return this.#state.handle;
    }
    // If a server is already listening on the configured port, adopt it
    // instead of spawning a duplicate process. This makes the bridge
    // coexist with externally-managed opencode serve daemons.
    const existing = await probePort(this.config.host, this.config.port, 500);
    if (existing) {
      const handle = this.#deriveHandle(this.config.host, this.config.port);
      const healthy = await this.healthCheck(handle);
      if (healthy.healthy) {
        this.#updateState({ status: 'ready', error: null, handle });
        this.logger.info({ baseUrl: handle.baseUrl }, 'adopted existing opencode serve daemon');
        return handle;
      }
    }
    return this.start();
  }

  async waitForHandle(timeoutMs: number): Promise<OpenCodeServerHandle> {
    const deadline = Date.now() + Math.max(1_000, timeoutMs);
    let lastError: string | null = null;

    while (Date.now() < deadline) {
      if (!this.#child) {
        throw new OpenCodeServerError('opencode process exited before becoming ready', 'process_exited');
      }
      const candidate = this.#deriveHandle(this.config.host, this.config.port);
      const health = await this.healthCheck(candidate).catch((error) => {
        lastError = error instanceof Error ? error.message : 'health check failed';
        return null;
      });
      if (health?.healthy) {
        return candidate;
      }
      await wait(200);
    }

    throw new OpenCodeServerError(
      `opencode did not become ready within ${timeoutMs}ms (last error: ${lastError ?? 'unknown'})`,
      'start_timeout'
    );
  }

  async healthCheck(handle: OpenCodeServerHandle): Promise<{ healthy: boolean; version: string | null }> {
    const url = `${handle.baseUrl}/global/health`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.config.healthTimeoutMs || DEFAULT_HEALTH_TIMEOUT_MS);
    try {
      const response = await fetch(url, { signal: controller.signal });
      if (!response.ok) return { healthy: false, version: null };
      const body = (await response.json().catch(() => null)) as { healthy?: boolean; version?: string } | null;
      const version = body?.version ?? null;
      if (body?.healthy && version) {
        this.#state = { ...this.#state, version };
      }
      return { healthy: Boolean(body?.healthy), version };
    } catch {
      return { healthy: false, version: null };
    } finally {
      clearTimeout(timer);
    }
  }

  stop(): void {
    if (!this.#child) {
      this.#updateState({ status: 'stopped', error: null });
      return;
    }
    try {
      this.#child.kill('SIGTERM');
    } catch (error) {
      this.logger.warn({ error }, 'failed to send SIGTERM to opencode');
    }
    this.#child = null;
    this.#updateState({ status: 'stopped', error: null });
  }

  async dispose(): Promise<void> {
    this.stop();
  }

  buildServeArgs(): string[] {
    const args: string[] = ['serve'];
    args.push('--hostname', this.config.host);
    args.push('--port', String(this.config.port));
    if (this.config.mdns) args.push('--mdns');
    if (this.config.mdnsDomain) args.push('--mdns-domain', this.config.mdnsDomain);
    for (const origin of this.config.cors) {
      const trimmed = origin.trim();
      if (trimmed) args.push('--cors', trimmed);
    }
    for (const arg of this.config.extraArgs) {
      const trimmed = arg.trim();
      if (trimmed) args.push(trimmed);
    }
    return args;
  }

  buildEnv(): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = { ...(this.config.env ?? process.env) };
    if (this.config.password) {
      env.OPENCODE_SERVER_PASSWORD = this.config.password;
    }
    return env;
  }

  #deriveHandle(host: string, port: number): OpenCodeServerHandle {
    return {
      baseUrl: `http://${host}:${port}`,
      host,
      port,
      pid: this.#child?.pid ?? null,
      startedAt: new Date().toISOString()
    };
  }

  #updateState(patch: Partial<OpenCodeServerState>): void {
    this.#state = {
      ...this.#state,
      ...patch,
      checkedAt: new Date().toISOString()
    };
  }
}

export async function probePort(host: string, port: number, timeoutMs = 500): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host, port });
    let settled = false;
    const finish = (result: boolean) => {
      if (settled) return;
      settled = true;
      try {
        socket.destroy();
      } catch {
        // ignore
      }
      resolve(result);
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
    socket.once('timeout', () => finish(false));
  });
}
