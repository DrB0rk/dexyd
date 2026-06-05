import { lstatSync, mkdirSync, readdirSync, realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

export type ProjectDirectoryEntry = {
  name: string;
  path: string;
  modifiedAt: string;
};

export type ProjectBrowseResult = {
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

export type ProjectSuggestResult = {
  input: string;
  parentPath: string;
  suggestions: ProjectSuggestion[];
};

const MAX_PROJECT_ENTRIES = 250;
const MAX_PROJECT_SUGGESTIONS = 30;

export class ProjectService {
  private readonly homePath: string;
  private readonly realHomePath: string;

  constructor(defaultStartPath: string) {
    this.homePath = resolve(defaultStartPath);
    this.realHomePath = realpathSync(this.homePath);
  }

  browse(requestedPath = ''): ProjectBrowseResult {
    const target = this.resolveExistingDirectory(requestedPath);
    const currentPath = this.displayPath(target);
    const parentPath = this.parentDisplayPath(target);

    const entries = readdirSync(target, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .sort((a, b) => a.name.localeCompare(b.name))
      .slice(0, MAX_PROJECT_ENTRIES)
      .map((entry) => {
        const absolutePath = join(target, entry.name);
        const stat = lstatSync(absolutePath);
        return {
          name: entry.name,
          path: this.displayPath(absolutePath),
          modifiedAt: stat.mtime.toISOString()
        } satisfies ProjectDirectoryEntry;
      });

    return {
      rootPath: this.homePath,
      currentPath,
      absolutePath: target,
      parentPath,
      entries
    };
  }

  suggest(input = ''): ProjectSuggestResult {
    const trimmedInput = input.trim();
    const rootLike = trimmedInput === '' || trimmedInput === '~' || trimmedInput === '~/' || trimmedInput === `~${sep}`;
    const rawEndsInSeparator = trimmedInput.endsWith('/') || trimmedInput.endsWith(sep);
    const normalizedInput = this.normalizeInput(input);
    const parentInput = rootLike || rawEndsInSeparator
      ? normalizedInput
      : dirname(normalizedInput);
    const prefix = rootLike || rawEndsInSeparator
      ? ''
      : basename(normalizedInput).toLowerCase();
    const parent = this.resolveExistingDirectory(parentInput === '.' ? '' : parentInput);

    const suggestions = readdirSync(parent, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && entry.name.toLowerCase().startsWith(prefix))
      .sort((a, b) => a.name.localeCompare(b.name))
      .slice(0, MAX_PROJECT_SUGGESTIONS)
      .map((entry) => {
        const absolutePath = join(parent, entry.name);
        return {
          name: entry.name,
          path: this.displayPath(absolutePath),
          absolutePath
        } satisfies ProjectSuggestion;
      });

    return {
      input,
      parentPath: this.displayPath(parent),
      suggestions
    };
  }

  create(input: { parentPath: string; name: string }): { path: string; absolutePath: string; name: string } {
    const parent = this.resolveExistingDirectory(input.parentPath);
    const name = input.name.trim();
    if (!name || name.includes('\0') || name.includes('/') || name.includes(sep) || name === '.' || name === '..') {
      throw new Error('invalid_project_name');
    }
    const absolutePath = resolve(parent, name);
    mkdirSync(absolutePath, { recursive: false });
    const realCreated = realpathSync(absolutePath);
    return {
      path: this.displayPath(realCreated),
      absolutePath: realCreated,
      name: basename(realCreated)
    };
  }

  resolveWorkspace(requestedPath = ''): string {
    return this.resolveExistingDirectory(requestedPath);
  }

  private resolveExistingDirectory(requestedPath: string): string {
    const absolutePath = this.absoluteFromInput(requestedPath);
    const stat = lstatSync(absolutePath);
    if (!stat.isDirectory()) throw new Error('project_path_not_directory');
    const realTarget = realpathSync(absolutePath);
    return realTarget;
  }

  private absoluteFromInput(input: string): string {
    const normalized = this.normalizeInput(input);
    const absolutePath = isAbsolute(normalized)
      ? resolve(normalized)
      : resolve(this.realHomePath, normalized || '.');
    if (absolutePath.includes('\0')) throw new Error('invalid_project_path');
    return absolutePath;
  }

  private normalizeInput(input: string): string {
    if (input.includes('\0')) throw new Error('invalid_project_path');
    const trimmed = input.trim();
    if (!trimmed || trimmed === '~') return this.realHomePath;
    if (trimmed.startsWith(`~${sep}`) || trimmed.startsWith('~/')) {
      return resolve(this.realHomePath, trimmed.slice(2));
    }
    return trimmed;
  }

  private displayPath(path: string): string {
    const absolutePath = resolve(path);
    const relativePath = relative(this.realHomePath, absolutePath);
    if (!isOutside(relativePath)) {
      return relativePath ? `~/${relativePath.split(sep).join('/')}` : '~';
    }
    return absolutePath;
  }

  private parentDisplayPath(path: string): string | null {
    const parent = resolve(path, '..');
    if (parent === path) return null;
    return this.displayPath(parent);
  }
}

function isOutside(relativePath: string): boolean {
  return relativePath === '..' || relativePath.startsWith(`..${sep}`) || resolve(relativePath) === relativePath;
}
