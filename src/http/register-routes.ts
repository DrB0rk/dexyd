import websocket from '@fastify/websocket';
import { advertisedBridgeBaseUrl } from '../config/bridge-url.js';
import { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import { ModuleManager } from '../core/module-manager.js';
import { completePairingRequestSchema, refreshRequestSchema, revokeRequestSchema } from '../domain/auth.js';
import { chatQuerySchema, scheduleChatMessageRequestSchema, sendChatMessageRequestSchema } from '../domain/chat.js';
import { emitEventRequestSchema } from '../domain/events.js';
import { interactionIdParamsSchema, interactionResponseSchema } from '../domain/interaction.js';
import { fileQuerySchema, readFileQuerySchema } from '../domain/file.js';
import { createPairingRequestSchema } from '../domain/pairing.js';
import { createSessionRequestSchema, patchSessionRequestSchema, type SessionRecord, type SessionStatus } from '../domain/session.js';
import { AppContext } from '../runtime/app-context.js';
import { DEXYD_VERSION } from '../version.js';

const sessionIdSchema = z
  .string()
  .trim()
  .min(1)
  .max(180)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);
const sessionIdParamsSchema = z.object({ sessionId: sessionIdSchema });
const queueIdParamsSchema = z.object({ sessionId: sessionIdSchema, queueId: z.string().uuid() });
const scheduledIdParamsSchema = z.object({ sessionId: sessionIdSchema, scheduleId: z.string().uuid() });

const deviceIdParamsSchema = z.object({ deviceId: z.string().uuid() });
const listSessionsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(5000).default(1000),
  workspacePath: z.string().trim().min(1).max(1000).optional()
});
const dexydChatSessionRequestSchema = z.object({ title: z.string().trim().max(160).optional() });
const browseProjectsQuerySchema = z.object({ path: z.string().max(1000).default('') });
const suggestProjectsQuerySchema = z.object({ path: z.string().max(1000).default('') });
const createProjectRequestSchema = z.object({
  parentPath: z.string().max(1000).default(''),
  name: z
    .string()
    .trim()
    .min(1)
    .max(120)
    .regex(/^[^/\\\0]+$/, 'project name must be a single directory name')
});
const replayQuerySchema = z.object({
  lastSeenSequence: z.coerce.number().int().min(0),
  sessionId: sessionIdSchema.optional()
});
const usageStatusQuerySchema = z.object({
  sessionId: sessionIdSchema.optional()
});
const commandsQuerySchema = z.object({
  sessionId: sessionIdSchema.optional()
});
const diffQuerySchema = z.object({
  turnId: z
    .string()
    .trim()
    .min(1)
    .max(180)
    .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/)
    .optional()
});
const codexAuthSwitchRequestSchema = z.object({
  query: z.string().trim().min(1).max(120)
});
const queueSteerRequestSchema = z.object({
  message: z.string().trim().min(1).max(12000)
});

export async function registerRoutes(
  app: FastifyInstance<any, any, any, any>,
  context: AppContext,
  moduleManager: ModuleManager
): Promise<void> {
  await app.register(websocket);

  app.get('/health/live', async () => ({
    status: 'ok',
    version: DEXYD_VERSION,
    timestamp: new Date().toISOString()
  }));

  app.get('/health/ready', async () => {
    const [moduleHealth, databaseHealth] = await Promise.all([
      moduleManager.health(context),
      Promise.resolve(context.db.health())
    ]);

    const overallStatus =
      databaseHealth.status === 'ready' &&
      Object.values(moduleHealth).every((entry) => entry.status === 'ready')
        ? 'ready'
        : 'degraded';

    const bridgeBaseUrl = advertisedBridgeBaseUrl({
      host: context.config.server.host,
      port: context.config.server.port,
      publicBaseUrl: context.config.server.publicBaseUrl
    });
    const cloudflareHostname = context.config.cloudflare.hostname.trim();

    return {
      status: overallStatus,
      version: DEXYD_VERSION,
      timestamp: new Date().toISOString(),
      database: databaseHealth,
      modules: moduleHealth,
      bridge: {
        host: context.config.server.host,
        port: context.config.server.port,
        publicBaseUrl: context.config.server.publicBaseUrl || null,
        advertisedBaseUrl: bridgeBaseUrl
      },
      cloudflare: {
        hostname: cloudflareHostname || null,
        tunnelName: context.config.cloudflare.tunnelName,
        publicUrl: cloudflareHostname ? `https://${cloudflareHostname}` : null,
        configured: Boolean(cloudflareHostname)
      },
      assistant: {
        defaultMode: context.config.assistant.defaultMode,
        codexHarnessMode: context.config.codex.harness.mode,
        opencodeEnabled: context.opencodeServerManager.isEnabled(),
        opencodeStatus: context.opencodeServerManager.state.status
      }
    };
  });

  app.get('/capabilities', async () => ({
    name: 'dexyd',
    version: DEXYD_VERSION,
    modules: moduleManager.getModuleNames(),
    protocol: {
      rest: 'https',
      websocket: 'wss'
    },
    replayWindowSeconds: context.config.stream.replayWindowSeconds,
    maxReplayEvents: context.config.stream.maxReplayEvents
  }));

  app.get('/commands', async (request, reply) => {
    const auth = requireAuth(request.headers.authorization, context, reply);
    if (!auth) return;

    const parsed = commandsQuerySchema.safeParse(request.query ?? {});
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid_query', issues: parsed.error.issues });
    }

    return {
      commands: context.commandService.listCommands(),
      sessionId: parsed.data.sessionId ?? null,
      updatedAt: new Date().toISOString()
    };
  });

  app.get('/opencode/status', async (request, reply) => {
    const auth = requireAuth(request.headers.authorization, context, reply);
    if (!auth) return;

    const state = context.opencodeServerManager.state;
    return {
      opencode: {
        enabled: context.opencodeServerManager.isEnabled(),
        status: state.status,
        error: state.error,
        version: state.version,
        handle: state.handle,
        checkedAt: state.checkedAt,
        installHint: context.opencodeServerManager.resolveInstallHint(),
        defaultAgent: context.opencodeSessionService.defaultAgent,
        defaultModel: context.opencodeSessionService.defaultModel,
        pendingTools: context.opencodeChatService.pendingTools.length,
        pendingPermissions: context.opencodeChatService.pendingPermissions.length,
        pendingQuestions: context.opencodeChatService.pendingQuestions.length
      }
    };
  });

  app.get('/opencode/agents', async (request, reply) => {
    const auth = requireAuth(request.headers.authorization, context, reply);
    if (!auth) return;
    const agents = await context.opencodeSessionService.listAgents();
    return { agents, updatedAt: new Date().toISOString() };
  });

  app.get('/opencode/skills', async (request, reply) => {
    const auth = requireAuth(request.headers.authorization, context, reply);
    if (!auth) return;
    const skills = await context.opencodeSessionService.listSkills();
    return { skills, updatedAt: new Date().toISOString() };
  });

  app.get('/opencode/tools', async (request, reply) => {
    const auth = requireAuth(request.headers.authorization, context, reply);
    if (!auth) return;
    const tools = await context.opencodeSessionService.listTools();
    return { tools, updatedAt: new Date().toISOString() };
  });

  app.get('/opencode/commands', async (request, reply) => {
    const auth = requireAuth(request.headers.authorization, context, reply);
    if (!auth) return;
    const commands = await context.opencodeSessionService.listCommands();
    return { commands, updatedAt: new Date().toISOString() };
  });

  app.get('/opencode/providers', async (request, reply) => {
    const auth = requireAuth(request.headers.authorization, context, reply);
    if (!auth) return;
    const providers = await context.opencodeSessionService.listProviders();
    return { providers, updatedAt: new Date().toISOString() };
  });

  const opencodeModelsQuerySchema = z.object({
    provider: z.string().trim().min(1).max(120).optional()
  });
  app.get('/opencode/models', async (request, reply) => {
    const auth = requireAuth(request.headers.authorization, context, reply);
    if (!auth) return;
    const parsed = opencodeModelsQuerySchema.safeParse(request.query ?? {});
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid_query', issues: parsed.error.issues });
    }
    const models = await context.opencodeSessionService.listModels(parsed.data.provider);
    return { models, provider: parsed.data.provider ?? null, updatedAt: new Date().toISOString() };
  });

  app.get('/opencode/permissions', async (request, reply) => {
    const auth = requireAuth(request.headers.authorization, context, reply);
    if (!auth) return;
    const remote = await context.opencodeSessionService.listPermissions();
    const local = context.opencodeChatService.pendingPermissions;
    return {
      permissions: local.length > 0 ? local : remote,
      updatedAt: new Date().toISOString()
    };
  });

  const opencodePermissionReplySchema = z.object({
    decision: z.enum(['allow', 'deny', 'always'])
  });
  app.post('/opencode/permissions/:requestId/reply', async (request, reply) => {
    const auth = requireAuth(request.headers.authorization, context, reply);
    if (!auth) return;
    const params = z.object({ requestId: z.string().trim().min(1).max(200) }).safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send({ error: 'invalid_request_id', issues: params.error.issues });
    }
    const parsed = opencodePermissionReplySchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid_request', issues: parsed.error.issues });
    }
    try {
      await context.opencodeSessionService.replyPermission(params.data.requestId, parsed.data.decision);
      context.db.addAuditLog({
        actor: auth.sub,
        action: 'opencode.permission.replied',
        target: params.data.requestId,
        metadata: { decision: parsed.data.decision }
      });
      return { ok: true };
    } catch (error) {
      return reply.code(502).send({ error: error instanceof Error ? error.message : 'opencode_permission_reply_failed' });
    }
  });

  app.get('/opencode/questions', async (request, reply) => {
    const auth = requireAuth(request.headers.authorization, context, reply);
    if (!auth) return;
    const remote = await context.opencodeSessionService.listQuestions();
    const local = context.opencodeChatService.pendingQuestions;
    return {
      questions: local.length > 0 ? local : remote,
      updatedAt: new Date().toISOString()
    };
  });

  const opencodeQuestionReplySchema = z.object({
    answers: z.array(z.union([z.string(), z.object({ label: z.string().min(1) })])).min(1).max(20)
  });
  app.post('/opencode/questions/:requestId/reply', async (request, reply) => {
    const auth = requireAuth(request.headers.authorization, context, reply);
    if (!auth) return;
    const params = z.object({ requestId: z.string().trim().min(1).max(200) }).safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send({ error: 'invalid_request_id', issues: params.error.issues });
    }
    const parsed = opencodeQuestionReplySchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid_request', issues: parsed.error.issues });
    }
    try {
      await context.opencodeSessionService.replyQuestion(params.data.requestId, parsed.data.answers);
      context.db.addAuditLog({
        actor: auth.sub,
        action: 'opencode.question.replied',
        target: params.data.requestId
      });
      return { ok: true };
    } catch (error) {
      return reply.code(502).send({ error: error instanceof Error ? error.message : 'opencode_question_reply_failed' });
    }
  });

  app.post('/opencode/questions/:requestId/reject', async (request, reply) => {
    const auth = requireAuth(request.headers.authorization, context, reply);
    if (!auth) return;
    const params = z.object({ requestId: z.string().trim().min(1).max(200) }).safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send({ error: 'invalid_request_id', issues: params.error.issues });
    }
    try {
      await context.opencodeSessionService.rejectQuestion(params.data.requestId);
      context.db.addAuditLog({
        actor: auth.sub,
        action: 'opencode.question.rejected',
        target: params.data.requestId
      });
      return { ok: true };
    } catch (error) {
      return reply.code(502).send({ error: error instanceof Error ? error.message : 'opencode_question_reject_failed' });
    }
  });

  const opencodeCreateSessionSchema = z.object({
    workspacePath: z.string().trim().min(1).max(2000),
    title: z.string().trim().max(200).optional(),
    agent: z.string().trim().min(1).max(120).optional(),
    modelProviderID: z.string().trim().min(1).max(120).optional(),
    modelID: z.string().trim().min(1).max(200).optional()
  });
  app.post('/opencode/sessions', async (request, reply) => {
    const auth = requireAuth(request.headers.authorization, context, reply);
    if (!auth) return;
    const parsed = opencodeCreateSessionSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid_request', issues: parsed.error.issues });
    }
    try {
      let workspacePath: string;
      try {
        workspacePath = context.projectService.resolveWorkspace(parsed.data.workspacePath);
      } catch (error) {
        return reply.code(400).send({ error: error instanceof Error ? error.message : 'invalid_workspace' });
      }
      const session = await context.opencodeSessionService.createSession({
        workspacePath,
        ...(parsed.data.title ? { title: parsed.data.title } : {}),
        ...(parsed.data.agent ? { agent: parsed.data.agent } : {}),
        ...(parsed.data.modelProviderID ? { modelProviderID: parsed.data.modelProviderID } : {}),
        ...(parsed.data.modelID ? { modelID: parsed.data.modelID } : {})
      });
      persistOpenCodeSession(context, session);
      context.eventService.emit({
        eventType: 'session.created',
        source: 'session',
        sessionId: session.id,
        payload: session
      });
      context.db.addAuditLog({
        actor: auth.sub,
        action: 'opencode.session.created',
        target: session.id,
        metadata: { agent: session.agent, model: session.model }
      });
      return reply.code(201).send({ session });
    } catch (error) {
      return reply.code(502).send({ error: error instanceof Error ? error.message : 'opencode_create_failed' });
    }
  });

  app.delete('/opencode/sessions/:sessionId', async (request, reply) => {
    const auth = requireAuth(request.headers.authorization, context, reply);
    if (!auth) return;
    const params = sessionIdParamsSchema.safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send({ error: 'invalid_session_id', issues: params.error.issues });
    }
    const deleted = await context.opencodeSessionService.deleteSession(params.data.sessionId);
    const localDeleted = context.db.deleteSession(params.data.sessionId);
    context.db.addAuditLog({
      actor: auth.sub,
      action: 'opencode.session.deleted',
      target: params.data.sessionId
    });
    return { deleted: deleted || localDeleted, remoteDeleted: deleted, localDeleted };
  });

  app.get('/opencode/sessions/:sessionId/diff', async (request, reply) => {
    const auth = requireAuth(request.headers.authorization, context, reply);
    if (!auth) return;
    const params = sessionIdParamsSchema.safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send({ error: 'invalid_session_id', issues: params.error.issues });
    }
    const diff = await context.opencodeApiClient.getSessionDiff(params.data.sessionId);
    return { diff, updatedAt: new Date().toISOString() };
  });

  app.get('/opencode/sessions/:sessionId/todos', async (request, reply) => {
    const auth = requireAuth(request.headers.authorization, context, reply);
    if (!auth) return;
    const params = sessionIdParamsSchema.safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send({ error: 'invalid_session_id', issues: params.error.issues });
    }
    const todos = await context.opencodeApiClient.listTodos(params.data.sessionId);
    return { todos, updatedAt: new Date().toISOString() };
  });

  const opencodeShellRequestSchema = z.object({
    command: z.string().trim().min(1).max(2000)
  });
  app.post('/opencode/sessions/:sessionId/shell', async (request, reply) => {
    const auth = requireAuth(request.headers.authorization, context, reply);
    if (!auth) return;
    const params = sessionIdParamsSchema.safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send({ error: 'invalid_session_id', issues: params.error.issues });
    }
    const parsed = opencodeShellRequestSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid_request', issues: parsed.error.issues });
    }
    try {
      const result = await context.opencodeApiClient.runShell(params.data.sessionId, { command: parsed.data.command });
      context.db.addAuditLog({
        actor: auth.sub,
        action: 'opencode.shell.executed',
        target: params.data.sessionId,
        metadata: { command: parsed.data.command.slice(0, 200), exitCode: result.exitCode }
      });
      return result;
    } catch (error) {
      return reply.code(502).send({ error: error instanceof Error ? error.message : 'opencode_shell_failed' });
    }
  });

  const opencodeCommandRequestSchema = z.object({
    command: z.string().trim().min(1).max(120),
    arguments: z.array(z.string().max(2000)).max(20).optional()
  });
  app.post('/opencode/sessions/:sessionId/command', async (request, reply) => {
    const auth = requireAuth(request.headers.authorization, context, reply);
    if (!auth) return;
    const params = sessionIdParamsSchema.safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send({ error: 'invalid_session_id', issues: params.error.issues });
    }
    const parsed = opencodeCommandRequestSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid_request', issues: parsed.error.issues });
    }
    try {
      const commandInput: { command: string; arguments?: string[] } = { command: parsed.data.command };
      if (parsed.data.arguments) commandInput.arguments = parsed.data.arguments;
      const result = await context.opencodeApiClient.sendCommand(params.data.sessionId, commandInput);
      context.db.addAuditLog({
        actor: auth.sub,
        action: 'opencode.command.executed',
        target: params.data.sessionId,
        metadata: { command: parsed.data.command }
      });
      return result;
    } catch (error) {
      return reply.code(502).send({ error: error instanceof Error ? error.message : 'opencode_command_failed' });
    }
  });

  app.post('/opencode/sessions/:sessionId/abort', async (request, reply) => {
    const auth = requireAuth(request.headers.authorization, context, reply);
    if (!auth) return;
    const params = sessionIdParamsSchema.safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send({ error: 'invalid_session_id', issues: params.error.issues });
    }
    const aborted = await context.opencodeSessionService.abortSession(params.data.sessionId);
    const cancelled = context.opencodeChatService.cancelSession(params.data.sessionId);
    context.db.addAuditLog({
      actor: auth.sub,
      action: 'opencode.session.aborted',
      target: params.data.sessionId
    });
    return { aborted, cancelled };
  });

  app.post('/opencode/sessions/:sessionId/summarize', async (request, reply) => {
    const auth = requireAuth(request.headers.authorization, context, reply);
    if (!auth) return;
    const params = sessionIdParamsSchema.safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send({ error: 'invalid_session_id', issues: params.error.issues });
    }
    try {
      const result = await context.opencodeApiClient.summarize(params.data.sessionId);
      context.db.addAuditLog({
        actor: auth.sub,
        action: 'opencode.session.summarized',
        target: params.data.sessionId
      });
      return result;
    } catch (error) {
      return reply.code(502).send({ error: error instanceof Error ? error.message : 'opencode_summarize_failed' });
    }
  });

  app.post('/opencode/sessions/:sessionId/compact', async (request, reply) => {
    const auth = requireAuth(request.headers.authorization, context, reply);
    if (!auth) return;
    const params = sessionIdParamsSchema.safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send({ error: 'invalid_session_id', issues: params.error.issues });
    }
    const result = await context.opencodeApiClient.compactSession(params.data.sessionId);
    context.db.addAuditLog({
      actor: auth.sub,
      action: 'opencode.session.compacted',
      target: params.data.sessionId
    });
    return result;
  });

  app.post('/opencode/sessions/:sessionId/fork', async (request, reply) => {
    const auth = requireAuth(request.headers.authorization, context, reply);
    if (!auth) return;
    const params = sessionIdParamsSchema.safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send({ error: 'invalid_session_id', issues: params.error.issues });
    }
    try {
      const session = await context.opencodeApiClient.forkSession(params.data.sessionId);
      return reply.code(201).send({ session });
    } catch (error) {
      return reply.code(502).send({ error: error instanceof Error ? error.message : 'opencode_fork_failed' });
    }
  });

  app.post('/opencode/sessions/:sessionId/share', async (request, reply) => {
    const auth = requireAuth(request.headers.authorization, context, reply);
    if (!auth) return;
    const params = sessionIdParamsSchema.safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send({ error: 'invalid_session_id', issues: params.error.issues });
    }
    const result = await context.opencodeApiClient.shareSession(params.data.sessionId);
    return result;
  });

  app.delete('/opencode/sessions/:sessionId/share', async (request, reply) => {
    const auth = requireAuth(request.headers.authorization, context, reply);
    if (!auth) return;
    const params = sessionIdParamsSchema.safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send({ error: 'invalid_session_id', issues: params.error.issues });
    }
    const result = await context.opencodeApiClient.unshareSession(params.data.sessionId);
    return result;
  });

  app.post('/pairing/start', async (request, reply) => {
    if (!isLocalOrPrivateClient(request.ip)) {
      context.logger.warn({ remoteAddress: request.ip }, 'rejected non-local pairing start request');
      return reply.code(403).send({ error: 'pairing_start_requires_local_network' });
    }

    const parsed = createPairingRequestSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid_request', issues: parsed.error.issues });
    }

    const result = await context.pairingService.startPairing({
      ...(parsed.data.bridgeBaseUrl ? { bridgeBaseUrl: parsed.data.bridgeBaseUrl } : {}),
      ...(parsed.data.expiresInSeconds ? { expiresInSeconds: parsed.data.expiresInSeconds } : {})
    });

    context.db.addAuditLog({
      actor: 'local',
      action: 'pairing.started',
      target: result.pairingId,
      metadata: {
        expiresAt: result.expiresAt
      }
    });

    return reply.code(201).send(result);
  });

  app.post('/pairing/complete', async (request, reply) => {
    const parsed = completePairingRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid_request', issues: parsed.error.issues });
    }

    try {
      const tokens = 'pairingUri' in parsed.data
        ? context.pairingService.completePairingFromUri({
            pairingUri: parsed.data.pairingUri,
            deviceLabel: parsed.data.deviceLabel
          })
        : context.pairingService.completePairing(parsed.data);
      return reply.code(201).send(tokens);
    } catch (error) {
      const reason = error instanceof Error ? error.message : 'pairing_failed';
      return reply.code(400).send({ error: reason });
    }
  });

  app.post('/auth/refresh', async (request, reply) => {
    const parsed = refreshRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid_request', issues: parsed.error.issues });
    }

    const rotated = context.authService.rotateRefreshToken(parsed.data.refreshToken);

    if (!rotated) {
      return reply.code(401).send({ error: 'invalid_refresh_token' });
    }

    context.db.addAuditLog({
      actor: rotated.deviceId,
      action: 'auth.refresh',
      target: rotated.deviceId
    });

    return {
      deviceId: rotated.deviceId,
      accessToken: rotated.accessToken,
      refreshToken: rotated.refreshToken,
      accessExpiresAt: rotated.accessExpiresAt,
      refreshExpiresAt: rotated.refreshExpiresAt
    };
  });

  app.post('/auth/revoke', async (request, reply) => {
    const auth = requireAuth(request.headers.authorization, context, reply);
    if (!auth) return;

    const parsed = revokeRequestSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid_request', issues: parsed.error.issues });
    }

    if (parsed.data.refreshToken) {
      context.authService.revokeByRefreshToken(parsed.data.refreshToken);
    }

    context.db.revokeAllRefreshTokensForDevice(auth.sub);

    context.db.addAuditLog({
      actor: auth.sub,
      action: 'auth.revoke',
      target: auth.sub
    });

    return { revoked: true };
  });

  app.get('/devices', async (request, reply) => {
    const auth = requireAuth(request.headers.authorization, context, reply);
    if (!auth) return;

    return {
      devices: context.db.listDevices()
    };
  });


  app.get('/codex-auth/status', async (request, reply) => {
    const auth = requireAuth(request.headers.authorization, context, reply);
    if (!auth) return;

    return { codexAuth: context.codexAuthService.getStatus() };
  });

  app.post('/codex-auth/switch', async (request, reply) => {
    const auth = requireAuth(request.headers.authorization, context, reply);
    if (!auth) return;

    const parsed = codexAuthSwitchRequestSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid_request', issues: parsed.error.issues });
    }

    try {
      const codexAuth = context.codexAuthService.switchAccount(parsed.data.query);
      context.db.addAuditLog({
        actor: auth.sub,
        action: 'codex_auth.switch',
        target: parsed.data.query
      });
      return { codexAuth };
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : 'codex_auth_error' });
    }
  });

  app.get('/usage/status', async (request, reply) => {
    const auth = requireAuth(request.headers.authorization, context, reply);
    if (!auth) return;

    const parsed = usageStatusQuerySchema.safeParse(request.query ?? {});
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid_query', issues: parsed.error.issues });
    }

    return {
      usage: context.codexSessionService.getUsageStatus(parsed.data.sessionId)
    };
  });

  app.delete('/devices/:deviceId', async (request, reply) => {
    const auth = requireAuth(request.headers.authorization, context, reply);
    if (!auth) return;

    const params = deviceIdParamsSchema.safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send({ error: 'invalid_device_id', issues: params.error.issues });
    }

    const revoked = context.db.revokeDevice(params.data.deviceId);
    context.db.revokeAllRefreshTokensForDevice(params.data.deviceId);

    context.db.addAuditLog({
      actor: auth.sub,
      action: 'device.revoked',
      target: params.data.deviceId
    });

    return { revoked };
  });

  app.get('/projects', async (request, reply) => {
    const auth = requireAuth(request.headers.authorization, context, reply);
    if (!auth) return;

    const parsed = browseProjectsQuerySchema.safeParse(request.query ?? {});
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid_query', issues: parsed.error.issues });
    }

    try {
      return context.projectService.browse(parsed.data.path);
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : 'project_error' });
    }
  });

  app.get('/projects/suggest', async (request, reply) => {
    const auth = requireAuth(request.headers.authorization, context, reply);
    if (!auth) return;

    const parsed = suggestProjectsQuerySchema.safeParse(request.query ?? {});
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid_query', issues: parsed.error.issues });
    }

    try {
      return context.projectService.suggest(parsed.data.path);
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : 'project_error' });
    }
  });

  app.post('/projects', async (request, reply) => {
    const auth = requireAuth(request.headers.authorization, context, reply);
    if (!auth) return;

    const parsed = createProjectRequestSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid_request', issues: parsed.error.issues });
    }

    try {
      const project = context.projectService.create(parsed.data);
      context.db.addAuditLog({
        actor: auth.sub,
        action: 'project.created',
        target: project.absolutePath
      });
      return reply.code(201).send({ project });
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : 'project_error' });
    }
  });

  app.post('/sessions', async (request, reply) => {
    const auth = requireAuth(request.headers.authorization, context, reply);
    if (!auth) return;

    const parsed = createSessionRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid_request', issues: parsed.error.issues });
    }

    let workspacePath: string;
    try {
      workspacePath = context.projectService.resolveWorkspace(parsed.data.workspacePath);
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : 'invalid_workspace' });
    }

    let session: SessionRecord;
    try {
      if (parsed.data.source === 'codex') {
        session = context.codexSessionService.createSession({
          workspacePath,
          ...(parsed.data.title ? { title: parsed.data.title } : {})
        });
      } else if (parsed.data.source === 'opencode') {
        session = await context.opencodeSessionService.createSession({
          workspacePath,
          ...(parsed.data.title ? { title: parsed.data.title } : {})
        });
        persistOpenCodeSession(context, session);
      } else {
        session = context.db.createSession({
          workspacePath,
          profile: parsed.data.profile,
          source: parsed.data.source,
          ...(parsed.data.title ? { title: parsed.data.title } : {})
        });
      }
    } catch (error) {
      return reply.code(parsed.data.source === 'opencode' ? 502 : 400).send({
        error: error instanceof Error ? error.message : 'session_create_failed'
      });
    }

    context.eventService.emit({
      eventType: 'session.created',
      source: session.source === 'codex' ? 'codexAdapter' : 'session',
      sessionId: session.id,
      payload: session
    });

    return reply.code(201).send({ session });
  });

  app.get('/sessions', async (request, reply) => {
    const auth = requireAuth(request.headers.authorization, context, reply);
    if (!auth) return;

    const parsed = listSessionsQuerySchema.safeParse(request.query ?? {});
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid_query', issues: parsed.error.issues });
    }
    const { limit, workspacePath } = parsed.data;
    let resolvedWorkspacePath: string | null = null;
    if (workspacePath) {
      try {
        resolvedWorkspacePath = context.projectService.resolveWorkspace(workspacePath);
      } catch (error) {
        return reply.code(400).send({ error: error instanceof Error ? error.message : 'invalid_workspace' });
      }
    }

    const hidden = context.db.listHiddenSessionIds();
    const allLocalSessions = context.db.listSessions(5000);
    const allCodexSessions = context.codexSessionService.listSessions(5000);
    const allOpenCodeSessions = await listOpenCodeSessionsForAggregate(context, 5000);
    const sessions = mergeSessions([...allLocalSessions, ...allCodexSessions, ...allOpenCodeSessions])
      .filter((session) => !hidden.has(session.id))
      .filter((session) => {
        if (!resolvedWorkspacePath) return true;
        return isRootedInWorkspace(session.workspacePath, resolvedWorkspacePath);
      })
      .map((session) => {
        if (session.source === 'opencode') {
          return context.opencodeChatService.applyRuntimeStatus(session);
        }
        return context.codexChatService.applyRuntimeStatus(session);
      })
      .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))
      .slice(0, limit);
    return { sessions };
  });

  app.get('/sessions/hidden', async (request, reply) => {
    const auth = requireAuth(request.headers.authorization, context, reply);
    if (!auth) return;

    const hidden = context.db.listHiddenSessions();
    const hiddenIds = new Set(hidden.map((session) => session.id));
    const allOpenCodeSessionsForHidden = await listOpenCodeSessionsForAggregate(context, 5000);
    const visibleRecords = mergeSessions([
      ...context.db.listSessions(5000),
      ...context.codexSessionService.listSessions(5000),
      ...allOpenCodeSessionsForHidden
    ])
      .filter((session) => hiddenIds.has(session.id))
      .map((session) => {
        if (session.source === 'opencode') {
          return context.opencodeChatService.applyRuntimeStatus(session);
        }
        return context.codexChatService.applyRuntimeStatus(session);
      });
    const byId = new Map(visibleRecords.map((session) => [session.id, session]));

    return {
      sessions: hidden.map((hiddenSession) => ({
        ...hiddenSession,
        session: byId.get(hiddenSession.id) ?? null
      }))
    };
  });

  app.post('/sessions/:sessionId/restore', async (request, reply) => {
    const auth = requireAuth(request.headers.authorization, context, reply);
    if (!auth) return;

    const params = sessionIdParamsSchema.safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send({ error: 'invalid_session_id', issues: params.error.issues });
    }

    const restored = context.db.restoreSession(params.data.sessionId);
    const session = await getSession(context, params.data.sessionId);
    context.eventService.emit({
      eventType: 'session.restored',
      source: 'session',
      sessionId: params.data.sessionId,
      payload: { id: params.data.sessionId, restored, session }
    });
    context.db.addAuditLog({
      actor: auth.sub,
      action: 'session.restored',
      target: params.data.sessionId
    });
    return { restored, session };
  });

  app.get('/sessions/:sessionId', async (request, reply) => {
    const auth = requireAuth(request.headers.authorization, context, reply);
    if (!auth) return;

    const params = sessionIdParamsSchema.safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send({ error: 'invalid_session_id', issues: params.error.issues });
    }

    const session = await getSession(context, params.data.sessionId);
    if (!session) {
      return reply.code(404).send({ error: 'session_not_found' });
    }

    return { session };
  });

  app.patch('/sessions/:sessionId', async (request, reply) => {
    const auth = requireAuth(request.headers.authorization, context, reply);
    if (!auth) return;

    const params = sessionIdParamsSchema.safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send({ error: 'invalid_session_id', issues: params.error.issues });
    }

    const body = patchSessionRequestSchema.safeParse(request.body);
    if (!body.success) {
      return reply.code(400).send({ error: 'invalid_request', issues: body.error.issues });
    }

    if (!body.data.status && !body.data.profile) {
      return reply.code(400).send({ error: 'no_changes_requested' });
    }

    const session = context.db.patchSession({
      sessionId: params.data.sessionId,
      ...(body.data.status ? { status: body.data.status } : {}),
      ...(body.data.profile ? { profile: body.data.profile } : {})
    });

    if (!session) {
      return reply.code(404).send({ error: 'session_not_found' });
    }

    context.eventService.emit({
      eventType: 'session.updated',
      source: 'session',
      sessionId: session.id,
      payload: session
    });

    return { session };
  });

  app.delete('/sessions/:sessionId', async (request, reply) => {
    const auth = requireAuth(request.headers.authorization, context, reply);
    if (!auth) return;

    const params = sessionIdParamsSchema.safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send({ error: 'invalid_session_id', issues: params.error.issues });
    }

    const session = await getSession(context, params.data.sessionId);
    if (!session) {
      context.db.hideSession(params.data.sessionId);
      return { deleted: false, hidden: true };
    }

    const remoteDeleted = session.source === 'opencode'
      ? await context.opencodeSessionService.deleteSession(params.data.sessionId)
      : false;
    const deleted = context.db.deleteSession(params.data.sessionId) || remoteDeleted;
    if (!deleted) {
      context.db.hideSession(params.data.sessionId);
    }

    context.eventService.emit({
      eventType: 'session.deleted',
      source: 'session',
      sessionId: params.data.sessionId,
      payload: { id: params.data.sessionId, hidden: !deleted }
    });

    context.db.addAuditLog({
      actor: auth.sub,
      action: 'session.deleted',
      target: params.data.sessionId
    });

    return { deleted, hidden: !deleted };
  });

  app.post('/dexyd-chat/session', async (request, reply) => {
    const auth = requireAuth(request.headers.authorization, context, reply);
    if (!auth) return;

    const parsed = dexydChatSessionRequestSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid_request', issues: parsed.error.issues });
    }

    try {
      const workspacePath = context.dexydChatService.ensureWorkspace();
      const session = context.db.createSession({
        workspacePath,
        profile: 'dexyd-help',
        title: parsed.data.title || 'dexyd help'
      });
      context.eventService.emit({
        eventType: 'session.created',
        source: 'session',
        sessionId: session.id,
        payload: session
      });
      return reply.code(201).send({ session });
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : 'dexyd_chat_error' });
    }
  });

  app.post('/sessions/:sessionId/events', async (request, reply) => {
    const auth = requireAuth(request.headers.authorization, context, reply);
    if (!auth) return;

    const params = sessionIdParamsSchema.safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send({ error: 'invalid_session_id', issues: params.error.issues });
    }

    const body = emitEventRequestSchema.safeParse(request.body);
    if (!body.success) {
      return reply.code(400).send({ error: 'invalid_request', issues: body.error.issues });
    }

    const session = await getSession(context, params.data.sessionId);
    if (!session) {
      return reply.code(404).send({ error: 'session_not_found' });
    }

    const event = context.eventService.emit({
      eventType: body.data.eventType,
      payload: body.data.payload,
      source: body.data.source,
      sessionId: params.data.sessionId,
      ...(body.data.streamId ? { streamId: body.data.streamId } : {})
    });

    return reply.code(201).send({ event });
  });

  app.get('/sessions/:sessionId/chat', async (request, reply) => {
    const auth = requireAuth(request.headers.authorization, context, reply);
    if (!auth) return;

    const params = sessionIdParamsSchema.safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send({ error: 'invalid_session_id', issues: params.error.issues });
    }

    const query = chatQuerySchema.safeParse(request.query ?? {});
    if (!query.success) {
      return reply.code(400).send({ error: 'invalid_query', issues: query.error.issues });
    }

    const session = await getSession(context, params.data.sessionId);
    if (!session) {
      return reply.code(404).send({ error: 'session_not_found' });
    }

    return {
      messages: await getChatService(context, session).getMessages(params.data.sessionId, query.data.limit)
    };
  });

  app.get('/sessions/:sessionId/queue', async (request, reply) => {
    const auth = requireAuth(request.headers.authorization, context, reply);
    if (!auth) return;

    const params = sessionIdParamsSchema.safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send({ error: 'invalid_session_id', issues: params.error.issues });
    }

    const session = await getSession(context, params.data.sessionId);
    if (!session) {
      return reply.code(404).send({ error: 'session_not_found' });
    }

    if (session.source === 'opencode') {
      return { queue: [] };
    }

    return { queue: context.codexChatService.getQueue(params.data.sessionId) };
  });

  app.post('/sessions/:sessionId/queue/:queueId/steer', async (request, reply) => {
    const auth = requireAuth(request.headers.authorization, context, reply);
    if (!auth) return;

    const params = queueIdParamsSchema.safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send({ error: 'invalid_queue_id', issues: params.error.issues });
    }

    const body = queueSteerRequestSchema.safeParse(request.body ?? {});
    if (!body.success) {
      return reply.code(400).send({ error: 'invalid_request', issues: body.error.issues });
    }

    const session = await getSession(context, params.data.sessionId);
    if (!session) {
      return reply.code(404).send({ error: 'session_not_found' });
    }
    if (session.source === 'opencode') {
      return reply.code(400).send({ error: 'queue_not_supported_for_opencode' });
    }

    const queued = context.codexChatService.steerQueuedMessage({
      sessionId: params.data.sessionId,
      queueId: params.data.queueId,
      steering: body.data.message
    });
    if (!queued) {
      return reply.code(404).send({ error: 'queued_message_not_found' });
    }

    context.db.addAuditLog({
      actor: auth.sub,
      action: 'chat.queue.steered',
      target: params.data.sessionId,
      metadata: { queueId: params.data.queueId }
    });

    return { queued };
  });

  app.delete('/sessions/:sessionId/queue/:queueId', async (request, reply) => {
    const auth = requireAuth(request.headers.authorization, context, reply);
    if (!auth) return;

    const params = queueIdParamsSchema.safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send({ error: 'invalid_queue_id', issues: params.error.issues });
    }

    const session = await getSession(context, params.data.sessionId);
    if (!session) {
      return reply.code(404).send({ error: 'session_not_found' });
    }
    if (session.source === 'opencode') {
      return reply.code(400).send({ error: 'queue_not_supported_for_opencode' });
    }

    const removed = context.codexChatService.removeQueuedMessage({
      sessionId: params.data.sessionId,
      queueId: params.data.queueId
    });

    if (removed) {
      context.db.addAuditLog({
        actor: auth.sub,
        action: 'chat.queue.removed',
        target: params.data.sessionId,
        metadata: { queueId: params.data.queueId }
      });
    }

    return { removed };
  });

  app.get('/sessions/:sessionId/scheduled', async (request, reply) => {
    const auth = requireAuth(request.headers.authorization, context, reply);
    if (!auth) return;

    const params = sessionIdParamsSchema.safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send({ error: 'invalid_session_id', issues: params.error.issues });
    }

    const session = await getSession(context, params.data.sessionId);
    if (!session) {
      return reply.code(404).send({ error: 'session_not_found' });
    }

    if (session.source === 'opencode') {
      return { scheduled: [] };
    }

    return { scheduled: context.codexChatService.getScheduledMessages(params.data.sessionId) };
  });

  app.post('/sessions/:sessionId/scheduled', async (request, reply) => {
    const auth = requireAuth(request.headers.authorization, context, reply);
    if (!auth) return;

    const params = sessionIdParamsSchema.safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send({ error: 'invalid_session_id', issues: params.error.issues });
    }

    const body = scheduleChatMessageRequestSchema.safeParse(request.body);
    if (!body.success) {
      return reply.code(400).send({ error: 'invalid_request', issues: body.error.issues });
    }

    const session = await getSession(context, params.data.sessionId);
    if (!session) {
      return reply.code(404).send({ error: 'session_not_found' });
    }
    if (session.source === 'opencode') {
      return reply.code(400).send({ error: 'scheduled_messages_not_supported_for_opencode' });
    }

    const runAt = new Date(body.data.runAt);
    if (!Number.isFinite(runAt.getTime())) {
      return reply.code(400).send({ error: 'invalid_run_at' });
    }

    const scheduled = context.codexChatService.createScheduledMessage({
      session,
      message: body.data.message,
      actorDeviceId: auth.sub,
      runAt,
      repeatIntervalMs: body.data.repeat?.intervalMs ?? null,
      repeatMaxRuns: body.data.repeat?.maxRuns ?? null
    });

    context.db.addAuditLog({
      actor: auth.sub,
      action: 'chat.message.scheduled',
      target: params.data.sessionId,
      metadata: { scheduleId: scheduled.id, nextRunAt: scheduled.nextRunAt }
    });

    return reply.code(201).send({ scheduled });
  });

  app.delete('/sessions/:sessionId/scheduled/:scheduleId', async (request, reply) => {
    const auth = requireAuth(request.headers.authorization, context, reply);
    if (!auth) return;

    const params = scheduledIdParamsSchema.safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send({ error: 'invalid_schedule_id', issues: params.error.issues });
    }

    const session = await getSession(context, params.data.sessionId);
    if (!session) {
      return reply.code(404).send({ error: 'session_not_found' });
    }
    if (session.source === 'opencode') {
      return reply.code(400).send({ error: 'scheduled_messages_not_supported_for_opencode' });
    }

    const scheduled = context.codexChatService.cancelScheduledMessage({
      sessionId: params.data.sessionId,
      scheduleId: params.data.scheduleId
    });
    if (!scheduled) {
      return reply.code(404).send({ error: 'scheduled_message_not_found' });
    }

    context.db.addAuditLog({
      actor: auth.sub,
      action: 'chat.message.scheduled.cancelled',
      target: params.data.sessionId,
      metadata: { scheduleId: params.data.scheduleId }
    });

    return { scheduled };
  });

  app.post('/sessions/:sessionId/chat', async (request, reply) => {
    const auth = requireAuth(request.headers.authorization, context, reply);
    if (!auth) return;

    const params = sessionIdParamsSchema.safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send({ error: 'invalid_session_id', issues: params.error.issues });
    }

    const body = sendChatMessageRequestSchema.safeParse(request.body);
    if (!body.success) {
      return reply.code(400).send({ error: 'invalid_request', issues: body.error.issues });
    }

    const session = await getSession(context, params.data.sessionId);
    if (!session) {
      return reply.code(404).send({ error: 'session_not_found' });
    }

    if (session.source !== 'opencode') {
      const usage = context.codexSessionService.getUsageStatus(params.data.sessionId);
      if (usage.limits.status === 'error') {
        return reply.code(429).send({
          error: 'usage_limit_reached',
          detail: usage.limits.detail || 'Codex usage limit has been reached. Wait for the limit to reset or switch account.',
          usage
        });
      }
    }

    const chatService = getChatService(context, session);

    let result: ReturnType<typeof chatService.sendMessage>;
    try {
      result = chatService.sendMessage({
        session,
        message: body.data.message,
        actorDeviceId: auth.sub
      });
    } catch (error) {
      const reason = error instanceof Error ? error.message : 'chat_start_failed';
      return reply.code(reason === 'session_busy' ? 409 : 400).send({ error: reason });
    }

    context.db.addAuditLog({
      actor: auth.sub,
      action: 'chat.message.sent',
      target: params.data.sessionId,
      metadata: { turnId: result.turnId }
    });

    return reply.code(202).send(result);
  });
  app.post('/sessions/:sessionId/cancel', async (request, reply) => {
    const auth = requireAuth(request.headers.authorization, context, reply);
    if (!auth) return;

    const params = sessionIdParamsSchema.safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send({ error: 'invalid_session_id', issues: params.error.issues });
    }

    const session = await getSession(context, params.data.sessionId);
    if (!session) {
      return reply.code(404).send({ error: 'session_not_found' });
    }

    const killed = getChatService(context, session).cancelSession(session.id);
    context.db.addAuditLog({
      actor: auth.sub,
      action: 'session.cancelled',
      target: session.id,
      metadata: { killed }
    });

    return { cancelled: true, killed };
  });

  app.get('/sessions/:sessionId/files', async (request, reply) => {
    const auth = requireAuth(request.headers.authorization, context, reply);
    if (!auth) return;

    const params = sessionIdParamsSchema.safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send({ error: 'invalid_session_id', issues: params.error.issues });
    }

    const query = fileQuerySchema.safeParse(request.query ?? {});
    if (!query.success) {
      return reply.code(400).send({ error: 'invalid_query', issues: query.error.issues });
    }

    const session = await getSession(context, params.data.sessionId);
    if (!session) {
      return reply.code(404).send({ error: 'session_not_found' });
    }

    try {
      return context.fileService.listDirectory(session, query.data.path);
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : 'file_error' });
    }
  });

  app.get('/sessions/:sessionId/files/read', async (request, reply) => {
    const auth = requireAuth(request.headers.authorization, context, reply);
    if (!auth) return;

    const params = sessionIdParamsSchema.safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send({ error: 'invalid_session_id', issues: params.error.issues });
    }

    const query = readFileQuerySchema.safeParse(request.query ?? {});
    if (!query.success) {
      return reply.code(400).send({ error: 'invalid_query', issues: query.error.issues });
    }

    const session = await getSession(context, params.data.sessionId);
    if (!session) {
      return reply.code(404).send({ error: 'session_not_found' });
    }

    try {
      return context.fileService.readFile(session, query.data.path, query.data.maxBytes);
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : 'file_error' });
    }
  });

  app.get('/sessions/:sessionId/diff', async (request, reply) => {
    const auth = requireAuth(request.headers.authorization, context, reply);
    if (!auth) return;

    const params = sessionIdParamsSchema.safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send({ error: 'invalid_session_id', issues: params.error.issues });
    }

    const query = diffQuerySchema.safeParse(request.query ?? {});
    if (!query.success) {
      return reply.code(400).send({ error: 'invalid_query', issues: query.error.issues });
    }

    const session = await getSession(context, params.data.sessionId);
    if (!session) {
      return reply.code(404).send({ error: 'session_not_found' });
    }

    if (query.data.turnId) {
      if (session.source === 'opencode') {
        return { status: '', stat: '', diff: '', truncated: false };
      }
      return (
        context.codexChatService.getTurnDiff(params.data.sessionId, query.data.turnId) ?? {
          status: '',
          stat: '',
          diff: '',
          truncated: false
        }
      );
    }

    return context.diffService.summarize(session);
  });



  app.post('/interactions/:interactionId/respond', async (request, reply) => {
    const auth = requireAuth(request.headers.authorization, context, reply);
    if (!auth) return;

    const params = interactionIdParamsSchema.safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send({ error: 'invalid_interaction_id', issues: params.error.issues });
    }

    const body = interactionResponseSchema.safeParse(request.body);
    if (!body.success) {
      return reply.code(400).send({ error: 'invalid_request', issues: body.error.issues });
    }

    if (body.data.sessionId) {
      const session = await getSession(context, body.data.sessionId);
      if (!session) {
        return reply.code(404).send({ error: 'session_not_found' });
      }
    }

    const submittedAt = new Date().toISOString();
    const responsePayload = {
      ...body.data,
      interactionId: params.data.interactionId,
      actorDeviceId: auth.sub,
      submittedAt
    };

    const eventType =
      body.data.kind === 'approval'
        ? 'interaction.approval.responded'
        : 'interaction.question.answered';

    const event = context.eventService.emit({
      eventType,
      source: 'plugin',
      sessionId: body.data.sessionId ?? null,
      payload: responsePayload
    });

    context.db.addAuditLog({
      actor: auth.sub,
      action: eventType,
      target: params.data.interactionId,
      metadata: responsePayload
    });

    return reply.code(202).send({ event, response: responsePayload });
  });

  app.get('/events/replay', async (request, reply) => {
    const auth = requireAuth(request.headers.authorization, context, reply);
    if (!auth) return;

    const parsed = replayQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid_query', issues: parsed.error.issues });
    }

    const replay = context.eventService.replay({
      lastSeenSequence: parsed.data.lastSeenSequence,
      ...(parsed.data.sessionId ? { sessionId: parsed.data.sessionId } : {})
    });

    const opencodeSnapshot = replay.replayExpired ? await listOpenCodeSessionsForAggregate(context, 200) : [];
    return {
      ...replay,
      snapshot: replay.replayExpired
        ? {
sessions: [
              ...context.codexSessionService.listSessions(200),
              ...opencodeSnapshot
            ],
            sequence: context.runtime.currentSequence()
          }
        : null
    };
  });

  app.get('/ws', { websocket: true }, (socket, request) => {
    const query = request.query as Record<string, unknown>;

    const token =
      typeof query.access_token === 'string'
        ? query.access_token
        : Array.isArray(query.access_token)
          ? (query.access_token[0] as string | undefined)
          : null;

    if (!token || !context.authService.verifyAccessToken(token)) {
      socket.send(JSON.stringify({ error: 'unauthorized' }));
      socket.close(4401, 'unauthorized');
      return;
    }

    context.streamHub.registerConnection(socket);
  });

  context.streamHub.on('replayRequested', async ({ socket, request }) => {
    context.logger.info(request, 'websocket replay request received');

    const replay = context.eventService.replay({
      lastSeenSequence: request.lastSeenSequence,
      ...(request.sessionId ? { sessionId: request.sessionId } : {})
    });

    if (replay.replayExpired) {
      const opencodeReplaySessions = await listOpenCodeSessionsForAggregate(context, 200);
      context.streamHub.sendJson(socket, {
        type: 'replay.expired',
        snapshot: {
          sessions: [
              ...context.codexSessionService.listSessions(200),
              ...opencodeReplaySessions
            ],
          sequence: context.runtime.currentSequence()
        }
      });
      return;
    }

    for (const event of replay.events) {
      context.streamHub.sendEvent(socket, event);
    }

    context.streamHub.sendJson(socket, {
      type: 'replay.completed',
      delivered: replay.events.length,
      nextSequence: replay.nextSequence
    });
  });
}


function getChatService(context: AppContext, session: SessionRecord) {
  return session.source === 'opencode' ? context.opencodeChatService : context.codexChatService;
}

function persistOpenCodeSession(context: AppContext, session: SessionRecord): void {
  context.db.createSession({
    id: session.id,
    workspacePath: session.workspacePath,
    profile: session.profile || 'opencode',
    source: 'opencode',
    status: session.status,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    ...(session.title ? { title: session.title } : {})
  });
}

async function listOpenCodeSessionsForAggregate(context: AppContext, limit: number): Promise<SessionRecord[]> {
  if (context.opencodeSessionService.serverState.status === 'ready') {
    return context.opencodeSessionService.listSessions(limit);
  }
  return context.opencodeSessionService.listSessionsFromSqlite(limit);
}

async function getSession(context: AppContext, sessionId: string): Promise<SessionRecord | null> {
  const localSession = context.db.getSession(sessionId);
  const codexSession = context.codexSessionService.getSession(sessionId);
  const opencodeSession = await context.opencodeSessionService.getSession(sessionId);
  const sessions: SessionRecord[] = [];
  if (localSession) sessions.push(localSession);
  if (codexSession) sessions.push(codexSession);
  if (opencodeSession) sessions.push(opencodeSession);
  const merged = mergeSessions(
    sessions.map((session) => {
      if (session.source === 'opencode') {
        return context.opencodeChatService.applyRuntimeStatus(session);
      }
      return context.codexChatService.applyRuntimeStatus(session);
    })
  );
  return merged[0] ?? null;
}

function sessionWithinWorkspace(sessionPath: string, workspacePath: string): boolean {
  const normalizedSession = normalizeComparablePath(sessionPath);
  const normalizedWorkspace = normalizeComparablePath(workspacePath);
  return normalizedSession === normalizedWorkspace;
}

function isRootedInWorkspace(sessionPath: string, workspacePath: string): boolean {
  const normalizedSession = normalizeComparablePath(sessionPath);
  const normalizedWorkspace = normalizeComparablePath(workspacePath);
  if (normalizedSession === normalizedWorkspace) return true;
  return normalizedSession.startsWith(`${normalizedWorkspace}/`);
}

function normalizeComparablePath(path: string): string {
  const trimmed = path.trim();
  if (!trimmed || trimmed === '.') return '.';
  return trimmed.replace(/\\/g, '/').replace(/\/+$/g, '') || '/';
}

function mergeSessions<T extends SessionRecord>(sessions: T[]): T[] {
  const merged = new Map<string, T>();
  for (const session of sessions) {
    const existing = merged.get(session.id);
    merged.set(session.id, existing ? mergeSession(existing, session) : session);
  }
  return [...merged.values()];
}

function mergeSession<T extends SessionRecord>(left: T, right: T): T {
  const leftScore = sessionStatusPriority(left.status);
  const rightScore = sessionStatusPriority(right.status);
  const rightNewer = Date.parse(right.updatedAt) > Date.parse(left.updatedAt);
  const primary = rightScore > leftScore || (rightScore === leftScore && rightNewer) ? right : left;
  const secondary = primary === right ? left : right;

  return {
    ...secondary,
    ...primary,
    title: primary.title ?? secondary.title,
    omx: primary.omx ?? secondary.omx,
    usageContext: primary.usageContext ?? secondary.usageContext,
    updatedAt: rightNewer ? right.updatedAt : left.updatedAt
  };
}

function sessionStatusPriority(status: SessionStatus): number {
  if (status === 'running') return 50;
  if (status === 'failed') return 40;
  if (status === 'cancelled') return 30;
  if (status === 'created') return 20;
  if (status === 'completed') return 10;
  return 0;
}

function requireAuth(authorizationHeader: string | undefined, context: AppContext, reply: FastifyReply) {
  const auth = authorizeRequest(authorizationHeader, context);
  if (!auth) {
    reply.code(401).send({ error: 'unauthorized' });
    return null;
  }
  return auth;
}

function authorizeRequest(authorizationHeader: string | undefined, context: AppContext) {
  if (!authorizationHeader) {
    return null;
  }

  const [scheme, token] = authorizationHeader.split(' ');

  if (!scheme || !token || scheme.toLowerCase() !== 'bearer') {
    return null;
  }

  return context.authService.verifyAccessToken(token);
}

function isLocalOrPrivateClient(address: string | undefined): boolean {
  if (!address) return false;
  const normalized = address.replace(/^::ffff:/, '');
  if (normalized === '127.0.0.1' || normalized === '::1' || normalized === 'localhost') return true;
  if (/^10\./.test(normalized)) return true;
  if (/^192\.168\./.test(normalized)) return true;
  if (/^172\.(1[6-9]|2\d|3[0-1])\./.test(normalized)) return true;
  if (/^169\.254\./.test(normalized)) return true;
  if (/^(fc|fd)[0-9a-f]{2}:/i.test(normalized)) return true;
  return false;
}
