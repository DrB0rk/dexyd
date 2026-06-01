import { closeSync, lstatSync, openSync, readdirSync, readSync } from 'node:fs';
import { join } from 'node:path';
import { FileEntry } from '../domain/file.js';
import { SessionRecord } from '../domain/session.js';
import { assertRealPathInside, resolveWorkspacePath } from './workspace-paths.js';

const MAX_ENTRIES = 250;

export class FileService {
  listDirectory(session: SessionRecord, requestedPath = ''): { path: string; entries: FileEntry[] } {
    const target = resolveWorkspacePath(session.workspacePath, requestedPath);
    assertRealPathInside(target.rootPath, target.absolutePath);

    const stat = lstatSync(target.absolutePath);
    if (!stat.isDirectory()) {
      throw new Error('not_a_directory');
    }

    const entries = readdirSync(target.absolutePath, { withFileTypes: true })
      .sort((a, b) => a.name.localeCompare(b.name))
      .slice(0, MAX_ENTRIES)
      .map((entry) => {
        const absolutePath = join(target.absolutePath, entry.name);
        const entryStat = lstatSync(absolutePath);
        return {
          name: entry.name,
          path: target.relativePath ? `${target.relativePath}/${entry.name}` : entry.name,
          type: entry.isDirectory() ? 'directory' : entry.isFile() ? 'file' : 'other',
          size: entryStat.size,
          modifiedAt: entryStat.mtime.toISOString()
        } satisfies FileEntry;
      })
      .sort((a, b) => {
        if (a.type !== b.type) return a.type === 'directory' ? -1 : 1;
        return a.name.localeCompare(b.name);
      });

    return { path: target.relativePath, entries };
  }

  readFile(session: SessionRecord, requestedPath: string, maxBytes: number): { path: string; content: string; size: number; truncated: boolean } {
    const target = resolveWorkspacePath(session.workspacePath, requestedPath);
    assertRealPathInside(target.rootPath, target.absolutePath);

    const stat = lstatSync(target.absolutePath);
    if (!stat.isFile()) {
      throw new Error('not_a_file');
    }

    const bytesToRead = Math.min(stat.size, maxBytes);
    const buffer = Buffer.alloc(bytesToRead);
    const fd = openSync(target.absolutePath, 'r');
    try {
      readSync(fd, buffer, 0, bytesToRead, 0);
    } finally {
      closeSync(fd);
    }

    return {
      path: target.relativePath,
      content: buffer.toString('utf8'),
      size: stat.size,
      truncated: stat.size > maxBytes
    };
  }
}
