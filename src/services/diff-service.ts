import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, sep } from 'node:path';
import { promisify } from 'node:util';
import { DiffSummary } from '../domain/diff.js';
import { SessionRecord } from '../domain/session.js';

const execFileAsync = promisify(execFile);
const MAX_DIFF_BYTES = 256 * 1024;
const MAX_SNAPSHOT_BYTES = 12 * 1024 * 1024;
const MAX_SNAPSHOT_FILES = 2500;
const MAX_SNAPSHOT_FILE_BYTES = 768 * 1024;
const EXCLUDED_NAMES = new Set([
  '.git',
  '.hg',
  '.svn',
  '.dexyd',
  '.omx',
  '.codex',
  'node_modules',
  'dist',
  'build',
  '.gradle',
  '.idea',
  '.vscode',
  '.next',
  '.turbo',
  '.cache',
  'coverage',
  'tmp',
  'temp'
]);

export type WorkspaceSnapshot = {
  root: string;
  capturedAt: string;
  files: Map<string, SnapshotFile>;
  truncated: boolean;
  skippedFiles: number;
  capturedBytes: number;
};

type SnapshotFile = {
  path: string;
  content: Buffer;
  hash: string;
  size: number;
};

type ChangedFile = {
  path: string;
  type: 'A' | 'M' | 'D';
  before?: SnapshotFile;
  after?: SnapshotFile;
};

export class DiffService {
  async summarize(session: SessionRecord): Promise<DiffSummary> {
    const [status, stat, rawDiff] = await Promise.all([
      git(session.workspacePath, ['status', '--short']),
      git(session.workspacePath, ['diff', '--no-ext-diff', '--stat']),
      git(session.workspacePath, ['diff', '--no-ext-diff'])
    ]);

    const diff = rawDiff.length > MAX_DIFF_BYTES ? rawDiff.slice(0, MAX_DIFF_BYTES) : rawDiff;
    return {
      status: status.trim(),
      stat: stat.trim(),
      diff: diff.trim(),
      truncated: rawDiff.length > MAX_DIFF_BYTES
    };
  }

  async createSnapshot(session: SessionRecord): Promise<WorkspaceSnapshot> {
    return snapshotWorkspace(session.workspacePath);
  }

  async summarizeChangesSince(session: SessionRecord, before: WorkspaceSnapshot): Promise<DiffSummary> {
    const after = snapshotWorkspace(session.workspacePath);
    const changed = changedFiles(before, after);
    const status = changed.map((file) => `${file.type} ${file.path}`).join('\n');

    if (!changed.length) {
      return {
        status,
        stat: '',
        diff: '',
        truncated: before.truncated || after.truncated
      };
    }

    const tempRoot = mkdtempSync(join(tmpdir(), 'dexyd-turn-diff-'));
    const beforeDir = join(tempRoot, 'before');
    const afterDir = join(tempRoot, 'after');
    mkdirSync(beforeDir, { recursive: true });
    mkdirSync(afterDir, { recursive: true });

    try {
      for (const file of changed) {
        if (file.before) writeSnapshotFile(beforeDir, file.path, file.before.content);
        if (file.after) writeSnapshotFile(afterDir, file.path, file.after.content);
      }

      const [rawStat, rawDiff] = await Promise.all([
        gitNoIndex(['diff', '--no-index', '--stat', beforeDir, afterDir]),
        gitNoIndex(['diff', '--no-index', beforeDir, afterDir])
      ]);
      const rewrittenStat = rewriteNoIndexPaths(rawStat, beforeDir, afterDir);
      const rewrittenDiff = rewriteNoIndexPaths(rawDiff, beforeDir, afterDir);
      const diff = rewrittenDiff.length > MAX_DIFF_BYTES ? rewrittenDiff.slice(0, MAX_DIFF_BYTES) : rewrittenDiff;

      return {
        status,
        stat: rewrittenStat.trim(),
        diff: diff.trim(),
        truncated: before.truncated || after.truncated || rewrittenDiff.length > MAX_DIFF_BYTES
      };
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  }
}

function snapshotWorkspace(root: string): WorkspaceSnapshot {
  const files = new Map<string, SnapshotFile>();
  const snapshot: WorkspaceSnapshot = {
    root,
    capturedAt: new Date().toISOString(),
    files,
    truncated: false,
    skippedFiles: 0,
    capturedBytes: 0
  };

  walkSnapshot(root, root, snapshot);
  return snapshot;
}

function walkSnapshot(root: string, directory: string, snapshot: WorkspaceSnapshot): void {
  let entries: string[];
  try {
    entries = readdirSync(directory).sort((left, right) => left.localeCompare(right));
  } catch {
    snapshot.skippedFiles += 1;
    snapshot.truncated = true;
    return;
  }

  for (const name of entries) {
    if (EXCLUDED_NAMES.has(name)) continue;

    const absolutePath = join(directory, name);
    let stat;
    try {
      stat = lstatSync(absolutePath);
    } catch {
      snapshot.skippedFiles += 1;
      snapshot.truncated = true;
      continue;
    }

    if (stat.isSymbolicLink()) continue;
    if (stat.isDirectory()) {
      walkSnapshot(root, absolutePath, snapshot);
      continue;
    }
    if (!stat.isFile()) continue;

    if (
      stat.size > MAX_SNAPSHOT_FILE_BYTES ||
      snapshot.files.size >= MAX_SNAPSHOT_FILES ||
      snapshot.capturedBytes + stat.size > MAX_SNAPSHOT_BYTES
    ) {
      snapshot.skippedFiles += 1;
      snapshot.truncated = true;
      continue;
    }

    try {
      const content = readFileSync(absolutePath);
      const relativePath = normalizeRelativePath(relative(root, absolutePath));
      snapshot.files.set(relativePath, {
        path: relativePath,
        content,
        hash: createHash('sha256').update(content).digest('hex'),
        size: content.byteLength
      });
      snapshot.capturedBytes += content.byteLength;
    } catch {
      snapshot.skippedFiles += 1;
      snapshot.truncated = true;
    }
  }
}

function changedFiles(before: WorkspaceSnapshot, after: WorkspaceSnapshot): ChangedFile[] {
  const paths = new Set([...before.files.keys(), ...after.files.keys()]);
  return [...paths]
    .sort((left, right) => left.localeCompare(right))
    .flatMap((path): ChangedFile[] => {
      const beforeFile = before.files.get(path);
      const afterFile = after.files.get(path);
      if (!beforeFile && afterFile) return [{ path, type: 'A', after: afterFile }];
      if (beforeFile && !afterFile) return [{ path, type: 'D', before: beforeFile }];
      if (beforeFile && afterFile && beforeFile.hash !== afterFile.hash) {
        return [{ path, type: 'M', before: beforeFile, after: afterFile }];
      }
      return [];
    });
}

function writeSnapshotFile(root: string, relativePath: string, content: Buffer): void {
  const destination = join(root, relativePath);
  mkdirSync(dirname(destination), { recursive: true });
  writeFileSync(destination, content);
}

function rewriteNoIndexPaths(input: string, beforeDir: string, afterDir: string): string {
  return input
    .split(beforeDir + sep)
    .join('a/')
    .split(afterDir + sep)
    .join('b/')
    .split(beforeDir)
    .join('a')
    .split(afterDir)
    .join('b');
}

function normalizeRelativePath(path: string): string {
  return path.split(sep).join('/');
}

async function git(cwd: string, args: string[]): Promise<string> {
  try {
    const result = await execFileAsync('git', ['-C', cwd, ...args], {
      timeout: 5000,
      maxBuffer: MAX_DIFF_BYTES * 2,
      windowsHide: true
    });
    return result.stdout;
  } catch (error) {
    if (typeof error === 'object' && error && 'stdout' in error && typeof error.stdout === 'string') {
      return error.stdout;
    }
    return '';
  }
}

async function gitNoIndex(args: string[]): Promise<string> {
  try {
    const result = await execFileAsync('git', args, {
      timeout: 5000,
      maxBuffer: MAX_DIFF_BYTES * 2,
      windowsHide: true
    });
    return result.stdout;
  } catch (error) {
    if (typeof error === 'object' && error && 'stdout' in error && typeof error.stdout === 'string') {
      return error.stdout;
    }
    return '';
  }
}
