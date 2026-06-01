import { networkInterfaces } from 'node:os';

export function localBridgeBaseUrl(host: string, port: number): string {
  return `http://${formatHostForUrl(host)}:${port}`;
}

export function advertisedBridgeBaseUrl(input: { host: string; port: number; publicBaseUrl?: string }): string {
  if (input.publicBaseUrl) {
    return input.publicBaseUrl;
  }

  const host = input.host.trim();
  if (host === '0.0.0.0' || host === '::' || host === '') {
    return `http://${detectLanIPv4() ?? '127.0.0.1'}:${input.port}`;
  }

  return localBridgeBaseUrl(host, input.port);
}

function formatHostForUrl(host: string): string {
  if (host === '0.0.0.0') return '127.0.0.1';
  if (host === '::') return '[::1]';
  if (host.includes(':') && !host.startsWith('[')) return `[${host}]`;
  return host;
}

function detectLanIPv4(): string | null {
  const interfaces = networkInterfaces();

  for (const entries of Object.values(interfaces)) {
    for (const entry of entries ?? []) {
      if (entry.family === 'IPv4' && !entry.internal && isPrivateIPv4(entry.address)) {
        return entry.address;
      }
    }
  }

  for (const entries of Object.values(interfaces)) {
    for (const entry of entries ?? []) {
      if (entry.family === 'IPv4' && !entry.internal) {
        return entry.address;
      }
    }
  }

  return null;
}

function isPrivateIPv4(address: string): boolean {
  return /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[0-1])\.)/.test(address);
}
