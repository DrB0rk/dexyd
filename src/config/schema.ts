import { homedir } from 'node:os';
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
  signingKey: 'dexyd-dev-change-me'
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
  harness: {
    mode: 'direct',
    command: 'omx',
    args: [] as string[]
  }
} as const;

const pluginDefaults = {
  enabled: true,
  pluginDir: '.dexyd/plugins'
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
  harness: codexHarnessSchema.default(codexDefaults.harness)
});

const pluginSchema = z.object({
  enabled: z.boolean().default(pluginDefaults.enabled),
  pluginDir: z.string().min(1).default(pluginDefaults.pluginDir)
});

export const dexydConfigSchema = z.object({
  server: serverSchema.default(serverDefaults),
  storage: storageSchema.default(storageDefaults),
  auth: authSchema.default(authDefaults),
  stream: streamSchema.default(streamDefaults),
  codex: codexSchema.default(codexDefaults),
  plugins: pluginSchema.default(pluginDefaults)
});

export type DexydConfig = z.infer<typeof dexydConfigSchema>;
