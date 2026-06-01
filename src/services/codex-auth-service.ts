import { execFileSync } from 'node:child_process';

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

const DEFAULT_INSTALL_HINT = 'Install codex-auth on the bridge host, for example: npm install -g codex-auth';
const MAX_ACCOUNT_QUERY_LENGTH = 120;

export class CodexAuthService {
  constructor(private readonly command = process.env.CODEX_AUTH_PATH || 'codex-auth') {}

  getStatus(): CodexAuthStatus {
    const installed = this.installedVersion();
    if (!installed.installed) {
      return {
        installed: false,
        version: null,
        autoSwitch: 'unknown',
        service: 'unknown',
        usageApi: 'unknown',
        accountApi: 'unknown',
        installHint: DEFAULT_INSTALL_HINT,
        accounts: [],
        activeAccount: null,
        error: installed.error
      };
    }

    const statusText = this.safeRun(['status']);
    const listText = this.safeRun(['list']);
    const accounts = parseAccountList(listText.output);
    const fields = parseStatus(statusText.output);
    const error = [statusText.error, listText.error].filter(Boolean).join(' · ') || null;

    return {
      installed: true,
      version: installed.version,
      autoSwitch: fields.autoSwitch,
      service: fields.service,
      usageApi: fields.usageApi,
      accountApi: fields.accountApi,
      installHint: null,
      accounts,
      activeAccount: accounts.find((account) => account.active) ?? null,
      error
    };
  }

  switchAccount(query: string): CodexAuthStatus {
    const trimmed = query.trim();
    if (!trimmed || trimmed.length > MAX_ACCOUNT_QUERY_LENGTH || trimmed.includes('\0')) {
      throw new Error('invalid_account_query');
    }

    const installed = this.installedVersion();
    if (!installed.installed) {
      throw new Error('codex_auth_not_installed');
    }

    const candidates = this.switchCandidates(trimmed);
    let lastError: unknown = null;
    for (const candidate of candidates) {
      try {
        execFileSync(this.command, ['switch', candidate], {
          encoding: 'utf8',
          timeout: 15_000,
          stdio: ['ignore', 'pipe', 'pipe']
        });
        return this.getStatus();
      } catch (error) {
        lastError = error;
      }
    }

    throw lastError instanceof Error ? lastError : new Error('codex_auth_switch_failed');
  }

  private switchCandidates(query: string): string[] {
    const status = this.getStatus();
    const candidates = new Set<string>([query]);
    const numeric = query.replace(/^0+(?=\d)/, '');
    if (numeric) candidates.add(numeric);
    for (const account of status.accounts) {
      if (account.index === query || account.index.replace(/^0+(?=\d)/, '') === numeric || account.label === query) {
        candidates.add(account.label);
      }
    }
    return [...candidates];
  }

  private installedVersion(): { installed: true; version: string | null } | { installed: false; error: string } {
    const result = this.safeRun(['--version']);
    if (result.error) {
      return { installed: false, error: result.error };
    }
    return { installed: true, version: result.output.trim() || null };
  }

  private safeRun(args: string[]): { output: string; error: string | null } {
    try {
      return {
        output: execFileSync(this.command, args, {
          encoding: 'utf8',
          timeout: 10_000,
          stdio: ['ignore', 'pipe', 'pipe']
        }),
        error: null
      };
    } catch (error) {
      return {
        output: '',
        error: error instanceof Error ? error.message : 'codex_auth_command_failed'
      };
    }
  }
}

function parseStatus(output: string): Pick<CodexAuthStatus, 'autoSwitch' | 'service' | 'usageApi' | 'accountApi'> {
  const fields: Record<string, string> = {};
  for (const line of output.split('\n')) {
    const [rawKey, ...rest] = line.split(':');
    if (!rawKey || rest.length === 0) continue;
    fields[rawKey.trim().toLowerCase()] = rest.join(':').trim();
  }

  return {
    autoSwitch: fields['auto-switch'] || 'unknown',
    service: fields.service || 'unknown',
    usageApi: fields.usage || 'unknown',
    accountApi: fields.account || 'unknown'
  };
}

function parseAccountList(output: string): CodexAuthAccount[] {
  return output
    .split('\n')
    .map((line) => parseAccountLine(line))
    .filter((account): account is CodexAuthAccount => Boolean(account));
}

function parseAccountLine(line: string): CodexAuthAccount | null {
  if (!line.trim() || line.includes('ACCOUNT') || /^-+$/.test(line.trim())) return null;

  const match = line.match(/^\s*(\*)?\s*(\d+)\s+(\S+)\s+(\S+)\s+(.+?)\s{2,}(.+?)\s{2,}(.+?)\s*$/);
  if (!match) return null;

  const [, activeMarker, index, label, plan, usage5h, usageWeekly, lastActivity] = match;
  if (!index || !label || !plan || !usage5h || !usageWeekly || !lastActivity) return null;

  return {
    active: Boolean(activeMarker),
    index,
    label,
    plan,
    usage5h: usage5h.trim(),
    usageWeekly: usageWeekly.trim(),
    lastActivity: lastActivity.trim()
  };
}
