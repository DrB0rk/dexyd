export const DEFAULT_BRIDGE_HTTP_URL = '';
export const DEFAULT_BRIDGE_WS_URL = '';

export function isLoopbackBridgeUrl(input: string): boolean {
  try {
    const url = new URL(input.trim());
    return url.hostname === '127.0.0.1' || url.hostname === 'localhost' || url.hostname === '::1';
  } catch {
    return false;
  }
}

export function normalizeBridgeHttpUrl(input: string): string {
  const trimmed = input.trim().replace(/\/+$/, '');

  if (!trimmed) {
    throw new Error('Bridge URL is required.');
  }

  const url = new URL(trimmed);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('Bridge URL must start with http:// or https://.');
  }

  const path = url.pathname === '/' ? '' : url.pathname.replace(/\/+$/, '');
  return `${url.protocol}//${url.host}${path}`;
}

export function bridgeHttpToWsUrl(baseUrl: string): string {
  if (!baseUrl.trim()) {
    return DEFAULT_BRIDGE_WS_URL;
  }

  const normalized = normalizeBridgeHttpUrl(baseUrl);
  const url = new URL(normalized);
  const protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  const path = url.pathname === '/' ? '' : url.pathname.replace(/\/+$/, '');
  return `${protocol}//${url.host}${path}/ws`;
}
