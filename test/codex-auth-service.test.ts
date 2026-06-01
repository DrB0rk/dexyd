import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { CodexAuthService } from '../src/services/codex-auth-service.js';

const cleanupPaths: string[] = [];

afterEach(() => {
  for (const path of cleanupPaths.splice(0, cleanupPaths.length)) {
    rmSync(path, { recursive: true, force: true });
  }
});

describe('CodexAuthService', () => {
  it('reports account status and switches by safe query', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'dexyd-codex-auth-'));
    cleanupPaths.push(tempDir);
    const script = join(tempDir, 'codex-auth');
    const switchLog = join(tempDir, 'switch.log');
    writeFileSync(
      script,
      `#!/usr/bin/env bash
set -euo pipefail
case "${'$'}1" in
  --version) echo "codex-auth 0.2.9" ;;
  status) printf 'auto-switch: OFF\nservice: stopped\nusage: api\naccount: api\n' ;;
  list) cat <<'LIST'
     ACCOUNT             PLAN      5H USAGE    WEEKLY USAGE          LAST ACTIVITY
----------------------------------------------------------------------------------
  01 first@example.com   Business  0% (20:52)  84% (15:52 on 8 Jun)  Now
* 02 active@example.com  Business  1% (23:03)  84% (18:03 on 8 Jun)  Now
LIST
  ;;
  switch) echo "${'$'}2" > ${switchLog} ;;
  *) exit 2 ;;
esac
`,
    );
    chmodSync(script, 0o755);

    const service = new CodexAuthService(script);
    const status = service.getStatus();

    expect(status.installed).toBe(true);
    expect(status.activeAccount?.label).toBe('active@example.com');
    expect(status.accounts).toHaveLength(2);

    const switched = service.switchAccount('01');
    expect(switched.installed).toBe(true);
    expect(readFileSync(switchLog, 'utf8').trim()).toBe('01');

    service.switchAccount('02');
    expect(readFileSync(switchLog, 'utf8').trim()).toBe('02');
  });
});
