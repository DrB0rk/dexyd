import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve, sep } from 'node:path';

export type SlashCommand = {
  id: string;
  name: string;
  command: string;
  insertText: string;
  description: string;
  category: 'codex' | 'omx' | 'skill' | 'prompt';
  source: string;
};

const MAX_COMMANDS = 160;
const MAX_SCAN_FILES = 600;
const MAX_FRONTMATTER_BYTES = 16_384;
const COMMAND_CACHE_TTL_MS = 30_000;

const BUILTIN_COMMANDS: SlashCommand[] = [
  {
    id: 'codex-help',
    name: 'help',
    command: '/help',
    insertText: '/help',
    description: 'Ask Codex for command help in the current session.',
    category: 'codex',
    source: 'codex',
  },
  {
    id: 'codex-status',
    name: 'status',
    command: '/status',
    insertText: '/status',
    description: 'Show current session status and configuration.',
    category: 'codex',
    source: 'codex',
  },
  {
    id: 'codex-diff',
    name: 'diff',
    command: '/diff',
    insertText: '/diff',
    description: 'Ask for a summary of current workspace changes.',
    category: 'codex',
    source: 'codex',
  },
  {
    id: 'codex-compact',
    name: 'compact',
    command: '/compact',
    insertText: '/compact',
    description: 'Ask Codex to compact/summarize the active context.',
    category: 'codex',
    source: 'codex',
  },
  {
    id: 'codex-clear',
    name: 'clear',
    command: '/clear',
    insertText: '/clear',
    description:
      'Ask Codex to clear/reset visible conversation context when supported.',
    category: 'codex',
    source: 'codex',
  },
];

export class CommandService {
  private readonly codexHome: string;
  private cachedCommands: {
    expiresAt: number;
    commands: SlashCommand[];
  } | null = null;

  constructor(codexHome = process.env.CODEX_HOME || join(homedir(), '.codex')) {
    this.codexHome = resolve(codexHome);
  }

  listCommands(): SlashCommand[] {
    if (this.cachedCommands && this.cachedCommands.expiresAt > Date.now()) {
      return this.cachedCommands.commands;
    }

    const commands = new Map<string, SlashCommand>();
    for (const command of BUILTIN_COMMANDS) {
      commands.set(command.id, command);
    }

    for (const command of this.discoverSkillCommands()) {
      const id = uniqueCommandId(commands, command);
      commands.set(id, { ...command, id });
      if (commands.size >= MAX_COMMANDS) break;
    }

    for (const command of this.discoverPromptCommands()) {
      const id = uniqueCommandId(commands, command);
      commands.set(id, { ...command, id });
      if (commands.size >= MAX_COMMANDS) break;
    }

    const next = [...commands.values()]
      .sort(compareCommands)
      .slice(0, MAX_COMMANDS);
    this.cachedCommands = {
      expiresAt: Date.now() + COMMAND_CACHE_TTL_MS,
      commands: next,
    };
    return next;
  }

  private discoverSkillCommands(): SlashCommand[] {
    const skillFiles = [
      ...findFiles(join(this.codexHome, 'skills'), 'SKILL.md'),
      ...findFiles(join(this.codexHome, 'plugins', 'cache'), 'SKILL.md'),
    ];

    return skillFiles
      .map((file) => skillCommandFromFile(file, this.codexHome))
      .filter((command): command is SlashCommand => Boolean(command));
  }

  private discoverPromptCommands(): SlashCommand[] {
    const roots = [
      join(this.codexHome, 'prompts'),
      join(this.codexHome, 'rules'),
    ];
    const files = roots.flatMap((root) => findMarkdownFiles(root));
    return files
      .map((file) => promptCommandFromFile(file, this.codexHome))
      .filter((command): command is SlashCommand => Boolean(command));
  }
}

function skillCommandFromFile(
  file: string,
  codexHome: string
): SlashCommand | null {
  const content = safeReadHead(file);
  const metadata = parseFrontmatter(content);
  const directoryName = basename(dirname(file));
  const rawName = metadata.name || directoryName;
  const name = cleanCommandName(rawName.replace(/^.*:/, ''));
  if (!name) return null;

  const source = skillSource(file, codexHome);
  const omx = /oh-my-codex|OMX|\[OMX\]/i.test(`${file}\n${content}`);
  const command = `/${name}`;
  return {
    id: `${omx ? 'omx' : 'skill'}-${source}-${name}`,
    name,
    command,
    insertText: omx ? `$${name} ` : `Use the ${name} skill: `,
    description:
      cleanDescription(metadata.description) ||
      `${omx ? 'OMX workflow' : 'Codex skill'}: ${name}`,
    category: omx ? 'omx' : 'skill',
    source,
  };
}

function promptCommandFromFile(
  file: string,
  codexHome: string
): SlashCommand | null {
  const name = cleanCommandName(basename(file).replace(/\.(md|txt)$/i, ''));
  if (!name) return null;
  return {
    id: `prompt-${relativeSource(file, codexHome)}-${name}`,
    name,
    command: `/${name}`,
    insertText: `/${name} `,
    description: `Prompt command from ${relativeSource(file, codexHome)}`,
    category: 'prompt',
    source: 'codex prompts',
  };
}

function findFiles(root: string, fileName: string): string[] {
  const result: string[] = [];
  const stack = [root];
  let scanned = 0;
  while (stack.length && scanned < MAX_SCAN_FILES) {
    const current = stack.pop();
    if (!current || !existsSync(current)) continue;
    let entries: string[];
    try {
      entries = readdirSync(current);
    } catch {
      continue;
    }

    for (const entry of entries) {
      if (scanned >= MAX_SCAN_FILES) break;
      const path = join(current, entry);
      let stat: ReturnType<typeof statSync>;
      try {
        stat = statSync(path);
      } catch {
        continue;
      }
      scanned += 1;
      if (stat.isDirectory()) {
        if (entry === '.git' || entry === 'node_modules') continue;
        stack.push(path);
      } else if (entry === fileName) {
        result.push(path);
      }
    }
  }
  return result;
}

function findMarkdownFiles(root: string): string[] {
  if (!existsSync(root)) return [];
  try {
    return readdirSync(root)
      .map((entry) => join(root, entry))
      .filter((file) => statSync(file).isFile() && /\.(md|txt)$/i.test(file));
  } catch {
    return [];
  }
}

function safeReadHead(file: string): string {
  try {
    return readFileSync(file, 'utf8').slice(0, MAX_FRONTMATTER_BYTES);
  } catch {
    return '';
  }
}

function parseFrontmatter(content: string): {
  name?: string;
  description?: string;
} {
  if (!content.startsWith('---')) return {};
  const end = content.indexOf('\n---', 3);
  if (end < 0) return {};
  const block = content.slice(3, end);
  const result: { name?: string; description?: string } = {};
  for (const line of block.split(/\r?\n/)) {
    const match = /^(name|description):\s*(.*)$/i.exec(line.trim());
    if (!match) continue;
    const key = match[1]?.toLowerCase();
    const value = stripYamlString(match[2] ?? '');
    if (key === 'name') result.name = value;
    if (key === 'description') result.description = value;
  }
  return result;
}

function stripYamlString(value: string): string {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function cleanCommandName(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
}

function cleanDescription(value: string | undefined): string {
  return (value ?? '').replace(/\s+/g, ' ').trim().slice(0, 220);
}

function skillSource(file: string, codexHome: string): string {
  const normalized = file.split(sep).join('/');
  const pluginMatch = /\/plugins\/cache\/([^/]+)\//.exec(normalized);
  if (pluginMatch?.[1]) return pluginMatch[1];
  if (normalized.includes('/skills/.system/')) return 'codex system';
  return relativeSource(file, codexHome);
}

function relativeSource(file: string, codexHome: string): string {
  return file.startsWith(codexHome) ? file.slice(codexHome.length + 1) : file;
}

function uniqueCommandId(
  commands: Map<string, SlashCommand>,
  command: SlashCommand
): string {
  if (!commands.has(command.id)) return command.id;
  let index = 2;
  while (commands.has(`${command.id}-${index}`)) index += 1;
  return `${command.id}-${index}`;
}

function compareCommands(a: SlashCommand, b: SlashCommand): number {
  const categoryRank = (command: SlashCommand) => {
    if (command.category === 'codex') return 0;
    if (command.category === 'omx') return 1;
    if (command.category === 'skill') return 2;
    return 3;
  };
  const rank = categoryRank(a) - categoryRank(b);
  if (rank !== 0) return rank;
  return a.name.localeCompare(b.name);
}
