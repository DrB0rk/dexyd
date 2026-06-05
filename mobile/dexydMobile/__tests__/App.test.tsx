import React from 'react';
import ReactTestRenderer from 'react-test-renderer';
import App from '../App';

jest.mock('@react-native-async-storage/async-storage', () => ({
  getItem: jest.fn().mockResolvedValue(null),
  setItem: jest.fn().mockResolvedValue(undefined),
  removeItem: jest.fn().mockResolvedValue(undefined),
  clear: jest.fn().mockResolvedValue(undefined)
}));

jest.mock('../src/api/dexyd-client', () => ({
  getHealth: jest.fn().mockResolvedValue({ status: 'ready' })
}));

jest.mock('../src/hooks/use-auth', () => ({
  useAuth: () => ({
    auth: null,
    loading: false,
    error: null,
    pairFromUri: jest.fn(),
    refresh: jest.fn(),
    signOut: jest.fn(),
    setError: jest.fn()
  })
}));

jest.mock('../src/hooks/use-bridge-settings', () => ({
  useBridgeSettings: () => ({
    bridgeUrl: '',
    wsUrl: '',
    draftBridgeUrl: '',
    setDraftBridgeUrl: jest.fn(),
    loading: false,
    error: null,
    saveBridgeUrl: jest.fn().mockResolvedValue(true),
    resetBridgeUrl: jest.fn().mockResolvedValue(true),
    bridges: [],
    activeBridgeId: null,
    switchBridge: jest.fn(),
    removeBridge: jest.fn(),
    setBridgeUrlFromPairing: jest.fn(),
    setError: jest.fn()
  })
}));

jest.mock('../src/hooks/use-app-updater', () => ({
  useAppUpdater: () => ({
    checking: false,
    installing: false,
    info: null,
    message: null,
    error: null,
    check: jest.fn().mockResolvedValue(null),
    install: jest.fn().mockResolvedValue(false)
  })
}));

jest.mock('../src/hooks/use-sessions', () => ({
  useSessions: () => ({
    sessions: [],
    loading: false,
    error: null,
    connectivity: 'idle',
    refresh: jest.fn(),
    create: jest.fn(),
    createDexydChat: jest.fn(),
    setStatus: jest.fn(),
    cancel: jest.fn(),
    remove: jest.fn(),
    clearCache: jest.fn()
  })
}));

jest.mock('../src/hooks/use-bridge-stream', () => ({
  useBridgeStream: () => ({
    socketState: 'open',
    lastEvent: null,
    socketError: null
  })
}));

jest.mock('../src/hooks/use-chat', () => ({
  useChat: () => ({
    messages: [],
    loading: false,
    sending: false,
    error: null,
    refresh: jest.fn(),
    send: jest.fn().mockResolvedValue(true),
    setError: jest.fn()
  })
}));

jest.mock('../src/hooks/use-codex-auth', () => ({
  useCodexAuth: () => ({
    status: null,
    loading: false,
    switching: null,
    error: null,
    refresh: jest.fn(),
    switchAccount: jest.fn()
  })
}));

jest.mock('../src/hooks/use-devices', () => ({
  useDevices: () => ({
    devices: [],
    loading: false,
    error: null,
    refresh: jest.fn(),
    revoke: jest.fn()
  })
}));

jest.mock('../src/hooks/use-diff', () => ({
  useDiff: () => ({
    diff: null,
    loading: false,
    error: null,
    refresh: jest.fn()
  })
}));

jest.mock('../src/hooks/use-projects', () => ({
  useProjects: () => ({
    projects: null,
    suggestions: [],
    loading: false,
    error: null,
    refresh: jest.fn(),
    browse: jest.fn(),
    suggest: jest.fn()
  })
}));

jest.mock('../src/hooks/use-usage-status', () => ({
  useUsageStatus: () => ({
    usage: null,
    loading: false,
    error: null,
    refresh: jest.fn()
  })
}));

jest.mock('react-native-vision-camera', () => ({
  useCameraPermission: () => ({
    hasPermission: true,
    requestPermission: jest.fn().mockResolvedValue(true)
  })
}));

jest.mock('react-native-vision-camera-barcode-scanner', () => ({
  CodeScanner: 'CodeScanner'
}));

test('renders correctly', async () => {
  await ReactTestRenderer.act(async () => {
    ReactTestRenderer.create(<App />);
    await Promise.resolve();
  });
});
