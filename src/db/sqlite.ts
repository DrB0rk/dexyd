import { mkdirSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import Database from 'better-sqlite3';
import { DexydConfig } from '../config/schema.js';
import { SessionRecord, SessionStatus } from '../domain/session.js';
import { migrations } from './migrations.js';
import { EventEnvelope } from '../runtime/runtime-state.js';

type LoggerLike = {
  info: (obj: unknown, msg?: string) => void;
  debug: (obj: unknown, msg?: string) => void;
  warn: (obj: unknown, msg?: string) => void;
};

type SessionRow = {
  id: string;
  status: SessionStatus;
  profile: string | null;
  workspace_path: string;
  created_at: string;
  updated_at: string;
  title: string | null;
};

type EventRow = {
  sequence: number;
  timestamp: string;
  event_type: string;
  session_id: string | null;
  stream_id: string | null;
  source: string;
  payload_json: string;
};

type DeviceRow = {
  id: string;
  label: string;
  trust_state: string;
  created_at: string;
  last_seen_at: string | null;
};

type PairingRow = {
  id: string;
  challenge: string;
  status: string;
  expires_at: string;
  created_at: string;
  payload_json: string | null;
  completed_at: string | null;
  device_id: string | null;
};

type RefreshTokenRow = {
  id: string;
  device_id: string;
  token_hash: string;
  expires_at: string;
  created_at: string;
  revoked_at: string | null;
};

export type DeviceRecord = {
  id: string;
  label: string;
  trustState: string;
  createdAt: string;
  lastSeenAt: string | null;
};

export type PairingRecord = {
  id: string;
  challenge: string;
  status: string;
  expiresAt: string;
  createdAt: string;
  payload: unknown;
  completedAt: string | null;
  deviceId: string | null;
};


function cleanOptionalTitle(value: string | null | undefined): string | null {
  const title = typeof value === 'string' ? value.trim() : '';
  return title ? title.slice(0, 160) : null;
}

export class SqliteService {
  #db: Database.Database;

  constructor(
    private readonly config: DexydConfig,
    private readonly logger: LoggerLike
  ) {
    const dbPath = resolve(config.storage.sqlitePath);
    mkdirSync(dirname(dbPath), { recursive: true });

    this.#db = new Database(dbPath);
    this.#db.pragma('journal_mode = WAL');
    this.#db.pragma('foreign_keys = ON');
    this.#db.pragma('busy_timeout = 5000');

    this.applyMigrations();

    this.logger.info({ dbPath }, 'sqlite initialized');
  }

  close(): void {
    this.#db.close();
  }

  health(): { status: 'ready' | 'down'; details: Record<string, unknown> } {
    try {
      const row = this.#db.prepare('SELECT 1 AS ok').get() as { ok: number };
      return {
        status: row.ok === 1 ? 'ready' : 'down',
        details: {
          walMode: this.#db.pragma('journal_mode', { simple: true })
        }
      };
    } catch (error) {
      return {
        status: 'down',
        details: {
          error: error instanceof Error ? error.message : 'unknown'
        }
      };
    }
  }

  getLatestEventSequence(): number {
    const row = this.#db.prepare('SELECT COALESCE(MAX(sequence), 0) AS maxSequence FROM events').get() as {
      maxSequence: number;
    };

    return row.maxSequence;
  }

  createSession(input: { workspacePath: string; profile: string; title?: string | null }): SessionRecord {
    const id = randomUUID();
    const now = new Date().toISOString();

    this.#db
      .prepare(
        `
        INSERT INTO sessions (id, status, profile, workspace_path, created_at, updated_at, title)
        VALUES (@id, @status, @profile, @workspacePath, @createdAt, @updatedAt, @title)
      `
      )
      .run({
        id,
        status: 'created',
        profile: input.profile,
        workspacePath: input.workspacePath,
        createdAt: now,
        updatedAt: now,
        title: cleanOptionalTitle(input.title)
      });

    return {
      id,
      status: 'created',
      profile: input.profile,
      workspacePath: input.workspacePath,
      createdAt: now,
      updatedAt: now,
      ...(cleanOptionalTitle(input.title) ? { title: cleanOptionalTitle(input.title) ?? undefined } : {})
    };
  }

  listSessions(limit = 100): SessionRecord[] {
    const rows = this.#db
      .prepare(
        `
      SELECT id, status, profile, workspace_path, created_at, updated_at, title
      FROM sessions
      ORDER BY updated_at DESC
      LIMIT ?
    `
      )
      .all(limit) as SessionRow[];

    return rows.map((row) => this.#mapSessionRow(row));
  }

  getSession(sessionId: string): SessionRecord | null {
    const row = this.#db
      .prepare(
        `
      SELECT id, status, profile, workspace_path, created_at, updated_at, title
      FROM sessions
      WHERE id = ?
    `
      )
      .get(sessionId) as SessionRow | undefined;

    if (!row) {
      return null;
    }

    return this.#mapSessionRow(row);
  }

  deleteSession(sessionId: string): boolean {
    const tx = this.#db.transaction(() => {
      this.#db.prepare('DELETE FROM events WHERE session_id = ?').run(sessionId);
      const result = this.#db.prepare('DELETE FROM sessions WHERE id = ?').run(sessionId);
      this.hideSession(sessionId);
      return result.changes > 0;
    });
    return tx();
  }

  hideSession(sessionId: string): void {
    this.#db
      .prepare('INSERT OR REPLACE INTO hidden_sessions (id, hidden_at) VALUES (?, ?)')
      .run(sessionId, new Date().toISOString());
  }

  listHiddenSessionIds(): Set<string> {
    const rows = this.#db.prepare('SELECT id FROM hidden_sessions').all() as Array<{ id: string }>;
    return new Set(rows.map((row) => row.id));
  }

  patchSession(input: {
    sessionId: string;
    status?: SessionStatus;
    profile?: string;
  }): SessionRecord | null {
    const existing = this.getSession(input.sessionId);
    if (!existing) {
      return null;
    }

    const nextStatus = input.status ?? existing.status;
    const nextProfile = input.profile ?? existing.profile;
    const updatedAt = new Date().toISOString();

    this.#db
      .prepare(
        `
      UPDATE sessions
      SET status = @status,
          profile = @profile,
          updated_at = @updatedAt
      WHERE id = @sessionId
    `
      )
      .run({
        sessionId: input.sessionId,
        status: nextStatus,
        profile: nextProfile,
        updatedAt
      });

    return {
      ...existing,
      status: nextStatus,
      profile: nextProfile,
      updatedAt,
      ...(existing.title ? { title: existing.title } : {})
    };
  }

  persistEvent(event: EventEnvelope): void {
    this.#db
      .prepare(
        `
      INSERT INTO events (sequence, timestamp, session_id, stream_id, event_type, source, payload_json, created_at)
      VALUES (@sequence, @timestamp, @sessionId, @streamId, @eventType, @source, @payloadJson, @createdAt)
    `
      )
      .run({
        sequence: event.sequence,
        timestamp: event.timestamp,
        sessionId: event.sessionId,
        streamId: event.streamId,
        eventType: event.eventType,
        source: event.source,
        payloadJson: JSON.stringify(event.payload),
        createdAt: event.timestamp
      });
  }

  getEventsSince(input: {
    lastSeenSequence: number;
    sessionId?: string;
    replayWindowSeconds: number;
    maxEvents: number;
  }): {
    replayExpired: boolean;
    events: EventEnvelope[];
    nextSequence: number;
  } {
    const windowStartIso = new Date(Date.now() - input.replayWindowSeconds * 1000).toISOString();

    const whereSession = input.sessionId ? 'AND session_id = @sessionId' : '';

    const minAvailableRow = this.#db
      .prepare(
        `
      SELECT MIN(sequence) AS minSequence
      FROM events
      WHERE created_at >= @windowStartIso
      ${whereSession}
    `
      )
      .get({ windowStartIso, sessionId: input.sessionId ?? null }) as { minSequence: number | null };

    const replayExpired =
      minAvailableRow.minSequence !== null && input.lastSeenSequence < minAvailableRow.minSequence - 1;

    const rows = this.#db
      .prepare(
        `
      SELECT sequence, timestamp, event_type, session_id, stream_id, source, payload_json
      FROM events
      WHERE sequence > @lastSeenSequence
        AND created_at >= @windowStartIso
        ${whereSession}
      ORDER BY sequence ASC
      LIMIT @maxEvents
    `
      )
      .all({
        lastSeenSequence: input.lastSeenSequence,
        windowStartIso,
        sessionId: input.sessionId ?? null,
        maxEvents: input.maxEvents
      }) as EventRow[];

    const events = rows.map((row) => this.#mapEventRow(row));

    const nextSequence = events.at(-1)?.sequence ?? input.lastSeenSequence;

    return {
      replayExpired,
      events,
      nextSequence
    };
  }

  listSessionEvents(sessionId: string, limit = 200): EventEnvelope[] {
    const rows = this.#db
      .prepare(
        `
      SELECT sequence, timestamp, event_type, session_id, stream_id, source, payload_json
      FROM events
      WHERE session_id = @sessionId
      ORDER BY sequence DESC
      LIMIT @limit
    `
      )
      .all({ sessionId, limit }) as EventRow[];

    return rows.reverse().map((row) => this.#mapEventRow(row));
  }

  pruneEventsOlderThan(cutoffIso: string): number {
    const result = this.#db.prepare('DELETE FROM events WHERE created_at < ?').run(cutoffIso);
    return result.changes;
  }

  createPairingSession(input: { pairingId?: string; challenge: string; expiresAt: string; payload: unknown }): PairingRecord {
    const now = new Date().toISOString();
    const id = input.pairingId ?? randomUUID();

    this.#db
      .prepare(
        `
      INSERT INTO pairing_sessions (id, challenge, status, expires_at, created_at, payload_json)
      VALUES (@id, @challenge, 'pending', @expiresAt, @createdAt, @payloadJson)
    `
      )
      .run({
        id,
        challenge: input.challenge,
        expiresAt: input.expiresAt,
        createdAt: now,
        payloadJson: JSON.stringify(input.payload)
      });

    const created = this.getPairingSession(id);
    if (!created) {
      throw new Error('failed to create pairing session');
    }

    return created;
  }

  getPairingSession(pairingId: string): PairingRecord | null {
    const row = this.#db
      .prepare(
        `
      SELECT id, challenge, status, expires_at, created_at, payload_json, completed_at, device_id
      FROM pairing_sessions
      WHERE id = ?
    `
      )
      .get(pairingId) as PairingRow | undefined;

    if (!row) {
      return null;
    }

    let payload: unknown = null;
    try {
      payload = row.payload_json ? JSON.parse(row.payload_json) : null;
    } catch {
      payload = row.payload_json;
    }

    return {
      id: row.id,
      challenge: row.challenge,
      status: row.status,
      expiresAt: row.expires_at,
      createdAt: row.created_at,
      payload,
      completedAt: row.completed_at,
      deviceId: row.device_id
    };
  }

  markPairingSessionCompleted(input: { pairingId: string; deviceId: string }): void {
    this.#db
      .prepare(
        `
      UPDATE pairing_sessions
      SET status = 'completed', completed_at = @completedAt, device_id = @deviceId
      WHERE id = @pairingId
    `
      )
      .run({
        pairingId: input.pairingId,
        deviceId: input.deviceId,
        completedAt: new Date().toISOString()
      });
  }

  createDevice(input: { label: string }): DeviceRecord {
    const id = randomUUID();
    const now = new Date().toISOString();

    this.#db
      .prepare(
        `
      INSERT INTO devices (id, label, trust_state, created_at, last_seen_at)
      VALUES (@id, @label, 'trusted', @createdAt, @lastSeenAt)
    `
      )
      .run({
        id,
        label: input.label,
        createdAt: now,
        lastSeenAt: now
      });

    const device = this.getDevice(id);
    if (!device) {
      throw new Error('failed to create device');
    }

    return device;
  }

  listDevices(): DeviceRecord[] {
    const rows = this.#db
      .prepare(
        `
      SELECT id, label, trust_state, created_at, last_seen_at
      FROM devices
      WHERE trust_state != 'revoked'
      ORDER BY created_at DESC
    `
      )
      .all() as DeviceRow[];

    return rows.map((row) => this.#mapDeviceRow(row));
  }

  getDevice(deviceId: string): DeviceRecord | null {
    const row = this.#db
      .prepare(
        `
      SELECT id, label, trust_state, created_at, last_seen_at
      FROM devices
      WHERE id = ?
    `
      )
      .get(deviceId) as DeviceRow | undefined;

    return row ? this.#mapDeviceRow(row) : null;
  }

  touchDevice(deviceId: string): void {
    this.#db
      .prepare('UPDATE devices SET last_seen_at = ? WHERE id = ?')
      .run(new Date().toISOString(), deviceId);
  }

  revokeDevice(deviceId: string): boolean {
    const result = this.#db
      .prepare("UPDATE devices SET trust_state = 'revoked' WHERE id = ?")
      .run(deviceId);

    return result.changes > 0;
  }

  storeRefreshToken(input: { deviceId: string; tokenHash: string; expiresAt: string }): string {
    const id = randomUUID();
    const now = new Date().toISOString();

    this.#db
      .prepare(
        `
      INSERT INTO refresh_tokens (id, device_id, token_hash, expires_at, created_at, revoked_at)
      VALUES (@id, @deviceId, @tokenHash, @expiresAt, @createdAt, NULL)
    `
      )
      .run({
        id,
        deviceId: input.deviceId,
        tokenHash: input.tokenHash,
        expiresAt: input.expiresAt,
        createdAt: now
      });

    return id;
  }

  findActiveRefreshToken(tokenHash: string): RefreshTokenRow | null {
    const row = this.#db
      .prepare(
        `
      SELECT id, device_id, token_hash, expires_at, created_at, revoked_at
      FROM refresh_tokens
      WHERE token_hash = ?
        AND revoked_at IS NULL
      LIMIT 1
    `
      )
      .get(tokenHash) as RefreshTokenRow | undefined;

    if (!row) {
      return null;
    }

    if (new Date(row.expires_at).getTime() <= Date.now()) {
      return null;
    }

    return row;
  }

  revokeRefreshTokenByHash(tokenHash: string): void {
    this.#db
      .prepare('UPDATE refresh_tokens SET revoked_at = ? WHERE token_hash = ?')
      .run(new Date().toISOString(), tokenHash);
  }

  revokeAllRefreshTokensForDevice(deviceId: string): void {
    this.#db
      .prepare('UPDATE refresh_tokens SET revoked_at = ? WHERE device_id = ? AND revoked_at IS NULL')
      .run(new Date().toISOString(), deviceId);
  }

  addAuditLog(input: {
    actor: string;
    action: string;
    target?: string;
    metadata?: unknown;
  }): void {
    this.#db
      .prepare(
        `
      INSERT INTO audit_logs (id, actor, action, target, metadata_json, created_at)
      VALUES (@id, @actor, @action, @target, @metadataJson, @createdAt)
    `
      )
      .run({
        id: randomUUID(),
        actor: input.actor,
        action: input.action,
        target: input.target ?? null,
        metadataJson: input.metadata ? JSON.stringify(input.metadata) : null,
        createdAt: new Date().toISOString()
      });
  }

  #mapSessionRow(row: SessionRow): SessionRecord {
    return {
      id: row.id,
      status: row.status,
      profile: row.profile ?? 'default',
      workspacePath: row.workspace_path,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      ...(row.title ? { title: row.title } : {})
    };
  }

  #mapEventRow(row: EventRow): EventEnvelope {
    let payload: unknown;

    try {
      payload = JSON.parse(row.payload_json);
    } catch {
      payload = row.payload_json;
    }

    return {
      sequence: row.sequence,
      timestamp: row.timestamp,
      eventType: row.event_type,
      sessionId: row.session_id,
      streamId: row.stream_id,
      source: row.source as EventEnvelope['source'],
      payload
    };
  }

  #mapDeviceRow(row: DeviceRow): DeviceRecord {
    return {
      id: row.id,
      label: row.label,
      trustState: row.trust_state,
      createdAt: row.created_at,
      lastSeenAt: row.last_seen_at
    };
  }

  private applyMigrations(): void {
    this.#db.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        id TEXT PRIMARY KEY,
        applied_at TEXT NOT NULL
      );
    `);

    const appliedRows = this.#db.prepare('SELECT id FROM schema_migrations').all() as Array<{ id: string }>;

    const applied = new Set(appliedRows.map((row) => row.id));

    const insertMigration = this.#db.prepare('INSERT INTO schema_migrations (id, applied_at) VALUES (?, ?)');

    const transaction = this.#db.transaction(() => {
      for (const migration of migrations) {
        if (applied.has(migration.id)) {
          continue;
        }

        this.logger.debug({ migrationId: migration.id }, 'applying sqlite migration');
        this.#executeStatementsLenient(migration.sql);
        insertMigration.run(migration.id, new Date().toISOString());
      }
    });

    transaction();
  }

  #executeStatementsLenient(sql: string): void {
    const statements = sql
      .split(';')
      .map((statement) => statement.trim())
      .filter((statement) => statement.length > 0);

    for (const statement of statements) {
      try {
        this.#db.exec(`${statement};`);
      } catch (error) {
        const message = error instanceof Error ? error.message.toLowerCase() : '';
        if (message.includes('duplicate column name')) {
          this.logger.warn({ statement }, 'ignoring duplicate-column migration statement');
          continue;
        }
        throw error;
      }
    }
  }
}
