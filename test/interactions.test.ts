import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createDexydApplication } from '../src/app.js';
import { pairTestDevice } from './helpers.js';

const cleanupPaths: string[] = [];

afterEach(() => {
  delete process.env.DEXYD_CONFIG;
  for (const path of cleanupPaths.splice(0, cleanupPaths.length)) {
    rmSync(path, { recursive: true, force: true });
  }
});

describe('interaction responses', () => {
  it('accepts approval and multiple-choice question responses as events', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'dexyd-interactions-'));
    cleanupPaths.push(tempDir);

    const configPath = join(tempDir, 'dexyd.yaml');
    writeFileSync(
      configPath,
      `server:\n  host: 127.0.0.1\n  port: 4555\nstorage:\n  sqlitePath: ${join(tempDir, 'dexyd.db')}\n`
    );

    process.env.DEXYD_CONFIG = configPath;
    const service = await createDexydApplication();

    try {
      const tokens = await pairTestDevice(service.app);
      const headers = { authorization: `Bearer ${tokens.accessToken}` };

      const approval = await service.app.inject({
        method: 'POST',
        url: '/interactions/approval-1/respond',
        headers,
        payload: { kind: 'approval', decision: 'approved', note: 'ok' }
      });
      expect(approval.statusCode).toBe(202);
      expect(approval.json().event.eventType).toBe('interaction.approval.responded');
      expect(approval.json().response.decision).toBe('approved');

      const question = await service.app.inject({
        method: 'POST',
        url: '/interactions/question-1/respond',
        headers,
        payload: { kind: 'question', answer: 'Use option B', choiceId: 'b' }
      });
      expect(question.statusCode).toBe(202);
      expect(question.json().event.eventType).toBe('interaction.question.answered');
      expect(question.json().response.choiceId).toBe('b');
    } finally {
      await service.stop();
    }
  });
});
