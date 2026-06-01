import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
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
};

type ToolActivity = {
  callId: string;
  name: string;
  turnId: string;
  category: ToolCategory;
};

type ToolCategory = 'command' | 'edit' | 'plan' | 'inspect' | 'network' | 'image' | 'generic';

const CODEX_SESSION_ID_RE = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i;
const MAX_SESSION_FILES = 400;
const MAX_CHAT_LINES = 5000;

export class CodexSessionService {
  private readonly codexHome: string;
  private readonly omxHome: string;

  constructor(private readonly workspaceRoot: string, private readonly logger: LoggerLike) {
    this.codexHome = resolve(process.env.CODEX_HOME || join(homedir(), '.codex'));
    this.omxHome = resolve(process.env.OMX_HOME || join(homedir(), '.omx'));
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
        omx: fromFile.omx || omxSessions.has(id) || activeOmx.has(id)
      });
    }

    return [...candidates.values()]
      .filter((candidate) => candidate.cwd)
      .sort((a, b) => Date.parse(b.updatedAt || '') - Date.parse(a.updatedAt || ''))
      .slice(0, limit)
      .map((candidate) => ({
        id: candidate.id,
        status: activeOmx.has(candidate.id) ? 'running' : 'idle',
        profile: candidate.omx ? 'omx' : candidate.originator || candidate.source || 'codex',
        workspacePath: candidate.cwd!,
        createdAt: candidate.createdAt || candidate.updatedAt || new Date(0).toISOString(),
        updatedAt: candidate.updatedAt || candidate.createdAt || new Date(0).toISOString(),
        source: 'codex',
        title: cleanTitle(candidate.title) || basename(candidate.cwd!) || candidate.id,
        codexSessionPath: candidate.path,
        omx: Boolean(candidate.omx)
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
      const status = contextStatus === 'error' || limits.status === 'error'
        ? 'error'
        : contextStatus === 'warn' || limits.status === 'warn'
          ? 'warn'
          : contextStatus === 'unknown' && limits.status === 'unknown'
            ? 'unknown'
            : 'ok';

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
        appendChatMessage(messages, {
          id: `${sessionId}-user-${sequence}`,
          turnId: typeof payload.turn_id === 'string' ? payload.turn_id : `${sessionId}-${sequence}`,
          role: 'user',
          content: payload.message,
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
        const activity = {
          callId,
          name,
          turnId: typeof payload.turn_id === 'string' ? payload.turn_id : callId,
          category: categorizeTool(name)
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
          category: 'generic'
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
          category: 'edit'
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

function chatMessageFromResponseRole(
  role: unknown,
  content: string
): { role: ChatMessage['role']; content: string } | null {
  if (role === 'assistant') {
    return { role: 'assistant', content };
  }

  if (role === 'user') {
    if (isOmxAutomationMessage(content)) {
      return { role: 'system', content: summarizeOmxAutomation(content) };
    }

    return { role: 'user', content };
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
          : normalized.includes('remaining')
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
    const percent =
      numberField(candidate, 'remaining_percent') ??
      numberField(candidate, 'remainingPercentage') ??
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
  if (state === 'failed') return `${verb}.`;
  return state === 'running' ? `${verb}…` : `${verb}.`;
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
