import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const DEXYD_VERSION = readPackageVersion();

function readPackageVersion(): string {
  const packagePath = join(dirname(fileURLToPath(import.meta.url)), '..', 'package.json');
  try {
    const data = JSON.parse(readFileSync(packagePath, 'utf8')) as { version?: unknown };
    return typeof data.version === 'string' && data.version.trim() ? data.version.trim() : '0.0.0';
  } catch {
    return '0.0.0';
  }
}
