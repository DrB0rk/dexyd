
export type BridgeHealthResponse = {
  status: string;
  version?: string;
  timestamp?: string;
  bridge?: {
    host: string;
    port: number;
    publicBaseUrl: string | null;
    advertisedBaseUrl: string;
  };
  cloudflare?: {
    hostname: string | null;
    tunnelName: string;
    publicUrl: string | null;
    configured: boolean;
  };
  assistant?: {
    codexHarnessMode: 'direct' | 'omx' | 'custom';
    opencodeEnabled: boolean;
    opencodeStatus: string;
  };
};

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

export type OpenCodeAgent = {
  name: string;
  description?: string;
  mode?: 'primary' | 'subagent' | 'all';
  model?: { providerID?: string; modelID?: string } | null;
};

export type OpenCodeSkill = {
  name: string;
  description?: string;
  location?: string;
};

export type OpenCodeTool = {
  id: string;
  description?: string;
  category?: string;
};

export type OpenCodeCommand = {
  name: string;
  description?: string;
  template?: string;
  agent?: string;
};

export type OpenCodeProvider = {
  id: string;
  name?: string;
  source?: string;
};

export type OpenCodeModel = {
  id: string;
  name?: string;
  providerID?: string;
  family?: string;
};

export type OpenCodePendingPermission = {
  sessionId: string;
  requestID: string;
  tool: string | null;
  message: string;
  patterns: string[];
  metadata: Record<string, unknown>;
  receivedAt: number;
};

export type OpenCodePendingQuestion = {
  sessionId: string;
  requestID: string;
  questions: Array<{ question: string; header?: string; options: Array<{ label: string; description?: string }> }>;
  receivedAt: number;
};

export type OpenCodeStatus = {
  enabled: boolean;
  status: 'disabled' | 'starting' | 'ready' | 'degraded' | 'failed' | 'stopped';
  error: string | null;
  version: string | null;
  handle: {
    baseUrl: string;
    host: string;
    port: number;
    pid: number | null;
    startedAt: string;
  } | null;
  checkedAt: string;
  installHint: string | null;
  defaultAgent: string;
  defaultModel: string;
  pendingTools: number;
  pendingPermissions: number;
  pendingQuestions: number;
};

export type OpenCodeStatusResponse = {
  opencode: OpenCodeStatus;
};

export type OpenCodeAgentsResponse = {
  agents: OpenCodeAgent[];
  updatedAt: string;
};

export type OpenCodeSkillsResponse = {
  skills: OpenCodeSkill[];
  updatedAt: string;
};

export type OpenCodeToolsResponse = {
  tools: OpenCodeTool[];
  updatedAt: string;
};

export type OpenCodeCommandsResponse = {
  commands: OpenCodeCommand[];
  updatedAt: string;
};

export type OpenCodeProvidersResponse = {
  providers: OpenCodeProvider[];
  updatedAt: string;
};

export type OpenCodeModelsResponse = {
  models: OpenCodeModel[];
  provider: string | null;
  updatedAt: string;
};

export type OpenCodeCreateSessionInput = {
  workspacePath: string;
  title?: string;
  agent?: string;
  modelProviderID?: string;
  modelID?: string;
};

export type OpenCodeCreateSessionResponse = {
  session: {
    id: string;
    status: string;
    workspacePath: string;
    createdAt: string;
    updatedAt: string;
    source: 'opencode';
    title?: string;
    model?: string | null;
    agent?: string | null;
    tokenUsage?: { input: number | null; output: number | null; total: number | null } | null;
  };
};

export type OpenCodePermissionReplyInput = {
  decision: 'allow' | 'deny' | 'always';
};

export type OpenCodeQuestionReplyInput = {
  answers: Array<string | { label: string }>;
};
