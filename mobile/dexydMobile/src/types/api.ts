export type PairingStartResponse = {
  pairingId: string;
  expiresAt: string;
  pairingUri: string;
  payload: {
    version: 1;
    bridgeBaseUrl: string;
    pairingId: string;
    challenge: string;
    expiresAt: string;
  };
  qrCodeDataUrl: string;
};

export type PairingCompleteResponse = {
  deviceId: string;
  accessToken: string;
  refreshToken: string;
  accessExpiresAt: string;
  refreshExpiresAt: string;
};

export type DeviceRecord = {
  id: string;
  label: string;
  trustState: string;
  createdAt: string;
  lastSeenAt: string | null;
};

export type ProjectDirectoryEntry = {
  name: string;
  path: string;
  modifiedAt: string;
};

export type ProjectBrowseResponse = {
  rootPath: string;
  currentPath: string;
  absolutePath: string;
  parentPath: string | null;
  entries: ProjectDirectoryEntry[];
};

export type ProjectSuggestion = {
  name: string;
  path: string;
  absolutePath: string;
};

export type ProjectSuggestResponse = {
  input: string;
  parentPath: string;
  suggestions: ProjectSuggestion[];
};

export type FileEntry = {
  name: string;
  path: string;
  type: 'file' | 'directory' | 'other';
  size: number;
  modifiedAt: string;
};

export type FileListResponse = {
  path: string;
  entries: FileEntry[];
};

export type FileReadResponse = {
  path: string;
  content: string;
  size: number;
  truncated: boolean;
};

export type DiffSummary = {
  status: string;
  stat: string;
  diff: string;
  truncated: boolean;
};

export type TokenUsage = {
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  reasoningOutputTokens: number;
  totalTokens: number;
};

export type UsageLimit = {
  kind: 'fiveHour' | 'monthly' | 'other' | 'aggregate';
  status: 'ok' | 'warn' | 'error' | 'unknown';
  label: string;
  detail: string;
  remainingPercent: number | null;
  raw: unknown;
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
  accountLimits?: {
    fiveHour: UsageLimit;
    monthly: UsageLimit;
    other: UsageLimit[];
  };
  limits: UsageLimit;
};

export type CodexAuthAccount = {
  index: string;
  label: string;
  plan: string;
  usage5h: string;
  usageWeekly: string;
  lastActivity: string;
  active: boolean;
};

export type CodexAuthStatus = {
  installed: boolean;
  version: string | null;
  autoSwitch: string;
  service: string;
  usageApi: string;
  accountApi: string;
  installHint: string | null;
  accounts: CodexAuthAccount[];
  activeAccount: CodexAuthAccount | null;
  error: string | null;
};

export type SlashCommand = {
  id: string;
  name: string;
  command: string;
  insertText: string;
  description: string;
  category: 'codex' | 'omx' | 'skill' | 'prompt';
  source: string;
};

export type CommandsResponse = {
  commands: SlashCommand[];
  sessionId: string | null;
  updatedAt: string;
};
