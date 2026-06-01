import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { parse as parseToml } from 'smol-toml';
import { DexydConfig, dexydConfigSchema } from './schema.js';

export type LoadConfigOptions = {
  configPath?: string;
};

const SUPPORTED_EXTENSIONS = new Set(['.yaml', '.yml', '.toml', '.json']);

export function loadConfig(options: LoadConfigOptions = {}): DexydConfig {
  const configPath = options.configPath ?? process.env.DEXYD_CONFIG;

  if (!configPath) {
    return dexydConfigSchema.parse({});
  }

  const resolvedPath = resolve(configPath);
  if (!existsSync(resolvedPath)) {
    throw new Error(`Config file not found: ${resolvedPath}`);
  }

  const extension = resolvedPath.slice(resolvedPath.lastIndexOf('.')).toLowerCase();
  if (!SUPPORTED_EXTENSIONS.has(extension)) {
    throw new Error(`Unsupported config extension: ${extension}. Use .yaml, .yml, .toml, or .json`);
  }

  const raw = readFileSync(resolvedPath, 'utf8');
  const parsed = parseByExtension(raw, extension);

  return dexydConfigSchema.parse(parsed);
}

function parseByExtension(raw: string, extension: string): unknown {
  switch (extension) {
    case '.yaml':
    case '.yml':
      return parseYaml(raw);
    case '.toml':
      return parseToml(raw);
    case '.json':
      return JSON.parse(raw);
    default:
      throw new Error(`Unsupported config extension: ${extension}`);
  }
}
