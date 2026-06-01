import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { DiffSummary } from '../domain/diff.js';
import { SessionRecord } from '../domain/session.js';

const execFileAsync = promisify(execFile);
const MAX_DIFF_BYTES = 256 * 1024;

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
