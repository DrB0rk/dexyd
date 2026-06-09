import { existsSync } from 'node:fs';
import Database from 'better-sqlite3';
import { ChatMessage } from '../domain/chat.js';
import { SessionRecord } from '../domain/session.js';

export type OpenCodeSessionRecord = SessionRecord & {
  source: 'opencode';
  model: string | null;
  agent: string | null;
  tokenUsage: {
    input: number | null;
    output: number | null;
    total: number | null;
  } | null;
};

type UsageContext = {
  usedTokens: number | null;
  windowTokens: number | null;
  percent: number | null;
  status: 'ok' | 'warn' | 'error' | 'unknown';
};

type LoggerLike = {
  warn: (obj: unknown, msg?: string) => void;
};

type SessionRow = {
  id: string;
  directory: string;
  title: string | null;
  agent: string | null;
  model: string | null;
  tokens_input: number | null;
  tokens_output: number | null;
  tokens_total: number | null;
  time_created: string;
  time_updated: string;
};

type MessageRow = {
  id: string;
  session_id: string;
  type: string;
  data: string;
  seq: number;
  time_created: string;
};

export class OpenCodeSessionService {
  private db: Database.Database | null = null;

  constructor(
    private readonly dataDir: string,
    private readonly logger: LoggerLike
  ) {
    const dbPath = `${dataDir}/opencode.db`;
    if (!existsSync(dbPath)) {
      this.logger.warn({ dbPath }, 'OpenCode database not found at configured path');
      return;
    }
    try {
      this.db = new Database(dbPath, { readonly: true });
    } catch (error) {
      this.logger.warn({ error, dbPath }, 'Failed to open OpenCode database');
    }
  }

  listSessions(limit = 100): OpenCodeSessionRecord[] {
    if (!this.db) return [];

    try {
      const rows = this.db
        .prepare(
          `SELECT s.id, s.directory, s.title, s.agent, s.model,
                  s.tokens_input, s.tokens_output, s.tokens_total,
                  s.time_created, s.time_updated
           FROM session s
           LEFT JOIN project p ON s.project_id = p.id
           ORDER BY s.time_updated DESC
           LIMIT ?`
        )
        .all(limit) as SessionRow[];

      return rows.map((row) => this.#mapSessionRow(row));
    } catch (error) {
      this.logger.warn({ error }, 'Failed to list OpenCode sessions');
      return [];
    }
  }

  getSession(sessionId: string): OpenCodeSessionRecord | null {
    if (!this.db) return null;

    try {
      const row = this.db
        .prepare(
          `SELECT s.id, s.directory, s.title, s.agent, s.model,
                  s.tokens_input, s.tokens_output, s.tokens_total,
                  s.time_created, s.time_updated
           FROM session s
           LEFT JOIN project p ON s.project_id = p.id
           WHERE s.id = ?`
        )
        .get(sessionId) as SessionRow | undefined;

      if (!row) return null;
      return this.#mapSessionRow(row);
    } catch (error) {
      this.logger.warn({ error, sessionId }, 'Failed to get OpenCode session');
      return null;
    }
  }

  getMessages(sessionId: string, limit = 200): ChatMessage[] {
    if (!this.db) return [];

    try {
      const rows = this.db
        .prepare(
          `SELECT id, session_id, type, data, seq, time_created
           FROM session_message
           WHERE session_id = ?
           ORDER BY seq ASC
           LIMIT ?`
        )
        .all(sessionId, limit) as MessageRow[];

      return rows.map((row) => this.#mapMessageRow(row));
    } catch (error) {
      this.logger.warn({ error, sessionId }, 'Failed to get OpenCode session messages');
      return [];
    }
  }

  getUsageContext(sessionId: string): UsageContext | undefined {
    if (!this.db) return undefined;

    try {
      const row = this.db
        .prepare(
          `SELECT tokens_input, tokens_output, tokens_total
           FROM session
           WHERE id = ?`
        )
        .get(sessionId) as
        | { tokens_input: number | null; tokens_output: number | null; tokens_total: number | null }
        | undefined;

      if (!row) return undefined;

      const total = row.tokens_total ?? null;
      if (total === null) return undefined;

      return {
        usedTokens: total,
        windowTokens: null,
        percent: null,
        status: 'unknown'
      };
    } catch (error) {
      this.logger.warn({ error, sessionId }, 'Failed to get OpenCode session usage context');
      return undefined;
    }
  }

  #mapSessionRow(row: SessionRow): OpenCodeSessionRecord {
    const tokenInput = row.tokens_input ?? null;
    const tokenOutput = row.tokens_output ?? null;
    const tokenTotal = row.tokens_total ?? null;
    const hasTokens = tokenInput !== null || tokenOutput !== null || tokenTotal !== null;

    return {
      id: row.id,
      status: 'idle',
      profile: 'opencode',
      workspacePath: row.directory,
      createdAt: row.time_created,
      updatedAt: row.time_updated,
      source: 'opencode',
      title: cleanTitle(row.title) || undefined,
      model: row.model,
      agent: row.agent,
      tokenUsage: hasTokens ? { input: tokenInput, output: tokenOutput, total: tokenTotal } : null
    };
  }

  #mapMessageRow(row: MessageRow): ChatMessage {
    const data = parseDataField(row.data);
    const content = extractTextContent(row.type, data);

    return {
      id: row.id,
      turnId: `${row.session_id}-${row.seq}`,
      role: mapRole(row.type),
      content,
      createdAt: row.time_created,
      sequence: row.seq,
      status: 'sent'
    };
  }
}

function parseDataField(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

function extractTextContent(type: string, data: unknown): string {
  if (typeof data === 'string') {
    const trimmed = data.trim();
    if (trimmed) return trimmed;
  }

  if (data && typeof data === 'object' && !Array.isArray(data)) {
    const obj = data as Record<string, unknown>;

    if (typeof obj.message === 'string' && obj.message.trim()) {
      return obj.message.trim();
    }

    if (typeof obj.text === 'string' && obj.text.trim()) {
      return obj.text.trim();
    }

    if (typeof obj.content === 'string') {
      const trimmed = obj.content.trim();
      if (trimmed) return trimmed;
    }

    if (Array.isArray(obj.content)) {
      return obj.content
        .map((item: unknown) => {
          if (item && typeof item === 'object' && !Array.isArray(item)) {
            const block = item as Record<string, unknown>;
            if (typeof block.text === 'string') return block.text;
          }
          return '';
        })
        .filter(Boolean)
        .join('\n')
        .trim();
    }
  }

  return '';
}

function mapRole(type: string): ChatMessage['role'] {
  if (type === 'user' || type === 'assistant' || type === 'system' || type === 'tool') {
    return type;
  }
  return 'system';
}

function cleanTitle(value: string | null | undefined): string {
  return (value || '').replace(/\s+/g, ' ').trim().slice(0, 120);
}