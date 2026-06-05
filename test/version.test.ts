import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { DEXYD_VERSION } from '../src/version.js';

describe('DEXYD_VERSION', () => {
  it('matches package.json instead of a hardcoded source value', () => {
    const packageJson = JSON.parse(readFileSync('package.json', 'utf8')) as { version: string };
    expect(DEXYD_VERSION).toBe(packageJson.version);
  });
});
