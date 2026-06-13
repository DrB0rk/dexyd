import { randomBytes } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';

const serverDefaults = {
  host: '0.0.0.0',
  port: 4242,
  logLevel: 'info',
  publicBaseUrl: ''
} as const;

const storageDefaults = {
  dataDir: '.dexyd',
  sqlitePath: '.dexyd/dexyd.db'
} as const;

const authDefaults = {
  accessTokenTtlSeconds: 900,
  refreshTokenTtlSeconds: 2592000,
  signingKey: randomBytes(48).toString('base64url')
} as const;

const streamDefaults = {
  replayWindowSeconds: 600,
  heartbeatActiveSeconds: 20,
  heartbeatIdleSeconds: 50,
  maxReplayEvents: 500,
  maxQueuedEventsPerClient: 1000,
  maxBufferedBytes: 1024 * 1024
} as const;

const codexDefaults = {
  runtimePath: 'codex',
  workspaceRoot: homedir(),
  permissionMode: 'bypass',
  harness: {
    mode: 'direct',
    command: 'omx',
    args: [] as string[]
  }
} as const;

const opencodeDefaults = {
  enabled: true,
  runtimePath: 'opencode',
  dataDir: join(homedir(), '.local/share/opencode'),
  permissionMode: 'bypass',
  server: {
    autoStart: true,
    host: '127.0.0.1',
    port: 4243,
    startTimeoutMs: 15_000,
    healthTimeoutMs: 4_000,
    password: '',
    cors: [] as string[],
    mdns: false,
    mdnsDomain: 'opencode.local',
    extraArgs: [] as string[]
  },
  defaultAgent: 'build',
  defaultModel: '',
  eventStreamEnabled: true,
  streamReconnectMs: 2_000,
  streamIdleTimeoutMs: 0
} as const;

const assistantDefaults = {
  defaultMode: 'codex'
} as const;

const pluginDefaults = {
  enabled: true,
  pluginDir: '.dexyd/plugins'
} as const;

const cloudflareDefaults = {
  hostname: '',
  tunnelName: 'dexyd'
} as const;

const publicBaseUrlSchema = z.preprocess(
  (value) => (typeof value === 'string' ? value.trim().replace(/\/+$/, '') : value),
  z
    .string()
    .refine((value) => {
      if (value === '') return true;
      try {
        const url = new URL(value);
        return url.protocol === 'http:' || url.protocol === 'https:';
      } catch {
        return false;
      }
    }, 'publicBaseUrl must be empty or an http(s) URL')
    .default(serverDefaults.publicBaseUrl)
);

const serverSchema = z.object({
  host: z.string().min(1).default(serverDefaults.host),
  port: z.number().int().min(1).max(65535).default(serverDefaults.port),
  logLevel: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default(serverDefaults.logLevel),
  publicBaseUrl: publicBaseUrlSchema
});

const storageSchema = z.object({
  dataDir: z.string().min(1).default(storageDefaults.dataDir),
  sqlitePath: z.string().min(1).default(storageDefaults.sqlitePath)
});

const authSchema = z.object({
  accessTokenTtlSeconds: z.number().int().positive().default(authDefaults.accessTokenTtlSeconds),
  refreshTokenTtlSeconds: z.number().int().positive().default(authDefaults.refreshTokenTtlSeconds),
  signingKey: z.string().min(16).default(authDefaults.signingKey)
});

const streamSchema = z.object({
  replayWindowSeconds: z.number().int().positive().default(streamDefaults.replayWindowSeconds),
  heartbeatActiveSeconds: z.number().int().positive().default(streamDefaults.heartbeatActiveSeconds),
  heartbeatIdleSeconds: z.number().int().positive().default(streamDefaults.heartbeatIdleSeconds),
  maxReplayEvents: z.number().int().positive().default(streamDefaults.maxReplayEvents),
  maxQueuedEventsPerClient: z.number().int().positive().default(streamDefaults.maxQueuedEventsPerClient),
  maxBufferedBytes: z.number().int().positive().default(streamDefaults.maxBufferedBytes)
});

const codexHarnessSchema = z.object({
  mode: z.enum(['direct', 'omx', 'custom']).default(codexDefaults.harness.mode),
  command: z.string().trim().min(1).default(codexDefaults.harness.command),
  args: z.array(z.string().refine((value) => !value.includes('\0'), 'harness args cannot contain NUL bytes')).max(40).default(codexDefaults.harness.args)
});

const codexSchema = z.object({
  runtimePath: z.string().min(1).default(codexDefaults.runtimePath),
  workspaceRoot: z.string().min(1).default(codexDefaults.workspaceRoot),
  permissionMode: z.enum(['inherit', 'read-only', 'workspace-write', 'danger-full-access', 'bypass']).default(codexDefaults.permissionMode),
  harness: codexHarnessSchema.default(codexDefaults.harness)
});

const opencodeServerSchema = z.object({
  autoStart: z.boolean().default(opencodeDefaults.server.autoStart),
  host: z.string().trim().min(1).default(opencodeDefaults.server.host),
  port: z.number().int().min(1).max(65535).default(opencodeDefaults.server.port),
  startTimeoutMs: z.number().int().min(1_000).max(120_000).default(opencodeDefaults.server.startTimeoutMs),
  healthTimeoutMs: z.number().int().min(500).max(30_000).default(opencodeDefaults.server.healthTimeoutMs),
  password: z.string().default(opencodeDefaults.server.password),
  cors: z.array(z.string().trim().min(1).max(2000)).max(64).default(opencodeDefaults.server.cors),
  mdns: z.boolean().default(opencodeDefaults.server.mdns),
  mdnsDomain: z.string().trim().min(1).max(120).default(opencodeDefaults.server.mdnsDomain),
  extraArgs: z.array(z.string().refine((value) => !value.includes('\0'), 'extraArgs cannot contain NUL bytes')).max(40).default(opencodeDefaults.server.extraArgs)
});

const opencodeSchema = z.object({
  enabled: z.boolean().default(opencodeDefaults.enabled),
  runtimePath: z.string().min(1).default(opencodeDefaults.runtimePath),
  dataDir: z.string().min(1).default(opencodeDefaults.dataDir),
  permissionMode: z.enum(['inherit', 'read-only', 'workspace-write', 'danger-full-access', 'bypass']).default(opencodeDefaults.permissionMode),
  server: opencodeServerSchema.default(opencodeDefaults.server),
  defaultAgent: z.string().trim().min(1).max(120).default(opencodeDefaults.defaultAgent),
  defaultModel: z.string().trim().max(240).default(opencodeDefaults.defaultModel),
  eventStreamEnabled: z.boolean().default(opencodeDefaults.eventStreamEnabled),
  streamReconnectMs: z.number().int().min(250).max(60_000).default(opencodeDefaults.streamReconnectMs),
  streamIdleTimeoutMs: z.number().int().min(0).max(3_600_000).default(opencodeDefaults.streamIdleTimeoutMs)
});

const assistantSchema = z.object({
  defaultMode: z.enum(['codex', 'opencode']).optional(),
  mode: z.enum(['codex', 'opencode']).optional()
}).transform((value) => ({
  defaultMode: value.defaultMode ?? value.mode ?? assistantDefaults.defaultMode
}));

const pluginSchema = z.object({
  enabled: z.boolean().default(pluginDefaults.enabled),
  pluginDir: z.string().min(1).default(pluginDefaults.pluginDir)
});

const cloudflareSchema = z.object({
  hostname: z.string().trim().default(cloudflareDefaults.hostname),
  tunnelName: z.string().trim().min(1).default(cloudflareDefaults.tunnelName)
});

export const dexydConfigSchema = z.object({
  server: serverSchema.default(serverDefaults),
  storage: storageSchema.default(storageDefaults),
  auth: authSchema.default(authDefaults),
  stream: streamSchema.default(streamDefaults),
  codex: codexSchema.default(codexDefaults),
  opencode: opencodeSchema.default(opencodeDefaults),
  assistant: assistantSchema.default(assistantDefaults),
  plugins: pluginSchema.default(pluginDefaults),
  cloudflare: cloudflareSchema.default(cloudflareDefaults)
});

export type DexydConfig = z.infer<typeof dexydConfigSchema>;
