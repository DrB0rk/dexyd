import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config/load-config.js';

const pathsToCleanup: string[] = [];

afterEach(() => {
  for (const path of pathsToCleanup.splice(0, pathsToCleanup.length)) {
    rmSync(path, { recursive: true, force: true });
  }
});

describe('loadConfig', () => {
  it('returns defaults when no config path is set', () => {
    const config = loadConfig({});
    expect(config.server.port).toBe(4242);
  });

  it('loads yaml and applies schema', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dexyd-config-'));
    pathsToCleanup.push(dir);

    const configPath = join(dir, 'dexyd.yaml');
    writeFileSync(
      configPath,
      `server:\n  port: 5555\nstorage:\n  sqlitePath: ${join(dir, 'dexyd.db')}\n`
    );

    const config = loadConfig({ configPath });
    expect(config.server.port).toBe(5555);
    expect(config.storage.sqlitePath).toContain('dexyd.db');
  });
});
