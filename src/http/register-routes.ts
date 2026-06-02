import websocket from '@fastify/websocket';
import { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import { ModuleManager } from '../core/module-manager.js';
import { completePairingRequestSchema, refreshRequestSchema, revokeRequestSchema } from '../domain/auth.js';
import { chatQuerySchema, sendChatMessageRequestSchema } from '../domain/chat.js';
import { emitEventRequestSchema } from '../domain/events.js';
import { interactionIdParamsSchema, interactionResponseSchema } from '../domain/interaction.js';
import { fileQuerySchema, readFileQuerySchema } from '../domain/file.js';
import { createPairingRequestSchema } from '../domain/pairing.js';
import { createSessionRequestSchema, patchSessionRequestSchema } from '../domain/session.js';
import { AppContext } from '../runtime/app-context.js';

const sessionIdSchema = z
  .string()
  .trim()
  .min(1)
  .max(180)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);
const sessionIdParamsSchema = z.object({ sessionId: sessionIdSchema });

const deviceIdParamsSchema = z.object({ deviceId: z.string().uuid() });
const listSessionsQuerySchema = z.object({ limit: z.coerce.number().int().min(1).max(500).default(100) });
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
const codexAuthSwitchRequestSchema = z.object({
  query: z.string().trim().min(1).max(120)
});

export async function registerRoutes(
  app: FastifyInstance<any, any, any, any>,
  context: AppContext,
  moduleManager: ModuleManager
): Promise<void> {
  await app.register(websocket);

  app.get('/health/live', async () => ({
    status: 'ok',
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

    return {
      status: overallStatus,
      timestamp: new Date().toISOString(),
      database: databaseHealth,
      modules: moduleHealth
    };
  });

  app.get('/capabilities', async () => ({
    name: 'dexyd',
    modules: moduleManager.getModuleNames(),
    protocol: {
      rest: 'https',
      websocket: 'wss'
    },
    replayWindowSeconds: context.config.stream.replayWindowSeconds,
    maxReplayEvents: context.config.stream.maxReplayEvents
  }));

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

    const session = context.db.createSession({
      workspacePath,
      profile: parsed.data.profile,
      ...(parsed.data.title ? { title: parsed.data.title } : {})
    });

    context.eventService.emit({
      eventType: 'session.created',
      source: 'session',
      sessionId: session.id,
      payload: session
    });

    return reply.code(201).send({ session });
  });

  app.get('/sessions', async (request, reply) => {
    const auth = requireAuth(request.headers.authorization, context, reply);
    if (!auth) return;

    const parsed = listSessionsQuerySchema.safeParse(request.query);
    const limit = parsed.success ? parsed.data.limit : 100;

    const hidden = context.db.listHiddenSessionIds();
    const localSessions = context.db.listSessions(limit).filter((session) => !hidden.has(session.id));
    const codexSessions = context.codexSessionService.listSessions(limit).filter((session) => !hidden.has(session.id));
    const seen = new Set<string>();
    const sessions = [...localSessions, ...codexSessions]
      .filter((session) => {
        if (seen.has(session.id)) return false;
        seen.add(session.id);
        return true;
      })
      .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))
      .slice(0, limit);
    return { sessions };
  });

  app.get('/sessions/:sessionId', async (request, reply) => {
    const auth = requireAuth(request.headers.authorization, context, reply);
    if (!auth) return;

    const params = sessionIdParamsSchema.safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send({ error: 'invalid_session_id', issues: params.error.issues });
    }

    const session = getSession(context, params.data.sessionId);
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

    const session = getSession(context, params.data.sessionId);
    if (!session) {
      context.db.hideSession(params.data.sessionId);
      return { deleted: false, hidden: true };
    }

    const deleted = context.db.deleteSession(params.data.sessionId);
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

    const session = getSession(context, params.data.sessionId);
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

    const session = getSession(context, params.data.sessionId);
    if (!session) {
      return reply.code(404).send({ error: 'session_not_found' });
    }

    return {
      messages: context.codexChatService.getMessages(params.data.sessionId, query.data.limit)
    };
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

    const session = getSession(context, params.data.sessionId);
    if (!session) {
      return reply.code(404).send({ error: 'session_not_found' });
    }

    const usage = context.codexSessionService.getUsageStatus(params.data.sessionId);
    if (usage.limits.status === 'error') {
      return reply.code(429).send({
        error: 'usage_limit_reached',
        detail: usage.limits.detail || 'Codex usage limit has been reached. Wait for the limit to reset or switch account.',
        usage
      });
    }

    let result: ReturnType<typeof context.codexChatService.sendMessage>;
    try {
      result = context.codexChatService.sendMessage({
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

    const session = getSession(context, params.data.sessionId);
    if (!session) {
      return reply.code(404).send({ error: 'session_not_found' });
    }

    const killed = context.codexChatService.cancelSession(session.id);
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

    const session = getSession(context, params.data.sessionId);
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

    const session = getSession(context, params.data.sessionId);
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

    const session = getSession(context, params.data.sessionId);
    if (!session) {
      return reply.code(404).send({ error: 'session_not_found' });
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
      const session = getSession(context, body.data.sessionId);
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

    return {
      ...replay,
      snapshot: replay.replayExpired
        ? {
            sessions: context.codexSessionService.listSessions(200),
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

  context.streamHub.on('replayRequested', ({ socket, request }) => {
    context.logger.info(request, 'websocket replay request received');

    const replay = context.eventService.replay({
      lastSeenSequence: request.lastSeenSequence,
      ...(request.sessionId ? { sessionId: request.sessionId } : {})
    });

    if (replay.replayExpired) {
      context.streamHub.sendJson(socket, {
        type: 'replay.expired',
        snapshot: {
          sessions: context.codexSessionService.listSessions(200),
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


function getSession(context: AppContext, sessionId: string) {
  return context.db.getSession(sessionId) ?? context.codexSessionService.getSession(sessionId);
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
