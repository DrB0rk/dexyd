import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { ChatMessage } from '../domain/chat.js';
import { SessionRecord } from '../domain/session.js';

export type CodexSessionRecord = SessionRecord & {
  source: 'codex';
  title: string;
  codexSessionPath: string;
  omx: boolean;
};

export type TokenUsage = {
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  reasoningOutputTokens: number;
  totalTokens: number;
};

export type UsageStatus = {
  status: 'ok' | 'warn' | 'error' | 'unknown';
  updatedAt: string | null;
  sessionId: string | null;
  context: {
    usedTokens: number | null;
    windowTokens: number | null;
    percent: number | null;
    status: 'ok' | 'warn' | 'error' | 'unknown';
  };
  total: TokenUsage | null;
  last: TokenUsage | null;
  limits: {
    status: 'ok' | 'warn' | 'error' | 'unknown';
    label: string;
    detail: string;
    raw: unknown;
  };
};

type UsageContext = UsageStatus['context'];

type LoggerLike = {
  warn: (obj: unknown, msg?: string) => void;
};

type SessionIndexEntry = {
  id?: string;
  thread_name?: string;
  updated_at?: string;
};

type HistoryEntry = {
  session_id?: string;
  ts?: number;
  text?: string;
};

type SessionCandidate = {
  id: string;
  path: string;
  title: string | undefined;
  cwd: string | undefined;
  createdAt: string | undefined;
  updatedAt: string | undefined;
  originator: string | undefined;
  source: string | undefined;
  omx: boolean | undefined;
  active: boolean | undefined;
  usageContext: UsageContext | undefined;
};

type TranscriptActivity = {
  running: boolean;
  updatedAt: string | null;
};

type ToolActivity = {
  callId: string;
  name: string;
  turnId: string;
  category: ToolCategory;
  detail: string | null;
};

type ToolCategory = 'command' | 'edit' | 'plan' | 'inspect' | 'network' | 'image' | 'generic';

const CODEX_SESSION_ID_RE = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i;
const MAX_SESSION_FILES = 400;
const MAX_CHAT_LINES = 5000;
const ACTIVE_TRANSCRIPT_MAX_AGE_MS = 4 * 60 * 60 * 1000;

export class CodexSessionService {
  private readonly codexHome: string;
  private readonly omxHome: string;

  constructor(private readonly workspaceRoot: string, private readonly logger: LoggerLike) {
    this.codexHome = resolve(process.env.CODEX_HOME || join(homedir(), '.codex'));
    this.omxHome = resolve(process.env.OMX_HOME || join(homedir(), '.omx'));
  }

  createSession(input: { workspacePath: string; title?: string | null }): CodexSessionRecord {
    const workspacePath = realpathSync(resolve(input.workspacePath));
    if (!isInsideWorkspace(this.workspaceRoot, workspacePath)) {
      throw new Error('workspace_outside_root');
    }

    const id = randomUUID();
    const now = new Date();
    const timestamp = now.toISOString();
    const sessionDir = join(
      this.codexHome,
      'sessions',
      String(now.getUTCFullYear()),
      pad2(now.getUTCMonth() + 1),
      pad2(now.getUTCDate())
    );
    mkdirSync(sessionDir, { recursive: true });
    mkdirSync(this.codexHome, { recursive: true });

    const codexSessionPath = join(sessionDir, `rollout-${formatSessionFileTimestamp(now)}-${id}.jsonl`);
    const title = cleanTitle(input.title ?? undefined) || basename(workspacePath) || 'Dexyd session';
    const meta = {
      timestamp,
      type: 'session_meta',
      payload: {
        id,
        timestamp,
        cwd: workspacePath,
        originator: 'dexyd',
        source: 'dexyd-mobile',
        thread_source: 'user'
      }
    };

    writeFileSync(codexSessionPath, `${JSON.stringify(meta)}\n`, { flag: 'wx' });
    appendJsonLine(join(this.codexHome, 'session_index.jsonl'), {
      id,
      thread_name: title,
      updated_at: timestamp
    });

    return {
      id,
      status: 'idle',
      profile: 'dexyd',
      workspacePath,
      createdAt: timestamp,
      updatedAt: timestamp,
      source: 'codex',
      title,
      codexSessionPath,
      omx: false
    };
  }

  listSessions(limit = 100): CodexSessionRecord[] {
    const index = this.readSessionIndex();
    const history = this.readHistory();
    const activeOmx = this.readActiveOmxSessionIds();
    const omxSessions = this.readOmxSessionIds();
    const candidates = new Map<string, SessionCandidate>();

    for (const file of this.findSessionFiles()) {
      const id = extractSessionId(file);
      if (!id) continue;

      const fileStat = safeStat(file);
      const fromFile = this.readSessionMeta(file);
      const activity = this.readTranscriptActivity(file, fileStat?.mtimeMs);
      const usageContext = this.readTranscriptUsageContext(file);
      const indexed = index.get(id);
      const fromHistory = history.get(id);
      const cwd = fromFile.cwd;

      if (cwd && !isInsideWorkspace(this.workspaceRoot, cwd)) {
        continue;
      }

      candidates.set(id, {
        id,
        path: file,
        title: indexed?.thread_name || fromHistory?.text || fromFile.title,
        cwd,
        createdAt: fromFile.createdAt || fileStat?.birthtime.toISOString() || fileStat?.mtime.toISOString(),
        updatedAt: indexed?.updated_at || fromHistory?.updatedAt || fileStat?.mtime.toISOString(),
        originator: fromFile.originator,
        source: fromFile.source,
        omx: fromFile.omx || omxSessions.has(id) || activeOmx.has(id),
        active: activity.running,
        usageContext
      });
    }

    return [...candidates.values()]
      .filter((candidate) => candidate.cwd)
      .sort((a, b) => Date.parse(b.updatedAt || '') - Date.parse(a.updatedAt || ''))
      .slice(0, limit)
      .map((candidate) => ({
        id: candidate.id,
        status: activeOmx.has(candidate.id) || candidate.active ? 'running' : 'idle',
        profile: candidate.omx ? 'omx' : candidate.originator || candidate.source || 'codex',
        workspacePath: candidate.cwd!,
        createdAt: candidate.createdAt || candidate.updatedAt || new Date(0).toISOString(),
        updatedAt: candidate.updatedAt || candidate.createdAt || new Date(0).toISOString(),
        source: 'codex',
        title: cleanTitle(candidate.title ? normalizeTranscriptUserMessage(candidate.title) : undefined) || cleanTitle(candidate.title) || basename(candidate.cwd!) || candidate.id,
        codexSessionPath: candidate.path,
        omx: Boolean(candidate.omx),
        ...(candidate.usageContext ? { usageContext: candidate.usageContext } : {})
      }));
  }

  getSession(sessionId: string): CodexSessionRecord | null {
    return this.listSessions(MAX_SESSION_FILES).find((session) => session.id === sessionId) ?? null;
  }

  getUsageStatus(sessionId?: string): UsageStatus {
    const session = sessionId ? this.getSession(sessionId) : this.listSessions(1)[0];
    const fallback: UsageStatus = {
      status: 'unknown',
      updatedAt: null,
      sessionId: session?.id ?? null,
      context: {
        usedTokens: null,
        windowTokens: null,
        percent: null,
        status: 'unknown'
      },
      total: null,
      last: null,
      limits: {
        status: 'unknown',
        label: 'limits unknown',
        detail: 'No Codex usage telemetry has been observed yet.',
        raw: null
      }
    };
    if (!session) return fallback;

    for (const line of readLastLines(session.codexSessionPath, MAX_CHAT_LINES).reverse()) {
      const parsed = parseJsonLine(line);
      if (!parsed || !isRecord(parsed)) continue;
      const payload = isRecord(parsed.payload) ? parsed.payload : {};
      if (parsed.type !== 'event_msg' || payload.type !== 'token_count') continue;

      const info = isRecord(payload.info) ? payload.info : {};
      const total = tokenUsageFromRecord(info.total_token_usage);
      const last = tokenUsageFromRecord(info.last_token_usage);
      const windowTokens = typeof info.model_context_window === 'number' ? info.model_context_window : null;
      const usedTokens = last?.totalTokens ?? total?.totalTokens ?? null;
      const percent = usedTokens !== null && windowTokens ? Math.round((usedTokens / windowTokens) * 1000) / 10 : null;
      const contextStatus = percent === null ? 'unknown' : percent >= 95 ? 'error' : percent >= 80 ? 'warn' : 'ok';
      const limits = limitStatusFromTelemetry(payload.rate_limits);
      const status = limits.status === 'unknown' ? 'ok' : limits.status;

      return {
        status,
        updatedAt: typeof parsed.timestamp === 'string' ? parsed.timestamp : session.updatedAt,
        sessionId: session.id,
        context: {
          usedTokens,
          windowTokens,
          percent,
          status: contextStatus
        },
        total,
        last,
        limits
      };
    }

    return fallback;
  }

  getMessages(sessionId: string, limit = 200): ChatMessage[] {
    const session = this.getSession(sessionId);
    if (!session) return [];

    const lines = readLastLines(session.codexSessionPath, MAX_CHAT_LINES);
    const messages: ChatMessage[] = [];
    const toolActivities = new Map<string, ToolActivity>();
    let sequence = 1;

    for (const line of lines) {
      const parsed = parseJsonLine(line);
      if (!parsed || typeof parsed !== 'object') continue;
      const entry = parsed as Record<string, unknown>;
      const timestamp = typeof entry.timestamp === 'string' ? entry.timestamp : session.updatedAt;
      const type = entry.type;
      const payload = isRecord(entry.payload) ? entry.payload : {};

      if (type === 'event_msg' && payload.type === 'user_message' && typeof payload.message === 'string') {
        const content = normalizeTranscriptUserMessage(payload.message);
        if (!content) continue;
        appendChatMessage(messages, {
          id: `${sessionId}-user-${sequence}`,
          turnId: typeof payload.turn_id === 'string' ? payload.turn_id : `${sessionId}-${sequence}`,
          role: 'user',
          content,
          createdAt: timestamp,
          sequence: sequence++,
          status: 'sent'
        });
        continue;
      }

      if (type === 'response_item' && payload.type === 'message') {
        const content = extractMessageText(payload.content);
        const message = chatMessageFromResponseRole(payload.role, content);
        if (!message || !content || isNoisyToolText(content)) continue;
        appendChatMessage(messages, {
          id: `${sessionId}-${message.role}-${sequence}`,
          turnId: typeof payload.turn_id === 'string' ? payload.turn_id : `${sessionId}-${sequence}`,
          role: message.role,
          content: message.content,
          createdAt: timestamp,
          sequence: sequence++,
          status: 'sent'
        });
        continue;
      }

      if (type === 'response_item' && (payload.type === 'function_call' || payload.type === 'custom_tool_call')) {
        const callId = typeof payload.call_id === 'string' ? payload.call_id : `${sessionId}-tool-${sequence}`;
        const name = typeof payload.name === 'string' ? payload.name : 'tool';
        const category = categorizeTool(name);
        const activity = {
          callId,
          name,
          turnId: typeof payload.turn_id === 'string' ? payload.turn_id : callId,
          category,
          detail: toolDetail(name, category, payload)
        };
        toolActivities.set(callId, activity);
        upsertToolMessage(messages, {
          id: `${sessionId}-tool-${callId}`,
          turnId: activity.turnId,
          role: 'tool',
          content: toolProgressText(activity, 'running'),
          createdAt: timestamp,
          sequence: sequence++,
          status: 'running'
        });
        continue;
      }

      if (type === 'response_item' && (payload.type === 'function_call_output' || payload.type === 'custom_tool_call_output')) {
        const callId = typeof payload.call_id === 'string' ? payload.call_id : `${sessionId}-tool-${sequence}`;
        const activity = toolActivities.get(callId) ?? {
          callId,
          name: 'tool',
          turnId: callId,
          category: 'generic',
          detail: null
        };
        const output = typeof payload.output === 'string' ? payload.output : '';
        upsertToolMessage(messages, {
          id: `${sessionId}-tool-${callId}`,
          turnId: activity.turnId,
          role: 'tool',
          content: toolProgressText(activity, toolOutputFailed(output) ? 'failed' : 'done'),
          createdAt: timestamp,
          sequence: sequence++,
          status: toolOutputFailed(output) ? 'failed' : 'sent'
        });
        continue;
      }

      if (type === 'event_msg' && payload.type === 'patch_apply_end') {
        const callId = typeof payload.call_id === 'string' ? payload.call_id : `${sessionId}-patch-${sequence}`;
        const activity = toolActivities.get(callId) ?? {
          callId,
          name: 'apply_patch',
          turnId: callId,
          category: 'edit',
          detail: null
        };
        upsertToolMessage(messages, {
          id: `${sessionId}-tool-${callId}`,
          turnId: activity.turnId,
          role: 'tool',
          content: patchSummaryText(payload),
          createdAt: timestamp,
          sequence: sequence++,
          status: payload.success === false ? 'failed' : 'sent'
        });
      }
    }

    return compactToolMessages(messages).slice(-limit);
  }

  private readSessionIndex(): Map<string, SessionIndexEntry> {
    const path = join(this.codexHome, 'session_index.jsonl');
    const entries = new Map<string, SessionIndexEntry>();
    for (const line of readLines(path)) {
      const parsed = parseJsonLine(line) as SessionIndexEntry | null;
      if (parsed?.id) entries.set(parsed.id, parsed);
    }
    return entries;
  }

  private readHistory(): Map<string, { text: string; updatedAt: string }> {
    const path = join(this.codexHome, 'history.jsonl');
    const entries = new Map<string, { text: string; updatedAt: string }>();
    for (const line of readLines(path)) {
      const parsed = parseJsonLine(line) as HistoryEntry | null;
      if (!parsed?.session_id || !parsed.text) continue;
      entries.set(parsed.session_id, {
        text: parsed.text,
        updatedAt: parsed.ts ? new Date(parsed.ts * 1000).toISOString() : new Date(0).toISOString()
      });
    }
    return entries;
  }

  private readActiveOmxSessionIds(): Set<string> {
    const ids = new Set<string>();
    const activePath = join(this.omxHome, 'state', 'session.json');
    const active = parseJsonFile(activePath);
    if (active && isRecord(active)) {
      const id = typeof active.native_session_id === 'string' ? active.native_session_id : typeof active.session_id === 'string' ? active.session_id : '';
      const pid = typeof active.pid === 'number' ? active.pid : undefined;
      if (id && (!pid || processIsRunning(pid))) ids.add(id);
    }

    return ids;
  }

  private readOmxSessionIds(): Set<string> {
    const ids = new Set<string>();
    const stateDir = join(this.omxHome, 'state', 'sessions');
    for (const dir of safeReadDir(stateDir)) {
      if (CODEX_SESSION_ID_RE.test(dir)) ids.add(dir);
    }
    return ids;
  }

  private findSessionFiles(): string[] {
    const root = join(this.codexHome, 'sessions');
    const files: string[] = [];
    walkJsonl(root, files);
    return files
      .map((file) => ({ file, stat: safeStat(file) }))
      .filter((entry): entry is { file: string; stat: NonNullable<ReturnType<typeof safeStat>> } => Boolean(entry.stat?.isFile()))
      .sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs)
      .slice(0, MAX_SESSION_FILES)
      .map((entry) => entry.file);
  }

  private readSessionMeta(file: string): Partial<SessionCandidate> {
    const result: Partial<SessionCandidate> = {};
    for (const line of readFirstLines(file, 80)) {
      const parsed = parseJsonLine(line);
      if (!parsed || !isRecord(parsed)) continue;
      const payload = isRecord(parsed.payload) ? parsed.payload : {};

      if (parsed.type === 'session_meta') {
        if (typeof payload.cwd === 'string') result.cwd = payload.cwd;
        if (typeof payload.timestamp === 'string') result.createdAt = payload.timestamp;
        else if (typeof parsed.timestamp === 'string') result.createdAt = parsed.timestamp;
        if (typeof payload.originator === 'string') result.originator = payload.originator;
        if (typeof payload.source === 'string') result.source = payload.source;
        const baseInstructions = isRecord(payload.base_instructions) && typeof payload.base_instructions.text === 'string'
          ? payload.base_instructions.text
          : '';
        result.omx = /OMX:RUNTIME|oh-my-codex|\bomx\b/i.test(baseInstructions);
        continue;
      }

      if (!result.title && parsed.type === 'event_msg' && payload.type === 'user_message' && typeof payload.message === 'string') {
        result.title = payload.message;
      }
    }
    return result;
  }

  private readTranscriptActivity(file: string, fileMtimeMs: number | undefined): TranscriptActivity {
    if (fileMtimeMs && Date.now() - fileMtimeMs > ACTIVE_TRANSCRIPT_MAX_AGE_MS) {
      return { running: false, updatedAt: null };
    }

    const activeTaskTurns = new Set<string>();
    const activeToolCalls = new Set<string>();
    let sawRunningSignal = false;
    let openAssistantTurn = false;
    let updatedAt: string | null = null;

    for (const line of readLastLines(file, MAX_CHAT_LINES)) {
      const parsed = parseJsonLine(line);
      if (!parsed || !isRecord(parsed)) continue;
      if (typeof parsed.timestamp === 'string') updatedAt = parsed.timestamp;
      const payload = isRecord(parsed.payload) ? parsed.payload : {};

      if (parsed.type === 'event_msg') {
        if (payload.type === 'task_started') {
          const turnId = typeof payload.turn_id === 'string' ? payload.turn_id : 'unknown-task';
          activeTaskTurns.add(turnId);
          sawRunningSignal = true;
          openAssistantTurn = true;
          continue;
        }

        if (payload.type === 'user_message') {
          openAssistantTurn = true;
          continue;
        }

        if (payload.type === 'agent_message' || payload.type === 'task_complete') {
          if (payload.type === 'task_complete') {
            const turnId = typeof payload.turn_id === 'string' ? payload.turn_id : null;
            if (turnId) activeTaskTurns.delete(turnId);
            else activeTaskTurns.clear();
          }
          activeToolCalls.clear();
          openAssistantTurn = false;
          continue;
        }

        if (payload.type === 'turn_aborted' || payload.type === 'error') {
          activeTaskTurns.clear();
          activeToolCalls.clear();
          openAssistantTurn = false;
          continue;
        }
      }

      if (parsed.type === 'response_item') {
        if (payload.type === 'reasoning') {
          sawRunningSignal = true;
          openAssistantTurn = true;
          continue;
        }

        if (payload.type === 'function_call' || payload.type === 'custom_tool_call') {
          const callId = typeof payload.call_id === 'string' ? payload.call_id : null;
          const status = typeof payload.status === 'string' ? payload.status : null;
          if (callId && status !== 'completed') activeToolCalls.add(callId);
          sawRunningSignal = true;
          openAssistantTurn = true;
          continue;
        }

        if (payload.type === 'function_call_output' || payload.type === 'custom_tool_call_output') {
          const callId = typeof payload.call_id === 'string' ? payload.call_id : null;
          if (callId) activeToolCalls.delete(callId);
          if (openAssistantTurn) sawRunningSignal = true;
          continue;
        }

        if (payload.type === 'message') {
          if (payload.role === 'assistant') {
            activeToolCalls.clear();
            openAssistantTurn = false;
          } else if (payload.role === 'user') {
            openAssistantTurn = true;
          }
        }
      }
    }

    const fresh = !fileMtimeMs || Date.now() - fileMtimeMs <= ACTIVE_TRANSCRIPT_MAX_AGE_MS;
    return {
      running: fresh && sawRunningSignal && (activeTaskTurns.size > 0 || activeToolCalls.size > 0 || openAssistantTurn),
      updatedAt
    };
  }

  private readTranscriptUsageContext(file: string): UsageContext | undefined {
    for (const line of readLastLines(file, MAX_CHAT_LINES).reverse()) {
      const parsed = parseJsonLine(line);
      if (!parsed || !isRecord(parsed)) continue;
      const payload = isRecord(parsed.payload) ? parsed.payload : {};
      if (parsed.type !== 'event_msg' || payload.type !== 'token_count') continue;

      const info = isRecord(payload.info) ? payload.info : {};
      const total = tokenUsageFromRecord(info.total_token_usage);
      const last = tokenUsageFromRecord(info.last_token_usage);
      const windowTokens = typeof info.model_context_window === 'number' ? info.model_context_window : null;
      const usedTokens = last?.totalTokens ?? total?.totalTokens ?? null;
      const percent = usedTokens !== null && windowTokens ? Math.round((usedTokens / windowTokens) * 1000) / 10 : null;
      const status = percent === null ? 'unknown' : percent >= 95 ? 'error' : percent >= 80 ? 'warn' : 'ok';
      return {
        usedTokens,
        windowTokens,
        percent,
        status
      };
    }

    return undefined;
  }
}

function appendChatMessage(messages: ChatMessage[], next: ChatMessage): void {
  const previous = messages.at(-1);
  if (
    previous &&
    previous.role === next.role &&
    previous.content === next.content &&
    Math.abs(new Date(previous.createdAt).getTime() - new Date(next.createdAt).getTime()) <= 1000
  ) {
    return;
  }

  messages.push(next);
}

function normalizeTranscriptUserMessage(content: string): string {
  const text = content.trim();
  if (!text) return '';

  const latest = extractLatestDexydUserMessage(text);
  if (latest !== null) return latest;

  const withoutEnvironment = stripEnvironmentContextBlocks(text).trim();
  if (!withoutEnvironment) return '';

  if (isDexydPromptEnvelope(withoutEnvironment)) return '';

  return withoutEnvironment;
}

function extractLatestDexydUserMessage(text: string): string | null {
  if (!isDexydPromptEnvelope(text)) return null;

  const marker = /(?:^|\n)Latest user message:\s*\n/gi;
  let lastEnd = -1;
  let match: RegExpExecArray | null;
  while ((match = marker.exec(text)) !== null) {
    lastEnd = match.index + match[0].length;
  }

  if (lastEnd < 0) return null;
  return stripEnvironmentContextBlocks(text.slice(lastEnd)).trim();
}

function stripEnvironmentContextBlocks(text: string): string {
  return text.replace(/<environment_context>[\s\S]*?<\/environment_context>/gi, '').trim();
}

function isDexydPromptEnvelope(text: string): boolean {
  return (
    /You are running inside dexyd as the assistant for a mobile chat session\./i.test(text) ||
    /<environment_context>[\s\S]*?<\/environment_context>/i.test(text) ||
    /Conversation so far:\s*$/im.test(text) ||
    /(?:^|\n)Latest user message:\s*\n/i.test(text)
  );
}

function chatMessageFromResponseRole(
  role: unknown,
  content: string
): { role: ChatMessage['role']; content: string } | null {
  if (role === 'assistant') {
    return { role: 'assistant', content };
  }

  if (role === 'user') {
    const normalized = normalizeTranscriptUserMessage(content);
    if (!normalized) return null;
    if (isOmxAutomationMessage(normalized)) {
      return { role: 'system', content: summarizeOmxAutomation(normalized) };
    }

    return { role: 'user', content: normalized };
  }

  if (role === 'developer' && isOmxAutomationMessage(content)) {
    return { role: 'system', content: summarizeOmxAutomation(content) };
  }

  return null;
}

function isOmxAutomationMessage(content: string): boolean {
  const text = content.trim();
  if (/^<hook_prompt\b/i.test(text) || /<\/hook_prompt>$/i.test(text)) return true;
  if (/^OMX native UserPromptSubmit\b/i.test(text)) return true;
  if (/^OMX autopilot is still active\b/i.test(text)) return true;
  return false;
}

function summarizeOmxAutomation(content: string): string {
  const text = content
    .replace(/^<hook_prompt\b[^>]*>/i, '')
    .replace(/<\/hook_prompt>$/i, '')
    .trim();

  if (/autopilot is still active/i.test(text)) {
    return 'OMX automation: continuing the active autopilot task.';
  }

  if (/UserPromptSubmit.*workflow keyword/i.test(text)) {
    return 'OMX automation: workflow routing context applied.';
  }

  if (/UserPromptSubmit.*triage/i.test(text)) {
    return 'OMX automation: triage context applied.';
  }

  return `OMX automation: ${text}`;
}

function tokenUsageFromRecord(value: unknown): TokenUsage | null {
  if (!isRecord(value)) return null;
  const totalTokens = numberField(value, 'total_tokens');
  if (totalTokens === null) return null;
  return {
    inputTokens: numberField(value, 'input_tokens') ?? 0,
    cachedInputTokens: numberField(value, 'cached_input_tokens') ?? 0,
    outputTokens: numberField(value, 'output_tokens') ?? 0,
    reasoningOutputTokens: numberField(value, 'reasoning_output_tokens') ?? 0,
    totalTokens
  };
}

function numberField(record: Record<string, unknown>, key: string): number | null {
  return typeof record[key] === 'number' && Number.isFinite(record[key])
    ? record[key]
    : null;
}

function limitStatusFromTelemetry(raw: unknown): UsageStatus['limits'] {
  if (!raw) {
    return {
      status: 'unknown',
      label: 'limits unknown',
      detail: 'Codex did not report rate-limit telemetry.',
      raw: null
    };
  }

  const serialized = JSON.stringify(raw);
  const normalized = serialized.toLowerCase();
  const hasLimitIssue = /\b(exceeded|limited|throttled|reset|remaining\"?\s*:\s*0)\b/i.test(serialized);
  const lowRemaining = lowestRemainingPercent(raw);
  const status =
    hasLimitIssue || lowRemaining === 0
      ? 'error'
      : lowRemaining !== null && lowRemaining <= 15
        ? 'warn'
        : 'ok';

  return {
    status,
    label:
      status === 'error'
        ? 'limit reached'
        : status === 'warn'
          ? 'limit low'
          : lowRemaining !== null || normalized.includes('remaining')
            ? 'limits ok'
            : 'limits reported',
    detail:
      lowRemaining !== null
        ? `${Math.max(0, Math.round(lowRemaining))}% remaining`
        : 'Rate-limit telemetry is available from Codex.',
    raw
  };
}

function lowestRemainingPercent(value: unknown): number | null {
  let lowest: number | null = null;

  const visit = (candidate: unknown): void => {
    if (Array.isArray(candidate)) {
      for (const item of candidate) visit(item);
      return;
    }

    if (!isRecord(candidate)) return;

    const remaining = numberField(candidate, 'remaining');
    const limit = numberField(candidate, 'limit') ?? numberField(candidate, 'max');
    const usedPercent = numberField(candidate, 'used_percent') ?? numberField(candidate, 'usedPercentage');
    const percent =
      numberField(candidate, 'remaining_percent') ??
      numberField(candidate, 'remainingPercentage') ??
      (usedPercent !== null ? Math.max(0, 100 - usedPercent) : null) ??
      (remaining !== null && limit ? (remaining / limit) * 100 : null);

    if (percent !== null) {
      lowest = lowest === null ? percent : Math.min(lowest, percent);
    }

    for (const item of Object.values(candidate)) visit(item);
  };

  visit(value);
  return lowest;
}

function upsertToolMessage(messages: ChatMessage[], next: ChatMessage): void {
  const index = messages.findIndex((message) => message.id === next.id);
  if (index >= 0) {
    const previous = messages[index];
    messages[index] = {
      ...next,
      sequence: previous?.sequence ?? next.sequence
    };
    return;
  }

  appendChatMessage(messages, next);
}

function compactToolMessages(messages: ChatMessage[]): ChatMessage[] {
  const result: ChatMessage[] = [];

  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index];
    if (!message) continue;

    if (message.role !== 'tool') {
      result.push(message);
      continue;
    }

    const nextNonTool = messages.slice(index + 1).find((candidate) => candidate.role !== 'tool');
    if (message.status === 'sent' && nextNonTool?.role === 'assistant') {
      continue;
    }

    const previous = result.at(-1);
    if (message.status === 'sent' && previous?.role === 'tool' && previous.status === 'sent') {
      result.pop();
    }

    result.push(message);
  }

  return result;
}

function categorizeTool(name: string): ToolCategory {
  const normalized = name.toLowerCase();
  if (normalized.includes('apply_patch') || normalized.includes('write') || normalized.includes('edit')) return 'edit';
  if (normalized.includes('update_plan')) return 'plan';
  if (normalized.includes('view_image') || normalized.includes('screenshot')) return 'image';
  if (normalized.includes('web') || normalized.includes('fetch') || normalized.includes('search')) return 'network';
  if (normalized.includes('exec') || normalized.includes('shell') || normalized.includes('command')) return 'command';
  if (normalized.includes('read') || normalized.includes('open') || normalized.includes('find') || normalized.includes('list')) return 'inspect';
  return 'generic';
}

function toolProgressText(activity: ToolActivity, state: 'running' | 'done' | 'failed'): string {
  const verb = toolVerb(activity.category, state);
  const detail = activity.detail ? ` · ${activity.detail}` : '';
  if (state === 'failed') return `${verb}${detail}.`;
  return state === 'running' ? `${verb}${detail}…` : `${verb}${detail}.`;
}

function toolDetail(
  name: string,
  category: ToolCategory,
  payload: Record<string, unknown>
): string | null {
  const args = toolArguments(payload);
  const normalized = name.toLowerCase();

  if (category === 'command') {
    return commandDetail(args) ?? readableToolName(name);
  }

  if (category === 'edit') {
    return pathDetail(args) ?? readableToolName(name);
  }

  if (category === 'plan') {
    const plan = args && Array.isArray(args.plan) ? args.plan : null;
    return plan ? `${plan.length} step${plan.length === 1 ? '' : 's'}` : readableToolName(name);
  }

  if (category === 'network') {
    return queryDetail(args) ?? readableToolName(name);
  }

  if (category === 'inspect' || category === 'image') {
    return pathDetail(args) ?? queryDetail(args) ?? readableToolName(name);
  }

  if (normalized.includes('multi_tool_use')) {
    const uses = args && Array.isArray(args.tool_uses) ? args.tool_uses.length : null;
    return uses ? `${uses} parallel step${uses === 1 ? '' : 's'}` : readableToolName(name);
  }

  return readableToolName(name);
}

function toolArguments(payload: Record<string, unknown>): Record<string, unknown> | null {
  const raw = payload.arguments ?? payload.input;
  if (isRecord(raw)) return raw;
  if (typeof raw !== 'string' || !raw.trim()) return null;
  try {
    const parsed = JSON.parse(raw);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function commandDetail(args: Record<string, unknown> | null): string | null {
  if (!args) return null;
  const cmd = stringField(args, 'cmd') ?? stringField(args, 'command');
  if (!cmd) return null;
  const workdir = stringField(args, 'workdir');
  const safeCommand = truncateDetail(redactSensitiveText(oneLine(cmd)), 120);
  if (!workdir) return safeCommand;
  return `${safeCommand} @ ${truncateDetail(workdir, 44)}`;
}

function pathDetail(args: Record<string, unknown> | null): string | null {
  if (!args) return null;
  const value =
    stringField(args, 'path') ??
    stringField(args, 'file') ??
    stringField(args, 'filename') ??
    stringField(args, 'ref_id') ??
    stringField(args, 'pattern');
  return value ? truncateDetail(oneLine(value), 90) : null;
}

function queryDetail(args: Record<string, unknown> | null): string | null {
  if (!args) return null;
  const value = stringField(args, 'query') ?? stringField(args, 'q') ?? firstSearchQuery(args);
  return value ? truncateDetail(oneLine(value), 90) : null;
}

function firstSearchQuery(args: Record<string, unknown>): string | null {
  for (const key of ['search_query', 'image_query']) {
    const value = args[key];
    if (!Array.isArray(value)) continue;
    const first = value.find(isRecord);
    const query = first ? stringField(first, 'q') : null;
    if (query) return query;
  }
  return null;
}

function stringField(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function oneLine(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function truncateDetail(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  return `${value.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`;
}

function readableToolName(name: string): string | null {
  const clean = name
    .replace(/^functions\./, '')
    .replace(/^web\./, '')
    .replace(/_/g, ' ')
    .trim();
  return clean || null;
}

function redactSensitiveText(value: string): string {
  return value
    .replace(/(authorization:\s*bearer\s+)[^\s'"]+/gi, '$1[redacted]')
    .replace(/(--?(?:token|api-key|password|secret)(?:=|\s+))[^\s'"]+/gi, '$1[redacted]')
    .replace(/((?:TOKEN|API_KEY|PASSWORD|SECRET)=)[^\s'"]+/g, '$1[redacted]');
}

function toolVerb(category: ToolCategory, state: 'running' | 'done' | 'failed'): string {
  if (state === 'failed') {
    switch (category) {
      case 'command': return 'Command failed';
      case 'edit': return 'Edit failed';
      case 'plan': return 'Plan update failed';
      case 'inspect': return 'Inspection failed';
      case 'network': return 'Lookup failed';
      case 'image': return 'Image inspection failed';
      default: return 'Tool step failed';
    }
  }

  if (state === 'done') {
    switch (category) {
      case 'command': return 'Command finished';
      case 'edit': return 'Edited files';
      case 'plan': return 'Updated plan';
      case 'inspect': return 'Checked context';
      case 'network': return 'Checked external context';
      case 'image': return 'Inspected image';
      default: return 'Tool step finished';
    }
  }

  switch (category) {
    case 'command': return 'Running command';
    case 'edit': return 'Editing files';
    case 'plan': return 'Updating plan';
    case 'inspect': return 'Checking context';
    case 'network': return 'Checking external context';
    case 'image': return 'Inspecting image';
    default: return 'Working with a tool';
  }
}

function toolOutputFailed(output: string): boolean {
  return /(?:exit code|process exited with code):?\s*[1-9]\d*/i.test(output) || /\bfailed\b/i.test(output.slice(0, 200));
}

function patchSummaryText(payload: Record<string, unknown>): string {
  if (payload.success === false) return 'Edit failed.';
  const changes = isRecord(payload.changes) ? Object.keys(payload.changes) : [];
  if (!changes.length) return 'Edited files.';
  const visible = changes.slice(0, 3).join(', ');
  const suffix = changes.length > 3 ? ` +${changes.length - 3} more` : '';
  return `Edited ${visible}${suffix}.`;
}

function isNoisyToolText(content: string): boolean {
  const text = content.trim();
  if (!text) return false;
  if (/^Chunk ID:\s*[0-9a-f-]+/i.test(text) && /(?:Exit code|Process exited with code|Output:)/i.test(text)) return true;
  if (/^Exit code:\s*-?\d+/i.test(text) && /Output:/i.test(text)) return true;
  if (/^\{[\s\S]{0,400}"cmd"\s*:/.test(text)) return true;
  return false;
}

function walkJsonl(dir: string, files: string[]): void {
  for (const entry of safeReadDir(dir)) {
    const path = join(dir, entry);
    const stat = safeStat(path);
    if (!stat) continue;
    if (stat.isDirectory()) walkJsonl(path, files);
    else if (stat.isFile() && path.endsWith('.jsonl')) files.push(path);
  }
}

function extractSessionId(file: string): string | null {
  return CODEX_SESSION_ID_RE.exec(basename(file))?.[1] ?? null;
}

function isInsideWorkspace(root: string, candidate: string): boolean {
  try {
    const realRoot = realpathSync(resolve(root));
    const realCandidate = realpathSync(resolve(candidate));
    const relativePath = relative(realRoot, realCandidate);
    return relativePath === '' || (relativePath !== '..' && !relativePath.startsWith(`..${sep}`) && !isAbsolute(relativePath));
  } catch {
    return false;
  }
}

function cleanTitle(value: string | undefined): string {
  return (value || '').replace(/\s+/g, ' ').trim().slice(0, 120);
}

function pad2(value: number): string {
  return String(value).padStart(2, '0');
}

function formatSessionFileTimestamp(value: Date): string {
  return value.toISOString().replace(/[:.]/g, '-');
}

function appendJsonLine(path: string, value: unknown): void {
  appendFileSync(path, `${JSON.stringify(value)}\n`, 'utf8');
}

function extractMessageText(content: unknown): string {
  if (typeof content === 'string') return content.trim();
  if (!Array.isArray(content)) return '';
  return content
    .map((item) => {
      if (!isRecord(item)) return '';
      if (typeof item.text === 'string') return item.text;
      if (typeof item.content === 'string') return item.content;
      return '';
    })
    .filter(Boolean)
    .join('\n')
    .trim();
}

function readLines(path: string): string[] {
  try {
    return readFileSync(path, 'utf8').split('\n').filter(Boolean);
  } catch {
    return [];
  }
}

function readFirstLines(path: string, maxLines: number): string[] {
  return readLines(path).slice(0, maxLines);
}

function readLastLines(path: string, maxLines: number): string[] {
  const lines = readLines(path);
  return lines.slice(Math.max(0, lines.length - maxLines));
}

function parseJsonLine(line: string): unknown | null {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

function parseJsonFile(path: string): unknown | null {
  try {
    if (!existsSync(path)) return null;
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

function safeReadDir(path: string): string[] {
  try {
    return readdirSync(path);
  } catch {
    return [];
  }
}

function safeStat(path: string) {
  try {
    return statSync(path);
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function processIsRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
