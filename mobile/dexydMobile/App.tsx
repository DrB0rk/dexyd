import AsyncStorage from '@react-native-async-storage/async-storage';
import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  ActivityIndicator,
  BackHandler,
  Dimensions,
  FlatList,
  Keyboard,
  KeyboardEvent,
  KeyboardAvoidingView,
  LayoutChangeEvent,
  NativeScrollEvent,
  NativeSyntheticEvent,
  PanResponder,
  Platform,
  Pressable,
  RefreshControl,
  ScrollView,
  StatusBar,
  StyleSheet,
  Text,
  TextInput,
  useWindowDimensions,
  View,
} from 'react-native';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import { getHealth, respondToInteraction } from './src/api/dexyd-client';
import { useAuth } from './src/hooks/use-auth';
import { useBridgeSettings } from './src/hooks/use-bridge-settings';
import { useBridgeStream } from './src/hooks/use-bridge-stream';
import { useChat } from './src/hooks/use-chat';
import { useCodexAuth } from './src/hooks/use-codex-auth';
import { useDevices } from './src/hooks/use-devices';
import { useDiff } from './src/hooks/use-diff';
import { useProjects } from './src/hooks/use-projects';
import { useSessions } from './src/hooks/use-sessions';
import { useUsageStatus } from './src/hooks/use-usage-status';
import { QrScannerModal } from './src/ui/qr-scanner-modal';
import { radii, spacing } from './src/ui/theme';
import {
  CodexAuthStatus,
  DiffSummary,
  ProjectBrowseResponse,
  ProjectSuggestResponse,
  UsageStatus,
} from './src/types/api';
import {
  ChatMessage,
  DexydSession,
  EventEnvelope,
  QueuedChatMessage,
} from './src/types/dexyd';
import { errorMessage } from './src/utils/error-message';
import { parseUnifiedDiff, type ParsedDiffLine } from './src/utils/diff-view';

type TabKey = 'chat' | 'sessions' | 'inbox' | 'settings';
type BottomTabKey = Exclude<TabKey, 'chat'>;
type StatusKind = 'ok' | 'warn' | 'error' | 'idle';
type AttentionKind = 'message' | 'update' | 'approval' | 'question';
type SystemNotificationKind =
  | 'response'
  | 'alert'
  | 'approval'
  | 'question'
  | 'usage';
type AttentionChoice = {
  id: string;
  label: string;
  description?: string;
};
type AttentionItem = {
  id: string;
  requestId: string;
  kind: AttentionKind;
  title: string;
  body: string;
  timestamp: string;
  sessionId: string | null;
  choices?: AttentionChoice[];
  responded?: boolean;
  responseLabel?: string;
};
type ProjectOption = {
  path: string;
  label: string;
  detail: string;
};
type ErrorHistoryItem = {
  id: string;
  level: 'error' | 'warning';
  title: string;
  body: string;
  timestamp: string;
};
type SessionUiStatus = {
  label: string;
  detail: string;
  kind: StatusKind;
};
type SystemNotification = {
  id: string;
  kind: SystemNotificationKind;
  title: string;
  body: string;
  timestamp: string;
  sessionId: string | null;
};
type SettingsPaneKey =
  | 'connection'
  | 'pairing'
  | 'account'
  | 'security'
  | 'workspace'
  | 'history'
  | 'diagnostics';
type SettingsPane = {
  key: SettingsPaneKey;
  icon: string;
  title: string;
  subtitle: string;
  detail: string;
  tone: StatusKind;
};

const ONBOARDING_DISMISSED_KEY = 'dexyd.onboarding.dismissed.v1';
const ADDED_PROJECTS_KEY = 'dexyd.projects.added.v1';
const REMOVED_PROJECTS_KEY = 'dexyd.projects.removed.v1';

function keyboardDockHeight(event: KeyboardEvent): number {
  const frame = event.endCoordinates;
  const windowHeight = Dimensions.get('window').height;
  const screenHeight = Dimensions.get('screen').height;
  const hasUsableScreenY = frame.screenY > 0 && frame.screenY < screenHeight;
  const windowOverlap = hasUsableScreenY
    ? Math.max(0, windowHeight - frame.screenY)
    : 0;
  const screenOverlap = hasUsableScreenY
    ? Math.max(0, screenHeight - frame.screenY)
    : 0;
  const maxReasonableLift = Math.round(screenHeight * 0.75);

  return Math.ceil(
    Math.min(
      Math.max(frame.height, windowOverlap, screenOverlap),
      maxReasonableLift,
    ),
  );
}

const tabs: Array<{ key: BottomTabKey; label: string; icon: string }> = [
  { key: 'sessions', label: 'Sessions', icon: '◇' },
  { key: 'inbox', label: 'Inbox', icon: '☼' },
  { key: 'settings', label: 'Settings', icon: '✣' },
];
const bottomTabOrder = tabs.map(item => item.key);
const PAGE_SWIPE_DISTANCE = 72;
const PAGE_SWIPE_CLAIM_DISTANCE = 28;
const PAGE_SWIPE_VELOCITY = 0.45;

export default function App() {
  const [tab, setTab] = useState<TabKey>('sessions');
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [attentionItems, setAttentionItems] = useState<AttentionItem[]>([]);
  const [systemNotification, setSystemNotification] =
    useState<SystemNotification | null>(null);
  const [bridgeHealth, setBridgeHealth] = useState('unknown');
  const [healthLoading, setHealthLoading] = useState(false);
  const [scannerOpen, setScannerOpen] = useState(false);
  const [keyboardVisible, setKeyboardVisible] = useState(false);
  const [keyboardHeight, setKeyboardHeight] = useState(0);
  const [selectedProjectPath, setSelectedProjectPath] = useState('.');
  const [projectMenuOpen, setProjectMenuOpen] = useState(false);
  const [projectPickerOpen, setProjectPickerOpen] = useState(false);
  const [addSessionOpen, setAddSessionOpen] = useState(false);
  const [onboardingDismissed, setOnboardingDismissed] = useState(false);
  const [addedProjects, setAddedProjects] = useState<ProjectOption[]>([]);
  const [removedProjectPaths, setRemovedProjectPaths] = useState<string[]>([]);
  const [errorHistory, setErrorHistory] = useState<ErrorHistoryItem[]>([]);
  const [transientSession, setTransientSession] = useState<DexydSession | null>(
    null,
  );

  const bridgeSettings = useBridgeSettings();
  const auth = useAuth(
    bridgeSettings.bridgeUrl,
    bridgeSettings.setBridgeUrlFromPairing,
  );
  const tokens = useMemo(
    () =>
      auth.auth && bridgeSettings.bridgeUrl
        ? {
            accessToken: auth.auth.accessToken,
            refreshToken: auth.auth.refreshToken,
          }
        : null,
    [auth.auth, bridgeSettings.bridgeUrl],
  );
  const stream = useBridgeStream(
    bridgeSettings.wsUrl,
    bridgeSettings.bridgeUrl,
    tokens?.accessToken ?? null,
    auth.refresh,
  );
  const sessions = useSessions(
    bridgeSettings.bridgeUrl,
    tokens,
    stream.lastEvent,
  );
  const projects = useProjects(bridgeSettings.bridgeUrl, tokens);
  const chat = useChat(
    bridgeSettings.bridgeUrl,
    tokens,
    activeSessionId,
    stream.lastEvent,
  );
  const diff = useDiff(bridgeSettings.bridgeUrl, tokens, activeSessionId);
  const devices = useDevices(bridgeSettings.bridgeUrl, tokens);
  const usage = useUsageStatus(
    bridgeSettings.bridgeUrl,
    tokens,
    activeSessionId,
    stream.lastEvent,
  );
  const codexAuth = useCodexAuth(bridgeSettings.bridgeUrl, tokens);
  const usageAlertThresholdsRef = useRef<Set<number>>(new Set());
  const lastErrorNotificationRef = useRef<string | null>(null);

  useEffect(() => {
    AsyncStorage.getItem(ONBOARDING_DISMISSED_KEY)
      .then(value => setOnboardingDismissed(value === 'true'))
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    Promise.all([
      AsyncStorage.getItem(ADDED_PROJECTS_KEY),
      AsyncStorage.getItem(REMOVED_PROJECTS_KEY),
    ])
      .then(([addedRaw, removedRaw]) => {
        if (addedRaw) {
          const parsed = JSON.parse(addedRaw) as ProjectOption[];
          if (Array.isArray(parsed)) setAddedProjects(parsed);
        }
        if (removedRaw) {
          const parsed = JSON.parse(removedRaw) as string[];
          if (Array.isArray(parsed)) setRemovedProjectPaths(parsed);
        }
      })
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    if (!auth.auth) return;
    setOnboardingDismissed(true);
    AsyncStorage.setItem(ONBOARDING_DISMISSED_KEY, 'true').catch(
      () => undefined,
    );
  }, [auth.auth]);

  const dismissOnboarding = useCallback(async () => {
    setOnboardingDismissed(true);
    await AsyncStorage.setItem(ONBOARDING_DISMISSED_KEY, 'true');
  }, []);

  const activeSession =
    sessions.sessions.find(session => session.id === activeSessionId) ??
    (transientSession?.id === activeSessionId ? transientSession : null);
  const projectOptions = useMemo(
    () =>
      buildProjectOptions(
        projects.projects,
        sessions.sessions,
        addedProjects,
        removedProjectPaths,
      ),
    [addedProjects, projects.projects, removedProjectPaths, sessions.sessions],
  );
  const selectedProject = projectOptions.find(
    project => project.path === selectedProjectPath,
  ) ??
    projectOptions[0] ?? {
      path: '.',
      label: 'Project',
      detail: 'workspace root',
    };

  useEffect(() => {
    if (sessions.sessions.length === 0) {
      if (activeSessionId) setActiveSessionId(null);
      return;
    }

    if (
      !activeSessionId ||
      (!sessions.sessions.some(session => session.id === activeSessionId) &&
        transientSession?.id !== activeSessionId)
    ) {
      setActiveSessionId(sessions.sessions[0].id);
    }
  }, [activeSessionId, sessions.sessions, transientSession]);

  useEffect(() => {
    if (projectOptions.length === 0) return;
    if (!projectOptions.some(project => project.path === selectedProjectPath)) {
      setSelectedProjectPath(projectOptions[0].path);
    }
  }, [projectOptions, selectedProjectPath]);

  const refreshHealth = useCallback(
    async (targetBridgeUrl = bridgeSettings.bridgeUrl) => {
      const url = targetBridgeUrl.trim();
      if (!url) {
        setBridgeHealth('unconfigured');
        return;
      }
      setHealthLoading(true);
      setBridgeHealth(current =>
        current === 'unconfigured' ? 'checking' : current,
      );
      try {
        const health = await getHealth(url);
        setBridgeHealth(health.status);
      } catch {
        setBridgeHealth('down');
      } finally {
        setHealthLoading(false);
      }
    },
    [bridgeSettings.bridgeUrl],
  );

  useEffect(() => {
    refreshHealth().catch(() => undefined);
  }, [refreshHealth]);

  useEffect(() => {
    const show = Keyboard.addListener(
      'keyboardDidShow',
      (event: KeyboardEvent) => {
        setKeyboardVisible(true);
        setKeyboardHeight(keyboardDockHeight(event));
      },
    );
    const hide = Keyboard.addListener('keyboardDidHide', () => {
      setKeyboardVisible(false);
      setKeyboardHeight(0);
    });

    return () => {
      show.remove();
      hide.remove();
    };
  }, []);

  useEffect(() => {
    if (Platform.OS !== 'android') return undefined;

    const subscription = BackHandler.addEventListener(
      'hardwareBackPress',
      () => {
        if (scannerOpen) {
          setScannerOpen(false);
          return true;
        }
        if (addSessionOpen) {
          setAddSessionOpen(false);
          return true;
        }
        if (projectPickerOpen) {
          setProjectPickerOpen(false);
          return true;
        }
        if (projectMenuOpen) {
          setProjectMenuOpen(false);
          return true;
        }
        if (tab === 'chat') {
          setTab('sessions');
          return true;
        }
        if (tab !== 'sessions') {
          setTab('sessions');
          return true;
        }
        return true;
      },
    );

    return () => subscription.remove();
  }, [addSessionOpen, projectMenuOpen, projectPickerOpen, scannerOpen, tab]);

  useEffect(() => {
    if (!systemNotification) return;
    const timer = setTimeout(() => setSystemNotification(null), 4600);
    return () => clearTimeout(timer);
  }, [systemNotification]);

  const addErrorHistory = useCallback(
    (
      item: Omit<ErrorHistoryItem, 'id' | 'timestamp'> & { timestamp?: string },
    ) => {
      const timestamp = item.timestamp ?? new Date().toISOString();
      const id = `${item.level}-${item.title}-${item.body}-${timestamp}`;
      setErrorHistory(current =>
        [
          { ...item, id, timestamp },
          ...current.filter(
            existing =>
              !(existing.title === item.title && existing.body === item.body),
          ),
        ].slice(0, 40),
      );
    },
    [],
  );

  const notify = useCallback(
    (input: Omit<SystemNotification, 'timestamp'> & { timestamp?: string }) => {
      const timestamp = input.timestamp ?? new Date().toISOString();
      if (input.kind === 'alert' || input.kind === 'usage') {
        addErrorHistory({
          level:
            input.kind === 'usage' &&
            input.title.toLowerCase().includes('warning')
              ? 'warning'
              : 'error',
          title: input.title,
          body: input.body,
          timestamp,
        });
      }
      setSystemNotification({
        ...input,
        timestamp,
      });
    },
    [addErrorHistory],
  );

  useEffect(() => {
    const response = interactionResponseFromEvent(stream.lastEvent);
    if (response) {
      setAttentionItems(current =>
        current.map(item =>
          item.requestId === response.requestId
            ? {
                ...item,
                responded: true,
                responseLabel: response.label,
              }
            : item,
        ),
      );
      notify({
        id: `interaction-response-${response.requestId}`,
        kind: 'response',
        title: 'Response sent',
        body: response.label,
        sessionId: null,
      });
      return;
    }

    const item = attentionItemFromEvent(stream.lastEvent, sessions.sessions);
    if (!item) return;
    setAttentionItems(current =>
      [item, ...current.filter(existing => existing.id !== item.id)].slice(
        0,
        50,
      ),
    );
    notify(notificationFromAttention(item));
  }, [notify, sessions.sessions, stream.lastEvent]);

  useEffect(() => {
    if (!stream.socketError) return;
    const key = `${stream.socketState}-${stream.socketError}`;
    addErrorHistory({
      level: 'error',
      title: 'Realtime alert',
      body: stream.socketError,
    });
    if (lastErrorNotificationRef.current === key) return;
    lastErrorNotificationRef.current = key;
    notify({
      id: `socket-${key}`,
      kind: 'alert',
      title: 'Realtime alert',
      body: stream.socketError,
      sessionId: null,
    });
  }, [addErrorHistory, notify, stream.socketError, stream.socketState]);

  useEffect(() => {
    const current = usage.usage;
    if (!current) return;
    const remaining = accountRemainingPercent(current);
    if (remaining !== null && remaining > 50) {
      usageAlertThresholdsRef.current.clear();
    }
    const threshold = accountUsageWarningThreshold(current);
    if (threshold === null) return;
    if (usageAlertThresholdsRef.current.has(threshold)) return;
    usageAlertThresholdsRef.current.add(threshold);
    notify({
      id: `account-usage-${threshold}`,
      kind: 'usage',
      title: `Account usage warning: below ${threshold}%`,
      body: accountUsageWarningBody(current, threshold),
      sessionId: current.sessionId,
    });
  }, [notify, usage.usage]);

  const refreshCodexSessions = useCallback(async () => {
    if (!tokens) {
      setTab('settings');
      return;
    }
    await sessions.refresh();
    setTab('sessions');
  }, [sessions, tokens]);

  const onPlus = useCallback(() => {
    if (!tokens) {
      setTab('settings');
      return;
    }
    setProjectMenuOpen(false);
    setProjectPickerOpen(false);
    setAddSessionOpen(true);
  }, [tokens]);

  const openDexydChat = useCallback(() => {
    if (!tokens) {
      setTab('settings');
      return;
    }
    sessions
      .createDexydChat()
      .then(session => {
        if (!session) return;
        setTransientSession(session);
        setActiveSessionId(session.id);
        setTab('chat');
      })
      .catch(() => undefined);
  }, [sessions, tokens]);

  const createNamedSession = useCallback(
    (project: ProjectOption, title: string) => {
      if (!tokens) return;
      sessions
        .create(project.path, title)
        .then(session => {
          if (!session) return;
          setTransientSession(session);
          setActiveSessionId(session.id);
          setSelectedProjectPath(project.path);
          setAddSessionOpen(false);
          setTab('chat');
        })
        .catch(() => undefined);
    },
    [sessions, tokens],
  );

  const removeProject = useCallback(
    (path: string) => {
      setAddedProjects(current => {
        const next = current.filter(project => project.path !== path);
        AsyncStorage.setItem(ADDED_PROJECTS_KEY, JSON.stringify(next)).catch(
          () => undefined,
        );
        return next;
      });
      setRemovedProjectPaths(current => {
        const next = Array.from(new Set([...current, path]));
        AsyncStorage.setItem(REMOVED_PROJECTS_KEY, JSON.stringify(next)).catch(
          () => undefined,
        );
        return next;
      });
      if (selectedProjectPath === path) {
        setSelectedProjectPath('.');
      }
    },
    [selectedProjectPath],
  );

  const respondToAttention = useCallback(
    async (
      item: AttentionItem,
      response:
        | { kind: 'approval'; decision: 'approved' | 'denied'; note?: string }
        | { kind: 'question'; answer: string; choiceId?: string },
    ) => {
      if (!tokens || item.responded) return;

      await respondToInteraction(
        bridgeSettings.bridgeUrl,
        item.requestId,
        {
          ...response,
          sessionId: item.sessionId,
        },
        tokens,
      );

      setAttentionItems(current =>
        current.map(existing =>
          existing.id === item.id
            ? {
                ...existing,
                responded: true,
                responseLabel:
                  response.kind === 'approval'
                    ? response.decision
                    : response.answer,
              }
            : existing,
        ),
      );
    },
    [bridgeSettings.bridgeUrl, tokens],
  );

  const showOnboarding =
    !bridgeSettings.loading &&
    !auth.loading &&
    !auth.auth &&
    !onboardingDismissed;

  const status = getStatus({
    authLoading: auth.loading,
    settingsLoading: bridgeSettings.loading,
    healthLoading,
    bridgeHealth,
    paired: Boolean(auth.auth),
    socketState: stream.socketState,
    errors: [
      auth.error,
      bridgeSettings.error,
      stream.socketState === 'polling' || stream.socketState === 'open'
        ? null
        : stream.socketError,
    ],
  });

  const pageSwipeEnabled =
    !showOnboarding &&
    tab !== 'chat' &&
    !projectMenuOpen &&
    !projectPickerOpen &&
    !addSessionOpen &&
    !scannerOpen;

  const pageSwipeResponder = useMemo(
    () =>
      PanResponder.create({
        onMoveShouldSetPanResponder: (_, gesture) => {
          if (!pageSwipeEnabled) return false;
          const horizontal = Math.abs(gesture.dx);
          const vertical = Math.abs(gesture.dy);
          return (
            horizontal > PAGE_SWIPE_CLAIM_DISTANCE &&
            horizontal > vertical * 1.5
          );
        },
        onPanResponderRelease: (_, gesture) => {
          if (!pageSwipeEnabled) return;
          const force =
            Math.abs(gesture.dx) >= PAGE_SWIPE_DISTANCE ||
            Math.abs(gesture.vx) >= PAGE_SWIPE_VELOCITY;
          if (!force) return;
          const currentIndex = bottomTabOrder.indexOf(tab as BottomTabKey);
          if (currentIndex < 0) return;
          const nextIndex = gesture.dx < 0 ? currentIndex + 1 : currentIndex - 1;
          const nextTab = bottomTabOrder[nextIndex];
          if (nextTab) setTab(nextTab);
        },
        onPanResponderTerminate: () => undefined,
      }),
    [pageSwipeEnabled, tab],
  );

  return (
    <SafeAreaProvider>
      <SafeAreaView style={styles.safe} edges={['top', 'left', 'right']}>
        <StatusBar barStyle="light-content" backgroundColor={palette.bg} />
        <View style={styles.shell}>
          {tab === 'chat' ? null : (
            <>
              <TopBar
                project={selectedProject}
                status={status}
                menuOpen={projectMenuOpen}
                onToggleProjects={() => setProjectMenuOpen(open => !open)}
                onHelpChat={openDexydChat}
                onPlus={onPlus}
              />
              {projectMenuOpen ? (
                <ProjectMenu
                  loading={projects.loading}
                  projects={projectOptions}
                  selectedPath={selectedProject.path}
                  onSelect={project => {
                    setSelectedProjectPath(project.path);
                    setProjectMenuOpen(false);
                  }}
                  onNewProject={() => {
                    setProjectMenuOpen(false);
                    setProjectPickerOpen(true);
                    projects.browse('~').catch(() => undefined);
                  }}
                  onRefresh={() => projects.refresh()}
                  onRemove={removeProject}
                />
              ) : null}
              <ProjectPicker
                visible={projectPickerOpen}
                loading={projects.loading}
                browse={projects.projects}
                onClose={() => setProjectPickerOpen(false)}
                suggestions={projects.suggestions}
                onBrowse={path => projects.browse(path)}
                onSuggest={path => projects.suggest(path)}
                onChoose={project => {
                  setAddedProjects(current => {
                    const next = upsertProjectOption(current, project);
                    AsyncStorage.setItem(
                      ADDED_PROJECTS_KEY,
                      JSON.stringify(next),
                    ).catch(() => undefined);
                    return next;
                  });
                  setRemovedProjectPaths(current => {
                    const next = current.filter(path => path !== project.path);
                    AsyncStorage.setItem(
                      REMOVED_PROJECTS_KEY,
                      JSON.stringify(next),
                    ).catch(() => undefined);
                    return next;
                  });
                  setSelectedProjectPath(project.path);
                  setProjectPickerOpen(false);
                }}
              />
              <AddSessionModal
                visible={addSessionOpen}
                projects={projectOptions}
                selectedProject={selectedProject}
                onClose={() => setAddSessionOpen(false)}
                onNewProject={() => {
                  setAddSessionOpen(false);
                  setProjectPickerOpen(true);
                  projects.browse('~').catch(() => undefined);
                }}
                onCreate={createNamedSession}
              />
            </>
          )}
          <View style={styles.content} {...pageSwipeResponder.panHandlers}>
            {showOnboarding ? (
              <OnboardingScreen
                bridgeUrl={bridgeSettings.bridgeUrl}
                onScanQr={() => {
                  dismissOnboarding().catch(() => undefined);
                  setTab('settings');
                  setScannerOpen(true);
                }}
                onManual={() => {
                  dismissOnboarding().catch(() => undefined);
                  setTab('settings');
                }}
                onSkip={() => dismissOnboarding().catch(() => undefined)}
              />
            ) : null}
            {!showOnboarding && tab === 'chat' ? (
              <ChatScreen
                authReady={Boolean(auth.auth)}
                activeSession={activeSession}
                goToSessions={() => setTab('sessions')}
                chat={chat}
                diff={diff}
                usage={usage.usage}
                keyboardHeight={keyboardHeight}
              />
            ) : null}
            {!showOnboarding && tab === 'inbox' ? (
              <InboxScreen
                authReady={Boolean(auth.auth)}
                items={attentionItems}
                onClear={() => setAttentionItems([])}
                onRefresh={sessions.refresh}
                onOpenSession={sessionId => {
                  if (sessionId) setActiveSessionId(sessionId);
                  setProjectMenuOpen(false);
                  setProjectPickerOpen(false);
                  setTab('chat');
                }}
                onRespond={respondToAttention}
              />
            ) : null}
            {!showOnboarding && tab === 'sessions' ? (
              <SessionsScreen
                loading={auth.loading || sessions.loading}
                authReady={Boolean(auth.auth)}
                sessions={sessions.sessions}
                usage={usage.usage}
                connectivity={sessions.connectivity}
                error={sessions.error}
                attentionItems={attentionItems}
                activeSessionId={activeSessionId}
                onSelect={sessionId => {
                  const session = sessions.sessions.find(
                    item => item.id === sessionId,
                  );
                  if (session?.workspacePath) {
                    setSelectedProjectPath(session.workspacePath);
                  }
                  setProjectMenuOpen(false);
                  setProjectPickerOpen(false);
                  setActiveSessionId(sessionId);
                  setTab('chat');
                }}
                onRefresh={refreshCodexSessions}
                onCancel={sessionId => sessions.cancel(sessionId)}
                onDelete={async sessionId => {
                  const removed = await sessions.remove(sessionId);
                  if (removed && activeSessionId === sessionId) {
                    setActiveSessionId(null);
                    setTab('sessions');
                  }
                }}
              />
            ) : null}
            {!showOnboarding && tab === 'settings' ? (
              <SettingsScreen
                auth={auth}
                bridgeSettings={bridgeSettings}
                bridgeHealth={bridgeHealth}
                refreshHealth={refreshHealth}
                scannerOpen={scannerOpen}
                setScannerOpen={setScannerOpen}
                socketState={stream.socketState}
                socketError={stream.socketError}
                sessionsCount={sessions.sessions.length}
                devices={devices}
                usage={usage}
                codexAuth={codexAuth}
                errorHistory={errorHistory}
                onClearErrorHistory={() => setErrorHistory([])}
                onFullReset={async () => {
                  await auth.signOut();
                  await sessions.clearCache();
                  await AsyncStorage.clear();
                  await bridgeSettings.resetBridgeUrl();
                  auth.setError(null);
                  bridgeSettings.setError(null);
                  setErrorHistory([]);
                  setAttentionItems([]);
                  setActiveSessionId(null);
                  setTransientSession(null);
                  setOnboardingDismissed(false);
                  setTab('settings');
                }}
              />
            ) : null}
          </View>
          <SystemNotificationToast
            notification={systemNotification}
            onDismiss={() => setSystemNotification(null)}
            onPress={notification => {
              setSystemNotification(null);
              if (notification.sessionId) {
                setActiveSessionId(notification.sessionId);
                setTab('chat');
                return;
              }
              setTab(
                notification.kind === 'approval' ||
                  notification.kind === 'question'
                  ? 'inbox'
                  : 'sessions',
              );
            }}
          />
          {keyboardVisible || tab === 'chat' || showOnboarding ? null : (
            <BottomTabs active={tab} onSelect={setTab} />
          )}
        </View>
      </SafeAreaView>
    </SafeAreaProvider>
  );
}

function getStatus(input: {
  authLoading: boolean;
  settingsLoading: boolean;
  healthLoading: boolean;
  bridgeHealth: string;
  paired: boolean;
  socketState: string;
  errors: Array<string | null>;
}): { label: string; kind: StatusKind } {
  if (input.authLoading || input.settingsLoading || input.healthLoading)
    return { label: 'loading', kind: 'idle' };
  if (
    input.errors.some(Boolean) ||
    !input.paired ||
    input.bridgeHealth === 'down' ||
    input.bridgeHealth === 'unconfigured'
  ) {
    return { label: 'error', kind: 'error' };
  }
  if (input.socketState === 'polling')
    return { label: 'polling', kind: 'warn' };
  if (input.socketState === 'open') return { label: 'connected', kind: 'ok' };
  return { label: 'ready', kind: 'idle' };
}

function OnboardingScreen({
  bridgeUrl,
  onScanQr,
  onManual,
  onSkip,
}: {
  bridgeUrl: string;
  onScanQr: () => void;
  onManual: () => void;
  onSkip: () => void;
}) {
  return (
    <View style={styles.onboardingShell}>
      <Text style={styles.onboardingKicker}>dexyd setup</Text>
      <Text style={styles.onboardingTitle}>
        Connect this phone to your bridge.
      </Text>
      <Text style={styles.onboardingBody}>
        Start the bridge/TUI on your computer, generate a pairing QR, then scan
        it here. Pairing saves the bridge profile so you can switch between PCs
        later.
      </Text>
      <View style={styles.onboardingSteps}>
        <Text style={styles.onboardingStep}>
          1 · Run dexyd --tui on your computer
        </Text>
        <Text style={styles.onboardingStep}>
          2 · Open Pairing and generate QR
        </Text>
        <Text style={styles.onboardingStep}>3 · Scan from this app</Text>
      </View>
      {bridgeUrl ? (
        <Text style={styles.onboardingHint}>Current bridge: {bridgeUrl}</Text>
      ) : (
        <Text style={styles.onboardingHint}>No bridge selected yet.</Text>
      )}
      <View style={styles.onboardingActions}>
        <TextButton label="Scan QR" variant="primary" onPress={onScanQr} />
        <TextButton label="Manual setup" onPress={onManual} />
        <TextButton label="Later" onPress={onSkip} />
      </View>
    </View>
  );
}

function TopBar({
  project,
  status,
  menuOpen,
  onToggleProjects,
  onHelpChat,
  onPlus,
}: {
  project: ProjectOption;
  status: { label: string; kind: StatusKind };
  menuOpen: boolean;
  onToggleProjects: () => void;
  onHelpChat: () => void;
  onPlus: () => void;
}) {
  return (
    <View style={styles.topBar}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Select project"
        onPress={onToggleProjects}
        style={({ pressed }) => [
          styles.projectSelector,
          menuOpen && styles.projectSelectorActive,
          pressed && styles.pressed,
        ]}
      >
        <Text style={styles.title} numberOfLines={1}>
          {project.label}
        </Text>
        <View style={styles.statusLine}>
          <View
            style={[
              styles.statusDot,
              { backgroundColor: statusColor(status.kind) },
            ]}
          />
          <Text
            style={[styles.statusText, { color: statusColor(status.kind) }]}
          >
            {status.label}
          </Text>
          <Text style={styles.projectChevron}>{menuOpen ? '⌃' : '⌄'}</Text>
        </View>
      </Pressable>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Open dexyd help chat"
        onPress={onHelpChat}
        style={({ pressed }) => [
          styles.helpChatButton,
          pressed && styles.pressed,
        ]}
      >
        <Text style={styles.helpChatIcon}>⌕</Text>
      </Pressable>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Add"
        onPress={onPlus}
        style={({ pressed }) => [styles.plusButton, pressed && styles.pressed]}
      >
        <Text style={styles.plus}>＋</Text>
      </Pressable>
    </View>
  );
}

function SystemNotificationToast({
  notification,
  onDismiss,
  onPress,
}: {
  notification: SystemNotification | null;
  onDismiss: () => void;
  onPress: (notification: SystemNotification) => void;
}) {
  if (!notification) return null;

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={notification.title}
      onPress={() => onPress(notification)}
      style={({ pressed }) => [
        styles.systemToast,
        notification.kind === 'alert' && styles.systemToastAlert,
        notification.kind === 'approval' && styles.systemToastApproval,
        notification.kind === 'question' && styles.systemToastQuestion,
        notification.kind === 'usage' && styles.systemToastUsage,
        pressed && styles.pressed,
      ]}
    >
      <View style={styles.systemToastIcon}>
        <Text style={styles.systemToastIconText}>
          {notificationIcon(notification.kind)}
        </Text>
      </View>
      <View style={styles.systemToastTextBlock}>
        <Text style={styles.systemToastTitle} numberOfLines={1}>
          {notification.title}
        </Text>
        <Text style={styles.systemToastBody} numberOfLines={2}>
          {notification.body}
        </Text>
      </View>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Dismiss notification"
        onPress={event => {
          event.stopPropagation();
          onDismiss();
        }}
        hitSlop={10}
      >
        <Text style={styles.systemToastClose}>×</Text>
      </Pressable>
    </Pressable>
  );
}

function ProjectMenu({
  loading,
  projects,
  selectedPath,
  onSelect,
  onNewProject,
  onRefresh,
  onRemove,
}: {
  loading: boolean;
  projects: ProjectOption[];
  selectedPath: string;
  onSelect: (project: ProjectOption) => void;
  onNewProject: () => void;
  onRefresh: () => Promise<void>;
  onRemove: (path: string) => void;
}) {
  return (
    <View style={styles.projectMenu}>
      <View style={styles.projectMenuHeader}>
        <Text style={styles.projectMenuTitle}>Projects</Text>
        <Pressable
          onPress={() => onRefresh().catch(() => undefined)}
          hitSlop={10}
        >
          <Text style={styles.projectRefresh}>
            {loading ? 'loading…' : 'refresh'}
          </Text>
        </Pressable>
      </View>
      {projects.map(project => {
        const selected = project.path === selectedPath;
        return (
          <Pressable
            key={project.path}
            onPress={() => onSelect(project)}
            style={({ pressed }) => [
              styles.projectMenuRow,
              selected && styles.projectMenuRowActive,
              pressed && styles.pressed,
            ]}
          >
            <View style={styles.projectMenuText}>
              <Text style={styles.projectMenuName} numberOfLines={1}>
                {project.label}
              </Text>
              <Text style={styles.projectMenuDetail} numberOfLines={1}>
                {project.detail}
              </Text>
            </View>
            <View style={styles.projectMenuActions}>
              {selected ? <Text style={styles.projectSelected}>✓</Text> : null}
              {project.path !== '.' ? (
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={`Remove ${project.label} from dexyd`}
                  onPress={event => {
                    event.stopPropagation();
                    onRemove(project.path);
                  }}
                  hitSlop={10}
                >
                  <Text style={styles.projectRemove}>×</Text>
                </Pressable>
              ) : null}
            </View>
          </Pressable>
        );
      })}
      <Pressable
        onPress={onNewProject}
        style={({ pressed }) => [
          styles.projectMenuRow,
          styles.projectNewRow,
          pressed && styles.pressed,
        ]}
      >
        <View style={styles.projectMenuText}>
          <Text style={styles.projectMenuName}>＋ New project</Text>
          <Text style={styles.projectMenuDetail}>
            Choose a directory from the workspace
          </Text>
        </View>
      </Pressable>
    </View>
  );
}

function AddSessionModal({
  visible,
  projects,
  selectedProject,
  onClose,
  onNewProject,
  onCreate,
}: {
  visible: boolean;
  projects: ProjectOption[];
  selectedProject: ProjectOption;
  onClose: () => void;
  onNewProject: () => void;
  onCreate: (project: ProjectOption, title: string) => void;
}) {
  const [project, setProject] = useState(selectedProject);
  const [title, setTitle] = useState('');

  useEffect(() => {
    if (!visible) return;
    setProject(selectedProject);
    setTitle('');
  }, [selectedProject, visible]);

  if (!visible) return null;

  return (
    <View style={styles.pickerOverlay}>
      <View style={styles.addSessionPanel}>
        <View style={styles.pickerHeader}>
          <View style={styles.pickerTitleBlock}>
            <Text style={styles.pickerTitle}>New session</Text>
            <Text style={styles.pickerPath} numberOfLines={1}>
              {project.detail}
            </Text>
          </View>
          <Pressable onPress={onClose} hitSlop={10}>
            <Text style={styles.pickerClose}>×</Text>
          </Pressable>
        </View>
        <LabeledInput
          label="Session name"
          value={title}
          onChangeText={setTitle}
          placeholder="Optional title"
          autoCapitalize="sentences"
        />
        <Text style={styles.inputLabel}>Project</Text>
        <ScrollView
          style={styles.projectPickList}
          keyboardShouldPersistTaps="handled"
        >
          {projects.map(item => (
            <Pressable
              key={item.path}
              onPress={() => setProject(item)}
              style={({ pressed }) => [
                styles.projectMenuRow,
                item.path === project.path && styles.projectMenuRowActive,
                pressed && styles.pressed,
              ]}
            >
              <View style={styles.projectMenuText}>
                <Text style={styles.projectMenuName} numberOfLines={1}>
                  {item.label}
                </Text>
                <Text style={styles.projectMenuDetail} numberOfLines={1}>
                  {item.detail}
                </Text>
              </View>
              {item.path === project.path ? (
                <Text style={styles.projectSelected}>✓</Text>
              ) : null}
            </Pressable>
          ))}
        </ScrollView>
        <View style={styles.settingsActions}>
          <TextButton label="Browse" onPress={onNewProject} />
          <TextButton
            label="Create"
            variant="primary"
            onPress={() => onCreate(project, title)}
          />
        </View>
      </View>
    </View>
  );
}

function ProjectPicker({
  visible,
  loading,
  browse,
  suggestions,
  onClose,
  onBrowse,
  onSuggest,
  onChoose,
}: {
  visible: boolean;
  loading: boolean;
  browse: ProjectBrowseResponse | null;
  suggestions: ProjectSuggestResponse | null;
  onClose: () => void;
  onBrowse: (path: string) => Promise<ProjectBrowseResponse | null>;
  onSuggest: (path: string) => Promise<ProjectSuggestResponse | null>;
  onChoose: (project: ProjectOption) => void;
}) {
  const [customPath, setCustomPath] = useState('~');

  useEffect(() => {
    if (!visible) return undefined;
    setCustomPath(browse?.currentPath || '~');
    const subscription = BackHandler.addEventListener(
      'hardwareBackPress',
      () => {
        onClose();
        return true;
      },
    );
    return () => subscription.remove();
  }, [browse?.currentPath, onClose, visible]);

  useEffect(() => {
    if (!visible || !customPath.trim()) return undefined;
    const timer = setTimeout(() => {
      onSuggest(customPath).catch(() => undefined);
    }, 220);
    return () => clearTimeout(timer);
  }, [customPath, onSuggest, visible]);

  if (!visible) return null;

  const currentLabel = browse
    ? projectNameFromPath(browse.currentPath || browse.rootPath)
    : 'Home';

  const browseCustomPath = () => {
    const path = customPath.trim() || '~';
    onBrowse(path).catch(() => undefined);
  };

  return (
    <View style={styles.pickerOverlay}>
      <View style={styles.pickerPanel}>
        <View style={styles.pickerHeader}>
          <View style={styles.pickerTitleBlock}>
            <Text style={styles.pickerTitle}>New project</Text>
            <Text style={styles.pickerPath} numberOfLines={1}>
              {browse?.absolutePath || 'loading home directory…'}
            </Text>
          </View>
          <Pressable onPress={onClose} hitSlop={10}>
            <Text style={styles.pickerClose}>×</Text>
          </Pressable>
        </View>

        <LabeledInput
          label="Location"
          value={customPath}
          onChangeText={setCustomPath}
          placeholder="~/Projects or /mnt/work/project"
          autoCapitalize="none"
          autoCorrect={false}
        />

        {suggestions?.suggestions.length ? (
          <View style={styles.suggestionStrip}>
            {suggestions.suggestions.slice(0, 5).map(suggestion => (
              <Pressable
                key={suggestion.path}
                onPress={() => {
                  setCustomPath(suggestion.path);
                  onBrowse(suggestion.path).catch(() => undefined);
                }}
                style={({ pressed }) => [
                  styles.suggestionPill,
                  pressed && styles.pressed,
                ]}
              >
                <Text style={styles.suggestionText} numberOfLines={1}>
                  {suggestion.name}
                </Text>
              </Pressable>
            ))}
          </View>
        ) : null}

        <View style={styles.pickerActions}>
          {browse?.parentPath ? (
            <TextButton
              label="Up"
              onPress={() =>
                onBrowse(browse.parentPath || '~').catch(() => undefined)
              }
            />
          ) : null}
          <TextButton label="Go" onPress={browseCustomPath} />
          <TextButton
            label={`Use ${currentLabel}`}
            variant="primary"
            disabled={!browse}
            onPress={() => {
              if (!browse) return;
              onChoose(projectOptionFromBrowse(browse));
            }}
          />
        </View>

        {loading ? (
          <ActivityIndicator color={palette.text} size="small" />
        ) : null}

        <ScrollView
          style={styles.pickerList}
          keyboardShouldPersistTaps="handled"
        >
          {browse?.entries.length === 0 ? (
            <Text style={styles.settingHint}>No child directories.</Text>
          ) : null}
          {browse?.entries.map(entry => (
            <Pressable
              key={entry.path}
              onPress={() => {
                setCustomPath(entry.path);
                onBrowse(entry.path).catch(() => undefined);
              }}
              style={({ pressed }) => [
                styles.pickerRow,
                pressed && styles.pressed,
              ]}
            >
              <View style={styles.pickerFolderGlyph}>
                <Text style={styles.pickerFolderGlyphText}>⌁</Text>
              </View>
              <View style={styles.projectMenuText}>
                <Text style={styles.projectMenuName} numberOfLines={1}>
                  {entry.name}
                </Text>
                <Text style={styles.projectMenuDetail} numberOfLines={1}>
                  {entry.path}
                </Text>
              </View>
            </Pressable>
          ))}
        </ScrollView>
      </View>
    </View>
  );
}

const EMPTY_DIFF: DiffSummary = {
  status: '',
  stat: '',
  diff: '',
  truncated: false,
};

function ChatScreen({
  authReady,
  activeSession,
  goToSessions,
  chat,
  diff,
  usage,
  keyboardHeight,
}: {
  authReady: boolean;
  activeSession: DexydSession | null;
  goToSessions: () => void;
  chat: ReturnType<typeof useChat>;
  diff: ReturnType<typeof useDiff>;
  usage: UsageStatus | null;
  keyboardHeight: number;
}) {
  const [text, setText] = useState('');
  const [showLatestButton, setShowLatestButton] = useState(false);
  const [diffViewerOpen, setDiffViewerOpen] = useState(false);
  const [selectedDiffTurnId, setSelectedDiffTurnId] = useState<string | null>(
    null,
  );
  const [composerHeight, setComposerHeight] = useState(54);
  const [steeringQueueId, setSteeringQueueId] = useState<string | null>(null);
  const scrollRef = useRef<FlatList<ChatMessage> | null>(null);
  const nearBottomRef = useRef(true);
  const latestButtonVisibleRef = useRef(false);
  const keyboardLift =
    Platform.OS === 'android' && keyboardHeight > 0 ? keyboardHeight + 8 : 0;
  const composerSpacer = composerHeight + keyboardLift + 12;
  const usageBlockMessage = usageSendBlockMessage(usage);
  const renderedMessages = useMemo(
    () =>
      chat.messages.filter(message => message.status !== 'queued').reverse(),
    [chat.messages],
  );

  const setLatestButtonVisible = useCallback((visible: boolean) => {
    if (latestButtonVisibleRef.current === visible) return;
    latestButtonVisibleRef.current = visible;
    setShowLatestButton(visible);
  }, []);

  const scrollToLatest = useCallback(
    (animated = true) => {
      nearBottomRef.current = true;
      setLatestButtonVisible(false);
      requestAnimationFrame(() => {
        scrollRef.current?.scrollToOffset({ offset: 0, animated });
      });
    },
    [setLatestButtonVisible],
  );

  const updateScrollPosition = useCallback(
    (event: NativeSyntheticEvent<NativeScrollEvent>) => {
      const { contentOffset } = event.nativeEvent;
      const distanceFromBottom = Math.max(0, contentOffset.y);
      const atBottom = distanceFromBottom <= 80;
      nearBottomRef.current = atBottom;

      if (atBottom) {
        setLatestButtonVisible(false);
        return;
      }

      if (distanceFromBottom > 260) {
        setLatestButtonVisible(true);
      }
    },
    [setLatestButtonVisible],
  );

  const updateComposerHeight = useCallback((event: LayoutChangeEvent) => {
    const nextHeight = Math.ceil(event.nativeEvent.layout.height);
    setComposerHeight(currentHeight =>
      Math.abs(currentHeight - nextHeight) > 1 ? nextHeight : currentHeight,
    );
  }, []);

  useEffect(() => {
    nearBottomRef.current = true;
    setLatestButtonVisible(false);
    setDiffViewerOpen(false);
    setSelectedDiffTurnId(null);
    setSteeringQueueId(null);
  }, [activeSession?.id, setLatestButtonVisible]);

  useEffect(() => {
    if (keyboardLift > 0 && nearBottomRef.current) {
      scrollToLatest(false);
    }
  }, [keyboardLift, scrollToLatest]);

  const openMessageDiff = useCallback(
    (turnId: string) => {
      setSelectedDiffTurnId(turnId);
      setDiffViewerOpen(true);
      diff.refresh(turnId).catch(() => undefined);
    },
    [diff],
  );

  const workingInfo = workingStatusText(
    chat.messages,
    activeSession,
    chat.sending,
  );

  const send = async () => {
    const message = text.trim();
    if (!message || chat.sending || !authReady) return;
    if (!activeSession) {
      goToSessions();
      return;
    }
    if (usageBlockMessage) {
      chat.setError(usageBlockMessage);
      return;
    }
    const ok = steeringQueueId
      ? await chat.steerQueued(steeringQueueId, message)
      : await chat.send(message);
    if (ok) {
      setText('');
      setSteeringQueueId(null);
      scrollToLatest();
    }
  };

  const sendDisabled =
    !text.trim() ||
    chat.sending ||
    !activeSession ||
    Boolean(usageBlockMessage);
  const steeringTarget = steeringQueueId
    ? (chat.queuedMessages.find(item => item.queueId === steeringQueueId) ??
      null)
    : null;

  const header = (
    <View style={styles.chatHeader}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Back to sessions"
        onPress={goToSessions}
        hitSlop={10}
        style={({ pressed }) => [
          styles.chatBackButton,
          pressed && styles.pressed,
        ]}
      >
        <Text style={styles.chatBackText}>‹</Text>
      </Pressable>
      <View style={styles.chatHeaderText}>
        <Text style={styles.chatHeaderTitle} numberOfLines={1}>
          {activeSession?.title || 'Chat'}
        </Text>
        <Text style={styles.chatHeaderMeta} numberOfLines={1}>
          {activeSession
            ? `${activeSession.status} · ${usage ? usageSummary(usage) : activeSession.workspacePath || 'workspace'}`
            : 'Select a session'}
        </Text>
      </View>
    </View>
  );

  if (!authReady) {
    return (
      <View style={styles.fill}>
        {header}
        <QuietCenter text="Pair in Settings" />
      </View>
    );
  }

  return (
    <KeyboardAvoidingView
      style={styles.fill}
      behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
      keyboardVerticalOffset={0}
      enabled={Platform.OS === 'ios'}
    >
      {header}
      <FlatList
        ref={scrollRef}
        style={styles.fill}
        contentContainerStyle={styles.messages}
        data={renderedMessages}
        inverted
        keyExtractor={message => `${message.id}-${message.sequence}`}
        renderItem={({ item }) => (
          <MessageRow
            message={item}
            showDiffButton={
              item.role === 'assistant' &&
              item.status === 'sent' &&
              Boolean(item.turnId)
            }
            diffLoading={
              diff.loading && diff.loadingTurnId === item.turnId
            }
            onViewDiff={() => openMessageDiff(item.turnId)}
          />
        )}
        ListHeaderComponent={
          <View>
            <View style={{ height: composerSpacer }} />
            {chat.queuedMessages.length ? (
              <QueuedMessagesPanel
                items={chat.queuedMessages}
                activeQueueId={steeringQueueId}
                onSteer={item => {
                  setSteeringQueueId(item.queueId);
                  setText('');
                }}
                onRemove={queueId => chat.removeQueued(queueId)}
              />
            ) : null}
            {chat.loading ? (
              <ActivityIndicator color={palette.text} size="small" />
            ) : null}
          </View>
        }
        initialNumToRender={14}
        maxToRenderPerBatch={10}
        updateCellsBatchingPeriod={32}
        windowSize={7}
        removeClippedSubviews={Platform.OS === 'android'}
        keyboardShouldPersistTaps="handled"
        onContentSizeChange={() => {
          if (nearBottomRef.current) {
            scrollToLatest(false);
          }
        }}
        onScroll={updateScrollPosition}
        onScrollEndDrag={updateScrollPosition}
        onMomentumScrollEnd={updateScrollPosition}
        scrollEventThrottle={32}
      />
      {showLatestButton ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Go to latest message"
          onPress={() => scrollToLatest()}
          style={({ pressed }) => [
            styles.latestButton,
            { bottom: composerHeight + keyboardLift + 16 },
            pressed && styles.pressed,
          ]}
        >
          <Text style={styles.latestButtonText}>↓</Text>
        </Pressable>
      ) : null}
      {workingInfo ? (
        <View
          pointerEvents="none"
          style={[
            styles.workingStateDock,
            { bottom: composerHeight + keyboardLift + 14 },
          ]}
        >
          <WorkingState text={workingInfo} />
        </View>
      ) : null}
      <View
        onLayout={updateComposerHeight}
        style={[
          styles.composer,
          styles.composerDocked,
          { bottom: keyboardLift },
        ]}
      >
        {steeringTarget ? (
          <View style={styles.composerNotice}>
            <View style={styles.steeringNoticeRow}>
              <Text style={styles.composerNoticeText} numberOfLines={2}>
                Steering queued message: {previewText(steeringTarget.content)}
              </Text>
              <Pressable onPress={() => setSteeringQueueId(null)} hitSlop={8}>
                <Text style={styles.steeringCancel}>cancel</Text>
              </Pressable>
            </View>
          </View>
        ) : usageBlockMessage ? (
          <View style={styles.composerNotice}>
            <Text style={styles.composerNoticeText} numberOfLines={2}>
              {usageBlockMessage}
            </Text>
          </View>
        ) : null}
        <View style={styles.composerRow}>
          <TextInput
            value={text}
            onChangeText={setText}
            placeholder={
              activeSession
                ? steeringQueueId
                  ? 'Add steering for queued message'
                  : 'Message'
                : 'Select a Codex session first'
            }
            placeholderTextColor={palette.dim}
            style={styles.composerInput}
            multiline
            editable={!usageBlockMessage}
            onFocus={() => scrollToLatest(false)}
          />
          <Pressable
            onPress={() => send().catch(() => undefined)}
            disabled={sendDisabled}
            style={({ pressed }) => [
              styles.sendButton,
              sendDisabled && styles.sendButtonDisabled,
              pressed && !sendDisabled && styles.pressed,
            ]}
          >
            <Text
              style={[styles.sendText, sendDisabled && styles.sendTextDisabled]}
            >
              {steeringQueueId ? '↪' : '↑'}
            </Text>
          </Pressable>
        </View>
      </View>
      {diffViewerOpen ? (
        <DiffViewer
          diff={diff.diff ?? EMPTY_DIFF}
          loading={diff.loading}
          error={diff.error}
          onClose={() => setDiffViewerOpen(false)}
          onRefresh={() =>
            diff.refresh(selectedDiffTurnId).catch(() => undefined)
          }
        />
      ) : null}
    </KeyboardAvoidingView>
  );
}

const WORKING_PHRASES = [
  'scouting',
  'brewing',
  'threading',
  'checking',
  'assembling',
  'polishing',
];

function workingStatusText(
  messages: ChatMessage[],
  activeSession: DexydSession | null,
  sending: boolean,
): string | null {
  if (sending) return 'sending · handing this to Codex';
  const running = [...messages]
    .reverse()
    .find(message => message.role === 'tool' && message.status === 'running');
  const isWorking = activeSession?.status === 'running' || Boolean(running);
  if (!isWorking) return null;
  const phrase =
    WORKING_PHRASES[
      Math.abs(hashString(activeSession?.id ?? running?.turnId ?? 'dexyd')) %
        WORKING_PHRASES.length
    ];
  const detail =
    running?.content.replace(/…+$/, '').trim() || 'Codex is working';
  return `${phrase} · ${detail}`;
}

function hashString(value: string): number {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) {
    hash = (hash * 31 + value.charCodeAt(index)) % 1_000_000_007;
  }
  return hash;
}

function WorkingState({ text }: { text: string }) {
  return (
    <View style={styles.workingState}>
      <ActivityIndicator color={palette.muted} size="small" />
      <Text style={styles.workingText} numberOfLines={2}>
        {text}
      </Text>
    </View>
  );
}

function QueuedMessagesPanel({
  items,
  activeQueueId,
  onSteer,
  onRemove,
}: {
  items: QueuedChatMessage[];
  activeQueueId: string | null;
  onSteer: (item: QueuedChatMessage) => void;
  onRemove: (queueId: string) => Promise<boolean> | boolean;
}) {
  return (
    <View style={styles.queuePanel}>
      <View style={styles.queueHeader}>
        <Text style={styles.queueTitle}>Queued messages</Text>
        <Text style={styles.queueCount}>{items.length}</Text>
      </View>
      {items.map((item, index) => {
        const active = item.queueId === activeQueueId;
        return (
          <View
            key={item.queueId}
            style={[styles.queueItem, active && styles.queueItemActive]}
          >
            <View style={styles.queueItemText}>
              <Text style={styles.queueItemTitle}>
                #{index + 1} · will send next
              </Text>
              <Text style={styles.queueItemBody} numberOfLines={3}>
                {item.content}
              </Text>
            </View>
            <View style={styles.queueActions}>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Steer queued message"
                onPress={() => onSteer(item)}
                style={({ pressed }) => [
                  styles.queueActionButton,
                  active && styles.queueActionButtonActive,
                  pressed && styles.pressed,
                ]}
              >
                <Text style={styles.queueActionText}>
                  {active ? 'steering' : 'steer'}
                </Text>
              </Pressable>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Remove queued message"
                onPress={() => {
                  onRemove(item.queueId);
                }}
                style={({ pressed }) => [
                  styles.queueActionButton,
                  pressed && styles.pressed,
                ]}
              >
                <Text style={styles.queueRemoveText}>remove</Text>
              </Pressable>
            </View>
          </View>
        );
      })}
    </View>
  );
}

function previewText(value: string): string {
  const compact = value.replace(/\s+/g, ' ').trim();
  return compact.length > 80 ? `${compact.slice(0, 77)}…` : compact;
}

function InboxScreen({
  authReady,
  items,
  onClear,
  onRefresh,
  onOpenSession,
  onRespond,
}: {
  authReady: boolean;
  items: AttentionItem[];
  onClear: () => void;
  onRefresh: () => Promise<void>;
  onOpenSession: (sessionId: string | null) => void;
  onRespond: (
    item: AttentionItem,
    response:
      | { kind: 'approval'; decision: 'approved' | 'denied'; note?: string }
      | { kind: 'question'; answer: string; choiceId?: string },
  ) => Promise<void>;
}) {
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const refresh = useCallback(async () => {
    setRefreshing(true);
    try {
      await onRefresh();
    } finally {
      setRefreshing(false);
    }
  }, [onRefresh]);

  const refreshControl = (
    <RefreshControl
      refreshing={refreshing}
      onRefresh={() => refresh().catch(() => undefined)}
      tintColor={palette.text}
      colors={[palette.text]}
      progressBackgroundColor={palette.bg2}
    />
  );

  const respond = async (
    item: AttentionItem,
    response:
      | { kind: 'approval'; decision: 'approved' | 'denied'; note?: string }
      | { kind: 'question'; answer: string; choiceId?: string },
  ) => {
    if (pendingId || item.responded) return;
    setPendingId(item.id);
    try {
      await onRespond(item, response);
    } finally {
      setPendingId(null);
    }
  };

  if (!authReady) {
    return <QuietCenter text="Pair in Settings" />;
  }

  if (items.length === 0) {
    return (
      <ScrollView
        style={styles.fill}
        contentContainerStyle={styles.inboxEmpty}
        refreshControl={refreshControl}
      >
        <Text style={styles.inboxEmptyTitle}>No inbox items</Text>
        <Text style={styles.inboxEmptyText}>
          New agent messages, status updates, approval requests, and questions
          will appear here.
        </Text>
      </ScrollView>
    );
  }

  return (
    <ScrollView
      style={styles.fill}
      contentContainerStyle={styles.inboxList}
      refreshControl={refreshControl}
    >
      <View style={styles.inboxHeader}>
        <Text style={styles.inboxSummary}>
          {items.length} attention item{items.length === 1 ? '' : 's'}
        </Text>
        <TextButton label="Clear" onPress={onClear} />
      </View>
      {items.map(item => (
        <Pressable
          key={item.id}
          onPress={() => onOpenSession(item.sessionId)}
          style={({ pressed }) => [
            styles.inboxItem,
            item.kind === 'approval' && styles.inboxItemApproval,
            item.kind === 'question' && styles.inboxItemQuestion,
            pressed && styles.pressed,
          ]}
        >
          <View style={styles.inboxItemTop}>
            <Text style={styles.inboxKind}>
              {attentionKindLabel(item.kind)}
            </Text>
            <Text style={styles.inboxTime}>{formatDate(item.timestamp)}</Text>
          </View>
          <Text style={styles.inboxTitle} numberOfLines={1}>
            {item.title}
          </Text>
          <Text style={styles.inboxBody} numberOfLines={3}>
            {item.body}
          </Text>
          <InboxActions
            item={item}
            pending={pendingId === item.id}
            onRespond={response =>
              respond(item, response).catch(() => undefined)
            }
          />
        </Pressable>
      ))}
    </ScrollView>
  );
}

function InboxActions({
  item,
  pending,
  onRespond,
}: {
  item: AttentionItem;
  pending: boolean;
  onRespond: (
    response:
      | { kind: 'approval'; decision: 'approved' | 'denied'; note?: string }
      | { kind: 'question'; answer: string; choiceId?: string },
  ) => void;
}) {
  if (item.responded) {
    return (
      <Text style={styles.inboxResolved}>
        responded{item.responseLabel ? ` · ${item.responseLabel}` : ''}
      </Text>
    );
  }

  if (item.kind === 'approval') {
    return (
      <View style={styles.inboxActions}>
        <InboxActionButton
          label={pending ? 'Sending…' : 'Approve'}
          variant="primary"
          disabled={pending}
          onPress={() => onRespond({ kind: 'approval', decision: 'approved' })}
        />
        <InboxActionButton
          label="Deny"
          variant="danger"
          disabled={pending}
          onPress={() => onRespond({ kind: 'approval', decision: 'denied' })}
        />
      </View>
    );
  }

  if (item.kind === 'question' && item.choices?.length) {
    return (
      <View style={styles.inboxChoiceList}>
        {item.choices.map(choice => (
          <InboxActionButton
            key={choice.id}
            label={choice.label}
            disabled={pending}
            onPress={() =>
              onRespond({
                kind: 'question',
                choiceId: choice.id,
                answer: choice.label,
              })
            }
            detail={choice.description}
          />
        ))}
      </View>
    );
  }

  return null;
}

function InboxActionButton({
  label,
  detail,
  variant = 'default',
  disabled = false,
  onPress,
}: {
  label: string;
  detail?: string;
  variant?: 'default' | 'primary' | 'danger';
  disabled?: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      disabled={disabled}
      onPress={event => {
        event.stopPropagation();
        onPress();
      }}
      style={({ pressed }) => [
        styles.inboxActionButton,
        variant === 'primary' && styles.textButtonPrimary,
        variant === 'danger' && styles.textButtonDanger,
        disabled && styles.textButtonDisabled,
        pressed && !disabled && styles.pressed,
      ]}
    >
      <Text
        style={[
          styles.inboxActionLabel,
          variant === 'primary' && styles.textButtonLabelPrimary,
          variant === 'danger' && styles.textButtonLabelDanger,
          disabled && styles.textButtonLabelDisabled,
        ]}
      >
        {label}
      </Text>
      {detail ? (
        <Text style={styles.inboxActionDetail} numberOfLines={2}>
          {detail}
        </Text>
      ) : null}
    </Pressable>
  );
}

const MessageRow = React.memo(function MessageRow({
  message,
  showDiffButton = false,
  diffLoading = false,
  onViewDiff,
}: {
  message: ChatMessage;
  showDiffButton?: boolean;
  diffLoading?: boolean;
  onViewDiff?: () => void;
}) {
  const isUser = message.role === 'user';
  const isSystem = message.role === 'system';
  const isTool = message.role === 'tool';

  if (isTool) {
    return (
      <View style={styles.progressRow}>
        <View
          style={[
            styles.progressCard,
            message.status === 'failed' && styles.progressCardError,
          ]}
        >
          {message.status === 'running' ? (
            <ActivityIndicator color={palette.muted} size="small" />
          ) : (
            <View
              style={[
                styles.progressDot,
                message.status === 'failed' && styles.progressDotError,
              ]}
            />
          )}
          <Text
            style={[
              styles.progressText,
              message.status === 'failed' && styles.progressTextError,
            ]}
            numberOfLines={2}
          >
            {message.content}
          </Text>
        </View>
      </View>
    );
  }

  return (
    <View style={[styles.messageRow, isUser && styles.messageRowUser]}>
      <View
        style={[
          styles.messageBubble,
          isUser && styles.messageBubbleUser,
          isSystem && styles.messageBubbleSystem,
        ]}
      >
        <RichMessageText content={message.content} tone={message.role} />
      </View>
      {showDiffButton ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="View changed code diff"
          onPress={onViewDiff}
          disabled={diffLoading}
          style={({ pressed }) => [
            styles.diffButton,
            isUser && styles.diffButtonUser,
            pressed && styles.pressed,
            diffLoading && styles.diffButtonDisabled,
          ]}
        >
          <Text style={styles.diffButtonText}>
            {diffLoading ? 'Loading diff…' : 'View message diff'}
          </Text>
        </Pressable>
      ) : null}
    </View>
  );
});

function DiffViewer({
  diff,
  loading,
  error,
  onClose,
  onRefresh,
}: {
  diff: DiffSummary;
  loading: boolean;
  error: string | null;
  onClose: () => void;
  onRefresh: () => void;
}) {
  const files = useMemo(
    () => parseUnifiedDiff(diff.diff, diff.stat),
    [diff.diff, diff.stat],
  );
  const [selectedFileId, setSelectedFileId] = useState<string | null>(null);
  const [fileMenuOpen, setFileMenuOpen] = useState(false);
  const { height: windowHeight } = useWindowDimensions();
  const dropdownMaxHeight = Math.max(180, windowHeight - 92);
  const selectedFile =
    files.find(file => file.id === selectedFileId) ?? files[0] ?? null;
  const totalAdditions = files.reduce((sum, file) => sum + file.additions, 0);
  const totalDeletions = files.reduce((sum, file) => sum + file.deletions, 0);
  const fallbackBody =
    diff.diff.trim() ||
    diff.stat.trim() ||
    diff.status.trim() ||
    'No code changes were captured for this message.';

  useEffect(() => {
    setSelectedFileId(files[0]?.id ?? null);
    setFileMenuOpen(false);
  }, [files]);

  return (
    <View style={styles.diffOverlay}>
      <SafeAreaView style={styles.diffSafeArea} edges={['top']}>
        <View style={styles.diffPanel}>
          <View style={styles.diffHeader}>
            <View style={styles.diffHeaderText}>
              <Text style={styles.diffTitle}>Code diff</Text>
              <Text style={styles.diffMeta} numberOfLines={1}>
                {files.length
                  ? `${files.length} file${files.length === 1 ? '' : 's'} · +${totalAdditions} -${totalDeletions}${diff.truncated ? ' · truncated' : ''}`
                  : diff.truncated
                    ? 'Truncated · message changes'
                    : 'Message changes'}
              </Text>
            </View>
            {loading ? (
              <ActivityIndicator color={palette.text} size="small" />
            ) : null}
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Refresh code diff"
              onPress={onRefresh}
              hitSlop={8}
              style={({ pressed }) => [
                styles.diffHeaderButton,
                pressed && styles.pressed,
              ]}
            >
              <Text style={styles.diffHeaderButtonText}>↻</Text>
            </Pressable>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Close code diff"
              onPress={onClose}
              hitSlop={8}
              style={({ pressed }) => [
                styles.diffHeaderButton,
                pressed && styles.pressed,
              ]}
            >
              <Text style={styles.diffHeaderButtonText}>×</Text>
            </Pressable>
          </View>
          {error ? <Text style={styles.diffError}>{error}</Text> : null}
          {selectedFile ? (
            <View style={styles.diffFileSelectorWrap}>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Select changed file"
                disabled={files.length <= 1}
                onPress={() => setFileMenuOpen(open => !open)}
                style={({ pressed }) => [
                  styles.diffFileSelector,
                  files.length <= 1 && styles.diffFileSelectorSingle,
                  pressed && files.length > 1 && styles.pressed,
                ]}
              >
                <Text style={styles.diffFileName} numberOfLines={1}>
                  {selectedFile.path}
                </Text>
                <Text style={styles.diffFileCounts}>
                  +{selectedFile.additions} -{selectedFile.deletions}
                </Text>
                {files.length > 1 ? (
                  <Text style={styles.diffDropdownIcon}>
                    {fileMenuOpen ? '⌃' : '⌄'}
                  </Text>
                ) : null}
              </Pressable>
              {fileMenuOpen && files.length > 1 ? (
                <View style={[styles.diffDropdown, { maxHeight: dropdownMaxHeight }]}>
                  <ScrollView
                    nestedScrollEnabled
                    showsVerticalScrollIndicator
                    keyboardShouldPersistTaps="handled"
                    style={styles.diffDropdownScroll}
                    contentContainerStyle={styles.diffDropdownContent}
                  >
                    {files.map(file => {
                      const selected = file.id === selectedFile.id;
                      return (
                        <Pressable
                          key={file.id}
                          accessibilityRole="button"
                          accessibilityLabel={`View diff for ${file.path}`}
                          onPress={() => {
                            setSelectedFileId(file.id);
                            setFileMenuOpen(false);
                          }}
                          style={({ pressed }) => [
                            styles.diffDropdownItem,
                            selected && styles.diffDropdownItemActive,
                            pressed && styles.pressed,
                          ]}
                        >
                          <Text
                            style={[
                              styles.diffDropdownText,
                              selected && styles.diffDropdownTextActive,
                            ]}
                            numberOfLines={1}
                          >
                            {file.path}
                          </Text>
                          <Text style={styles.diffDropdownMeta}>
                            +{file.additions} -{file.deletions}
                          </Text>
                        </Pressable>
                      );
                    })}
                  </ScrollView>
                </View>
              ) : null}
            </View>
          ) : null}
          <ScrollView
            style={styles.diffScroll}
            horizontal
            nestedScrollEnabled
            contentContainerStyle={styles.diffHorizontalContent}
          >
            <ScrollView
              nestedScrollEnabled
              style={styles.diffVerticalScroll}
              contentContainerStyle={styles.diffVerticalContent}
            >
              {selectedFile ? (
                <View style={styles.diffLineList}>
                  {selectedFile.lines.map(line => (
                    <DiffLineRow key={line.id} line={line} />
                  ))}
                </View>
              ) : (
                <Text selectable style={styles.diffCode}>
                  {fallbackBody}
                </Text>
              )}
            </ScrollView>
          </ScrollView>
        </View>
      </SafeAreaView>
    </View>
  );
}

function DiffLineRow({ line }: { line: ParsedDiffLine }) {
  return (
    <View
      style={[
        styles.diffLine,
        line.type === 'addition' && styles.diffLineAddition,
        line.type === 'deletion' && styles.diffLineDeletion,
        line.type === 'hunk' && styles.diffLineHunk,
        line.type === 'meta' && styles.diffLineMeta,
      ]}
    >
      <Text
        selectable
        style={[
          styles.diffLineText,
          line.type === 'addition' && styles.diffLineTextAddition,
          line.type === 'deletion' && styles.diffLineTextDeletion,
          line.type === 'hunk' && styles.diffLineTextHunk,
          line.type === 'meta' && styles.diffLineTextMeta,
        ]}
      >
        {line.text || ' '}
      </Text>
    </View>
  );
}

type MessageTone = ChatMessage['role'];

type MessageBlock =
  | { type: 'paragraph'; text: string }
  | { type: 'heading'; text: string; level: number }
  | { type: 'bullet'; text: string }
  | { type: 'code'; text: string };

function RichMessageText({
  content,
  tone,
}: {
  content: string;
  tone: MessageTone;
}) {
  const blocks = useMemo(() => parseMessageBlocks(content), [content]);

  return (
    <>
      {blocks.map((block, index) => (
        <MessageBlockView
          key={`${block.type}-${index}-${block.text.slice(0, 12)}`}
          block={block}
          tone={tone}
          last={index === blocks.length - 1}
        />
      ))}
    </>
  );
}

function MessageBlockView({
  block,
  tone,
  last,
}: {
  block: MessageBlock;
  tone: MessageTone;
  last: boolean;
}) {
  const textToneStyle =
    tone === 'user'
      ? styles.messageTextUser
      : tone === 'system'
        ? styles.messageTextSystem
        : tone === 'tool'
          ? styles.messageTextSystem
          : null;

  if (block.type === 'code') {
    return (
      <View style={[styles.codeBlock, last && styles.messageBlockLast]}>
        <Text style={styles.codeText}>{block.text}</Text>
      </View>
    );
  }

  if (block.type === 'heading') {
    return (
      <Text
        style={[
          styles.messageText,
          textToneStyle,
          styles.messageHeading,
          block.level <= 2 && styles.messageHeadingLarge,
          last && styles.messageBlockLast,
        ]}
      >
        {renderInlineText(block.text)}
      </Text>
    );
  }

  if (block.type === 'bullet') {
    return (
      <View style={[styles.bulletRow, last && styles.messageBlockLast]}>
        <Text style={[styles.messageText, textToneStyle, styles.bulletMarker]}>
          •
        </Text>
        <Text style={[styles.messageText, textToneStyle, styles.bulletText]}>
          {renderInlineText(block.text)}
        </Text>
      </View>
    );
  }

  return (
    <Text
      style={[styles.messageText, textToneStyle, !last && styles.messageBlock]}
    >
      {renderInlineText(block.text)}
    </Text>
  );
}

function parseMessageBlocks(content: string): MessageBlock[] {
  const lines = content.replace(/\r\n/g, '\n').split('\n');
  const blocks: MessageBlock[] = [];
  let paragraph: string[] = [];

  const flushParagraph = () => {
    const text = paragraph.join('\n').trim();
    if (text) blocks.push({ type: 'paragraph', text });
    paragraph = [];
  };

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? '';
    const fence = line.match(/^\s*```/);

    if (fence) {
      flushParagraph();
      const codeLines: string[] = [];
      index += 1;
      while (index < lines.length && !/^\s*```/.test(lines[index] ?? '')) {
        codeLines.push(lines[index] ?? '');
        index += 1;
      }
      blocks.push({ type: 'code', text: codeLines.join('\n').trimEnd() });
      continue;
    }

    if (!line.trim()) {
      flushParagraph();
      continue;
    }

    const heading = line.match(/^\s*(#{1,6})\s+(.+?)\s*#*\s*$/);
    if (heading) {
      flushParagraph();
      blocks.push({
        type: 'heading',
        level: heading[1].length,
        text: heading[2].trim(),
      });
      continue;
    }

    const bullet = line.match(/^\s*(?:[-*+]|\d+[.)])\s+(.+)$/);
    if (bullet) {
      flushParagraph();
      const itemLines = [bullet[1].trim()];
      while (index + 1 < lines.length) {
        const next = lines[index + 1] ?? '';
        if (!next.trim()) break;
        if (/^\s*(?:[-*+]|\d+[.)])\s+/.test(next)) break;
        if (/^\s*#{1,6}\s+/.test(next) || /^\s*```/.test(next)) break;
        if (!/^\s{2,}\S/.test(next)) break;
        itemLines.push(next.trim());
        index += 1;
      }
      blocks.push({ type: 'bullet', text: itemLines.join(' ') });
      continue;
    }

    paragraph.push(line);
  }

  flushParagraph();
  return blocks.length ? blocks : [{ type: 'paragraph', text: '' }];
}

function renderInlineText(text: string) {
  return text
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1')
    .split(/(`[^`\n]+`|\*\*[^*\n]+\*\*)/g)
    .filter(Boolean)
    .map((part, index) => {
      if (part.startsWith('`') && part.endsWith('`')) {
        return (
          <Text key={`${part}-${index}`} style={styles.inlineCode}>
            {part.slice(1, -1)}
          </Text>
        );
      }
      if (part.startsWith('**') && part.endsWith('**')) {
        return (
          <Text key={`${part}-${index}`} style={styles.boldText}>
            {part.slice(2, -2)}
          </Text>
        );
      }
      return part;
    });
}

function SessionsScreen({
  loading,
  authReady,
  sessions,
  usage,
  connectivity,
  error,
  attentionItems,
  activeSessionId,
  onSelect,
  onRefresh,
  onCancel,
  onDelete,
}: {
  loading: boolean;
  authReady: boolean;
  sessions: DexydSession[];
  usage: UsageStatus | null;
  connectivity: 'idle' | 'online' | 'offline' | 'error';
  error: string | null;
  attentionItems: AttentionItem[];
  activeSessionId: string | null;
  onSelect: (sessionId: string) => void;
  onRefresh: () => Promise<void>;
  onCancel: (sessionId: string) => Promise<void> | void;
  onDelete: (sessionId: string) => Promise<void> | void;
}) {
  const [showHidden, setShowHidden] = useState(false);

  if (!authReady) {
    return <QuietSpinner />;
  }

  if (loading && sessions.length === 0) {
    return <QuietSpinner />;
  }

  const refreshControl = (
    <RefreshControl
      refreshing={loading}
      onRefresh={() => onRefresh().catch(() => undefined)}
      tintColor={palette.text}
      colors={[palette.text]}
      progressBackgroundColor={palette.bg2}
    />
  );

  if (sessions.length === 0) {
    return (
      <ScrollView
        style={styles.fill}
        contentContainerStyle={styles.emptyFill}
        refreshControl={refreshControl}
      >
        <Pressable
          style={styles.emptyTapArea}
          onPress={() => onRefresh().catch(() => undefined)}
        >
          <Text style={styles.quietText}>
            No Codex sessions found. Pull or tap to refresh.
          </Text>
          {error ? <Text style={styles.errorLine}>{error}</Text> : null}
        </Pressable>
      </ScrollView>
    );
  }

  const visibleSessions = sessions.filter(
    session => !isHiddenDexydSession(session),
  );
  const hiddenSessions = sessions.filter(isHiddenDexydSession);
  const projectGroups = groupSessionsByProject(visibleSessions);
  const pendingBySession = pendingAttentionBySession(attentionItems);

  return (
    <ScrollView
      style={styles.fill}
      contentContainerStyle={styles.terminalList}
      refreshControl={refreshControl}
    >
      {connectivity === 'offline' ? (
        <Text style={styles.offlineBanner}>
          Bridge offline · showing saved sessions
        </Text>
      ) : connectivity === 'error' ? (
        <Text style={styles.errorLine}>
          Could not refresh sessions. Showing saved data.
        </Text>
      ) : null}
      {error ? <Text style={styles.errorLine}>{error}</Text> : null}
      {usage ? <SessionUsageSummary usage={usage} /> : null}
      {projectGroups.map(group => (
        <View key={group.projectPath} style={styles.sessionProjectGroup}>
          <Text style={styles.sessionProjectName} numberOfLines={1}>
            {group.projectName}
          </Text>
          <Text style={styles.sessionProjectPath} numberOfLines={1}>
            {group.sessions.length} session
            {group.sessions.length === 1 ? '' : 's'} · {group.projectPath}
          </Text>
          <Text style={styles.sessionProjectStatus} numberOfLines={1}>
            {projectStatusSummary(group.sessions, pendingBySession)}
          </Text>
          {group.sessions.map(session => (
            <SessionListRow
              key={session.id}
              session={session}
              pendingAttention={pendingBySession.get(session.id) ?? []}
              active={activeSessionId === session.id}
              onSelect={onSelect}
              onCancel={onCancel}
              onDelete={onDelete}
            />
          ))}
        </View>
      ))}
      {hiddenSessions.length > 0 ? (
        <View style={styles.hiddenSessionsBlock}>
          <Pressable
            accessibilityRole="button"
            onPress={() => setShowHidden(open => !open)}
            style={({ pressed }) => [
              styles.hiddenSessionsHeader,
              pressed && styles.pressed,
            ]}
          >
            <Text style={styles.hiddenSessionsTitle}>Hidden sessions</Text>
            <Text style={styles.hiddenSessionsCount}>
              {hiddenSessions.length} · {showHidden ? 'hide' : 'show'}
            </Text>
          </Pressable>
          {showHidden
            ? hiddenSessions.map(session => (
                <SessionListRow
                  key={session.id}
                  session={session}
                  pendingAttention={pendingBySession.get(session.id) ?? []}
                  active={activeSessionId === session.id}
                  onSelect={onSelect}
                  onCancel={onCancel}
                  onDelete={onDelete}
                />
              ))
            : null}
        </View>
      ) : null}
    </ScrollView>
  );
}

function SessionUsageSummary({ usage }: { usage: UsageStatus }) {
  const remaining = accountRemainingPercent(usage);
  const accountText = accountUsageLabel(usage);
  const tone = usage.limits.status;

  return (
    <View
      style={[
        styles.sessionUsageSummary,
        tone === 'warn' && styles.sessionUsageSummaryWarn,
        tone === 'error' && styles.sessionUsageSummaryError,
      ]}
    >
      <View style={styles.sessionUsageSummaryText}>
        <Text style={styles.sessionUsageTitle}>Account usage</Text>
        <Text style={styles.sessionUsageMeta} numberOfLines={1}>
          {accountText}
        </Text>
      </View>
      {remaining !== null ? (
        <Text style={styles.sessionUsagePercent}>
          {Math.max(0, Math.round(remaining))}% left
        </Text>
      ) : null}
    </View>
  );
}

function SessionListRow({
  session,
  pendingAttention,
  active,
  onSelect,
  onCancel,
  onDelete,
}: {
  session: DexydSession;
  pendingAttention: AttentionItem[];
  active: boolean;
  onSelect: (sessionId: string) => void;
  onCancel: (sessionId: string) => Promise<void> | void;
  onDelete: (sessionId: string) => Promise<void> | void;
}) {
  const status = sessionUiStatus(session, pendingAttention);
  const contextLabel = sessionContextLabel(session);

  return (
    <Pressable
      onPress={() => onSelect(session.id)}
      style={({ pressed }) => [
        styles.terminalRow,
        active && styles.terminalRowActive,
        pressed && styles.pressed,
      ]}
    >
      <View style={styles.terminalTextBlock}>
        <Text style={styles.terminalName} numberOfLines={1}>
          {session.title || shortId(session.id)}
        </Text>
        <Text style={styles.terminalMeta}>
          {session.omx ? 'omx' : session.source || 'codex'} ·{' '}
          {formatDate(session.updatedAt)}
          {contextLabel ? ` · ${contextLabel}` : ''}
        </Text>
      </View>
      <View style={styles.sessionActions}>
        <View
          style={[
            styles.sessionStatusPill,
            status.kind === 'ok' && styles.sessionStatusOk,
            status.kind === 'warn' && styles.sessionStatusWarn,
            status.kind === 'error' && styles.sessionStatusError,
          ]}
        >
          <View
            style={[
              styles.sessionStatusDot,
              { backgroundColor: statusColor(status.kind) },
            ]}
          />
          <Text style={styles.sessionStatusText}>{status.label}</Text>
        </View>
        {session.status === 'running' ? (
          <Pressable
            onPress={event => {
              event.stopPropagation();
              onCancel(session.id);
            }}
            hitSlop={10}
          >
            <Text style={styles.stopText}>stop</Text>
          </Pressable>
        ) : null}
        <Pressable
          onPress={event => {
            event.stopPropagation();
            onDelete(session.id);
          }}
          hitSlop={10}
        >
          <Text style={styles.deleteText}>delete</Text>
        </Pressable>
      </View>
    </Pressable>
  );
}

function isHiddenDexydSession(session: DexydSession): boolean {
  return (
    session.profile === 'dexyd-help' ||
    session.workspacePath.includes('.dexyd-help')
  );
}

function sessionContextLabel(session: DexydSession): string | null {
  const context = session.usageContext;
  if (!context) return null;
  if (context.percent !== null && context.percent !== undefined) {
    return `ctx ${context.percent}%`;
  }
  if (context.usedTokens !== null && context.usedTokens !== undefined) {
    return `ctx ${formatCompactNumber(context.usedTokens)}`;
  }
  return null;
}

function groupSessionsByProject(sessions: DexydSession[]) {
  const groups = new Map<string, DexydSession[]>();
  for (const session of sessions) {
    const key = session.workspacePath || 'unknown project';
    groups.set(key, [...(groups.get(key) ?? []), session]);
  }

  return Array.from(groups.entries())
    .map(([projectPath, items]) => ({
      projectPath,
      projectName: projectNameFromPath(projectPath),
      sessions: items.sort(
        (a, b) =>
          new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime(),
      ),
    }))
    .sort((a, b) => {
      const latestA = new Date(a.sessions[0]?.updatedAt ?? 0).getTime();
      const latestB = new Date(b.sessions[0]?.updatedAt ?? 0).getTime();
      return latestB - latestA || a.projectName.localeCompare(b.projectName);
    });
}

function pendingAttentionBySession(
  items: AttentionItem[],
): Map<string, AttentionItem[]> {
  const grouped = new Map<string, AttentionItem[]>();
  for (const item of items) {
    if (!item.sessionId || item.responded) continue;
    const current = grouped.get(item.sessionId) ?? [];
    grouped.set(item.sessionId, [...current, item]);
  }
  return grouped;
}

function sessionUiStatus(
  session: DexydSession,
  pendingAttention: AttentionItem[],
): SessionUiStatus {
  const waiting = pendingAttention.find(
    item => item.kind === 'approval' || item.kind === 'question',
  );
  if (waiting) {
    return {
      label: waiting.kind === 'approval' ? 'approval' : 'question',
      detail: 'waiting for input',
      kind: 'warn',
    };
  }

  if (session.status === 'failed') {
    return { label: 'error', detail: 'needs attention', kind: 'error' };
  }

  if (session.status === 'running') {
    return { label: 'busy', detail: 'agent active', kind: 'ok' };
  }

  if (session.status === 'cancelled') {
    return { label: 'stopped', detail: 'cancelled', kind: 'idle' };
  }

  if (session.status === 'completed') {
    return { label: 'done', detail: 'completed', kind: 'idle' };
  }

  return { label: 'idle', detail: session.status, kind: 'idle' };
}

function projectStatusSummary(
  sessions: DexydSession[],
  pendingBySession: Map<string, AttentionItem[]>,
): string {
  const counts = new Map<string, number>();
  for (const session of sessions) {
    const status = sessionUiStatus(
      session,
      pendingBySession.get(session.id) ?? [],
    );
    counts.set(status.label, (counts.get(status.label) ?? 0) + 1);
  }

  const order = [
    'approval',
    'question',
    'error',
    'busy',
    'idle',
    'done',
    'stopped',
  ];
  const parts = order
    .map(label => {
      const count = counts.get(label) ?? 0;
      return count ? `${count} ${label}` : null;
    })
    .filter(Boolean);

  return parts.join(' · ') || 'all idle';
}

function buildProjectOptions(
  projects: ProjectBrowseResponse | null,
  sessions: DexydSession[],
  addedProjects: ProjectOption[],
  removedProjectPaths: string[],
): ProjectOption[] {
  const removed = new Set(removedProjectPaths);
  const options = new Map<string, ProjectOption>();

  if (projects) {
    options.set('.', {
      path: '.',
      label: projectNameFromPath(projects.rootPath),
      detail: projects.rootPath,
    });
  }

  for (const project of addedProjects) {
    if (!removed.has(project.path)) options.set(project.path, project);
  }

  for (const session of sessions) {
    if (
      !session.workspacePath ||
      options.has(session.workspacePath) ||
      removed.has(session.workspacePath) ||
      isHiddenDexydSession(session)
    )
      continue;
    options.set(session.workspacePath, {
      path: session.workspacePath,
      label: projectNameFromPath(session.workspacePath),
      detail: session.workspacePath,
    });
  }

  if (options.size === 0) {
    options.set('.', {
      path: '.',
      label: 'Workspace',
      detail: 'workspace root',
    });
  }

  return [...options.values()].sort((a, b) => {
    if (a.path === '.') return -1;
    if (b.path === '.') return 1;
    return a.label.localeCompare(b.label);
  });
}

function projectOptionFromBrowse(
  projects: ProjectBrowseResponse,
): ProjectOption {
  const path = projects.currentPath || '.';
  return {
    path,
    label: projectNameFromPath(projects.currentPath || projects.rootPath),
    detail: projects.absolutePath,
  };
}

function upsertProjectOption(
  current: ProjectOption[],
  next: ProjectOption,
): ProjectOption[] {
  return [next, ...current.filter(project => project.path !== next.path)].slice(
    0,
    20,
  );
}

function projectNameFromPath(projectPath: string): string {
  const parts = projectPath.split('/').filter(Boolean);
  return parts.at(-1) || projectPath;
}

function SettingsScreen({
  auth,
  bridgeSettings,
  bridgeHealth,
  refreshHealth,
  scannerOpen,
  setScannerOpen,
  socketState,
  socketError,
  sessionsCount,
  devices,
  usage,
  codexAuth,
  errorHistory,
  onClearErrorHistory,
  onFullReset,
}: {
  auth: ReturnType<typeof useAuth>;
  bridgeSettings: ReturnType<typeof useBridgeSettings>;
  bridgeHealth: string;
  refreshHealth: (bridgeUrl?: string) => Promise<void>;
  scannerOpen: boolean;
  setScannerOpen: (open: boolean) => void;
  socketState: string;
  socketError: string | null;
  sessionsCount: number;
  devices: ReturnType<typeof useDevices>;
  usage: ReturnType<typeof useUsageStatus>;
  codexAuth: ReturnType<typeof useCodexAuth>;
  errorHistory: ErrorHistoryItem[];
  onClearErrorHistory: () => void;
  onFullReset: () => Promise<void>;
}) {
  const [deviceLabel, setDeviceLabel] = useState('phone');
  const [pairingUri, setPairingUri] = useState('');
  const [pairing, setPairing] = useState(false);
  const [showManualConnection, setShowManualConnection] = useState(false);
  const [showManualPairing, setShowManualPairing] = useState(false);
  const [showTrustedDevices, setShowTrustedDevices] = useState(true);
  const [showDiagnostics, setShowDiagnostics] = useState(false);
  const [activePane, setActivePane] = useState<SettingsPaneKey | null>(null);
  useEffect(() => {
    if (Platform.OS !== 'android' || !activePane) return undefined;
    const subscription = BackHandler.addEventListener(
      'hardwareBackPress',
      () => {
        setActivePane(null);
        return true;
      },
    );
    return () => subscription.remove();
  }, [activePane]);

  const pair = async (value: string) => {
    const trimmed = value.trim();
    if (!trimmed || pairing) return;

    setPairing(true);
    try {
      const pairedBridgeUrl = await auth.pairFromUri(
        trimmed,
        deviceLabel.trim() || 'phone',
      );
      setPairingUri('');
      setScannerOpen(false);
      await refreshHealth(pairedBridgeUrl);
      await devices.refresh();
    } catch (err) {
      auth.setError(errorMessage(err, 'pairing failed'));
    } finally {
      setPairing(false);
    }
  };

  const save = async () => {
    const ok = await bridgeSettings.saveBridgeUrl();
    if (ok) await refreshHealth();
  };

  const resetBridge = async () => {
    const ok = await bridgeSettings.resetBridgeUrl();
    if (ok) await refreshHealth();
  };

  const connectionTone =
    bridgeHealth === 'ready' || bridgeHealth === 'ok'
      ? 'ok'
      : bridgeHealth === 'degraded' || bridgeHealth === 'checking'
        ? 'warn'
        : 'error';
  const authTone = auth.auth ? 'ok' : 'warn';
  const realtimeTone =
    socketState === 'open'
      ? 'ok'
      : socketState === 'polling'
        ? 'warn'
        : auth.auth
          ? 'error'
          : 'idle';
  const errors = [
    bridgeSettings.error,
    auth.error,
    devices.error,
    socketError,
  ].filter(Boolean) as string[];

  const settingsPanes: SettingsPane[] = [
    {
      key: 'connection',
      icon: '⌁',
      title: 'Connection',
      subtitle: 'Bridge address used for API and realtime traffic.',
      detail: bridgeSettings.bridgeUrl || 'not configured',
      tone: connectionTone,
    },
    {
      key: 'pairing',
      icon: '◇',
      title: 'Pairing',
      subtitle: 'Connect this phone to the selected bridge.',
      detail: auth.auth ? 'phone paired' : 'scan QR or paste URI',
      tone: authTone,
    },
    {
      key: 'account',
      icon: '%',
      title: 'Account & usage',
      subtitle: 'Codex account and account usage limits.',
      detail: accountPaneDetail(codexAuth.status, usage.usage),
      tone:
        usage.usage?.limits.status === 'error'
          ? 'error'
          : usage.usage?.limits.status === 'warn'
            ? 'warn'
            : codexAuth.status?.installed === false
              ? 'warn'
              : 'ok',
    },
    {
      key: 'security',
      icon: '◈',
      title: 'Security',
      subtitle: 'Local credentials and trusted devices.',
      detail: auth.auth
        ? `${devices.devices.length} trusted device${devices.devices.length === 1 ? '' : 's'}`
        : 'not paired',
      tone: auth.auth ? 'ok' : 'idle',
    },
    {
      key: 'workspace',
      icon: '▦',
      title: 'Workspace',
      subtitle: 'Codex/OMX session overview.',
      detail: `${sessionsCount} session${sessionsCount === 1 ? '' : 's'}`,
      tone: sessionsCount > 0 ? 'ok' : 'idle',
    },
    {
      key: 'history',
      icon: '!',
      title: 'Error history',
      subtitle: 'Recent warnings and errors without repeated popups.',
      detail:
        errorHistory.length === 0
          ? 'no recent issues'
          : `${errorHistory.length} event${errorHistory.length === 1 ? '' : 's'}`,
      tone: errorHistory.some(item => item.level === 'error')
        ? 'error'
        : errorHistory.length
          ? 'warn'
          : 'idle',
    },
    {
      key: 'diagnostics',
      icon: '⌬',
      title: 'Diagnostics',
      subtitle: 'State useful when pairing or realtime fails.',
      detail:
        errors.length === 0
          ? 'no current errors'
          : `${errors.length} error${errors.length === 1 ? '' : 's'}`,
      tone: errors.length === 0 ? 'idle' : 'error',
    },
  ];
  const selectedPane =
    settingsPanes.find(pane => pane.key === activePane) ?? null;

  const renderSelectedPane = () => {
    switch (selectedPane?.key) {
      case 'connection':
        return (
          <SettingsSection
            title="Connection"
            subtitle="Bridge address used for API and realtime traffic."
          >
            <StatusRow
              label="Bridge"
              value={bridgeHealth}
              tone={connectionTone}
            />
            <StatusRow
              label="Realtime"
              value={socketState}
              tone={realtimeTone}
            />
            <SettingLine
              label="Active URL"
              value={bridgeSettings.bridgeUrl || 'not configured'}
            />
            <BridgeProfilesPanel bridgeSettings={bridgeSettings} />
            <ToggleRow
              label="Manual URL"
              value={showManualConnection}
              onValueChange={setShowManualConnection}
              detail="Edit only when not using QR pairing."
            />
            {showManualConnection ? (
              <LabeledInput
                label="Bridge URL"
                value={bridgeSettings.draftBridgeUrl}
                onChangeText={bridgeSettings.setDraftBridgeUrl}
                placeholder="https://dexyd.example.com"
                keyboardType="url"
              />
            ) : null}
            <View style={styles.settingsActions}>
              <TextButton
                label="Save"
                variant="primary"
                onPress={() => save().catch(() => undefined)}
              />
              <TextButton
                label="Check"
                onPress={() => refreshHealth().catch(() => undefined)}
              />
              <TextButton
                label="Reset"
                onPress={() => resetBridge().catch(() => undefined)}
              />
            </View>
            <Text style={styles.settingHint}>
              Pairing QR codes from the TUI set this automatically. For
              Cloudflare, set up the named tunnel first, then scan the QR.
            </Text>
          </SettingsSection>
        );

      case 'pairing':
        return (
          <SettingsSection
            title="Pairing"
            subtitle="Connect this phone to the currently selected bridge."
          >
            <StatusRow
              label="Phone"
              value={auth.auth ? 'paired' : 'not paired'}
              tone={authTone}
            />
            <LabeledInput
              label="Device label"
              value={deviceLabel}
              onChangeText={setDeviceLabel}
              placeholder="phone"
              autoCapitalize="none"
            />
            <ToggleRow
              label="Paste URI"
              value={showManualPairing}
              onValueChange={setShowManualPairing}
              detail="Use this if the scanner cannot read the QR."
            />
            {showManualPairing ? (
              <LabeledInput
                label="Pairing URI"
                value={pairingUri}
                onChangeText={setPairingUri}
                placeholder="Paste dexyd://pair..."
                autoCapitalize="none"
                multiline
              />
            ) : null}
            <View style={styles.settingsActions}>
              <TextButton
                label={pairing ? 'Pairing…' : 'Scan QR'}
                variant="primary"
                onPress={() => setScannerOpen(true)}
              />
              {showManualPairing ? (
                <TextButton
                  label="Pair pasted"
                  disabled={!pairingUri.trim() || pairing}
                  onPress={() => pair(pairingUri).catch(() => undefined)}
                />
              ) : null}
            </View>
          </SettingsSection>
        );

      case 'account':
        return (
          <SettingsSection
            title="Account & usage"
            subtitle="Codex identity and current session usage limits."
          >
            <UsagePanel
              usage={usage.usage}
              loading={usage.loading}
              onRefresh={usage.refresh}
            />
            <CodexAuthPanel codexAuth={codexAuth} />
          </SettingsSection>
        );

      case 'security':
        return (
          <SettingsSection
            title="Account & security"
            subtitle="Local device credentials and trusted devices."
          >
            <StatusRow
              label="Device ID"
              value={auth.auth ? shortId(auth.auth.deviceId) : 'none'}
              tone={auth.auth ? 'ok' : 'idle'}
            />
            <StatusRow
              label="Access token"
              value={
                auth.auth
                  ? `expires ${formatDate(auth.auth.accessExpiresAt)}`
                  : 'none'
              }
              tone={auth.auth ? 'ok' : 'idle'}
            />
            <StatusRow
              label="Refresh token"
              value={
                auth.auth
                  ? `expires ${formatDate(auth.auth.refreshExpiresAt)}`
                  : 'none'
              }
              tone={auth.auth ? 'ok' : 'idle'}
            />
            <View style={styles.settingsActions}>
              {auth.auth ? (
                <TextButton
                  label="Refresh token"
                  variant="primary"
                  onPress={() => auth.refresh().catch(() => undefined)}
                />
              ) : null}
              {auth.auth ? (
                <TextButton
                  label="Sign out"
                  variant="danger"
                  onPress={() => auth.signOut().catch(() => undefined)}
                />
              ) : null}
              {auth.auth ? (
                <TextButton
                  label="Reload devices"
                  onPress={() => devices.refresh().catch(() => undefined)}
                />
              ) : null}
            </View>
            {auth.auth ? (
              <ToggleRow
                label="Trusted devices"
                value={showTrustedDevices}
                onValueChange={setShowTrustedDevices}
                detail={`${devices.devices.length} device${devices.devices.length === 1 ? '' : 's'} registered`}
              />
            ) : null}
            {auth.auth && showTrustedDevices ? (
              devices.loading ? (
                <ActivityIndicator color={palette.text} size="small" />
              ) : devices.devices.length === 0 ? (
                <Text style={styles.settingHint}>
                  No trusted devices returned by the bridge.
                </Text>
              ) : (
                devices.devices.map(device => (
                  <View key={device.id} style={styles.deviceRow}>
                    <View style={styles.deviceTextBlock}>
                      <Text style={styles.deviceName} numberOfLines={1}>
                        {device.label}
                      </Text>
                      <Text style={styles.deviceMeta}>
                        {device.trustState} · {shortId(device.id)}
                      </Text>
                      <Text style={styles.deviceMeta}>
                        last seen{' '}
                        {device.lastSeenAt
                          ? formatDate(device.lastSeenAt)
                          : 'never'}
                      </Text>
                    </View>
                    {device.id !== auth.auth?.deviceId ? (
                      <Pressable
                        onPress={() =>
                          devices.revoke(device.id).catch(() => undefined)
                        }
                        hitSlop={10}
                      >
                        <Text style={styles.stopText}>revoke</Text>
                      </Pressable>
                    ) : (
                      <Text style={styles.currentDeviceText}>this phone</Text>
                    )}
                  </View>
                ))
              )
            ) : null}
          </SettingsSection>
        );

      case 'workspace':
        return (
          <SettingsSection
            title="Workspace"
            subtitle="Session overview from this bridge."
          >
            <StatusRow
              label="Sessions"
              value={String(sessionsCount)}
              tone={sessionsCount > 0 ? 'ok' : 'idle'}
            />
            <Text style={styles.settingHint}>
              Refresh and select Codex/OMX sessions from Sessions. Chat resumes
              the selected Codex session.
            </Text>
          </SettingsSection>
        );

      case 'history':
        return (
          <SettingsSection
            title="Error history"
            subtitle="Repeated connection failures are stored here and shown as status after the first alert."
          >
            <View style={styles.settingsActions}>
              <TextButton
                label="Clear history"
                onPress={onClearErrorHistory}
                disabled={errorHistory.length === 0}
              />
            </View>
            {errorHistory.length === 0 ? (
              <Text style={styles.settingHint}>
                No warnings or errors recorded.
              </Text>
            ) : (
              errorHistory.map(item => (
                <View key={item.id} style={styles.historyItem}>
                  <View style={styles.historyTopRow}>
                    <Text
                      style={[
                        styles.historyLevel,
                        item.level === 'error'
                          ? styles.historyError
                          : styles.historyWarning,
                      ]}
                    >
                      {item.level}
                    </Text>
                    <Text style={styles.historyTime}>
                      {formatDate(item.timestamp)}
                    </Text>
                  </View>
                  <Text style={styles.historyTitle}>{item.title}</Text>
                  <Text style={styles.historyBody}>{item.body}</Text>
                </View>
              ))
            )}
          </SettingsSection>
        );

      case 'diagnostics':
        return (
          <SettingsSection
            title="Diagnostics"
            subtitle="Useful state when pairing or realtime fails."
          >
            <ToggleRow
              label="Raw state"
              value={showDiagnostics}
              onValueChange={setShowDiagnostics}
              detail={
                errors.length === 0
                  ? 'No current errors.'
                  : `${errors.length} error${errors.length === 1 ? '' : 's'}`
              }
            />
            {showDiagnostics ? (
              <>
                <SettingLine
                  label="HTTP"
                  value={bridgeSettings.bridgeUrl || 'not configured'}
                />
                <SettingLine
                  label="WebSocket"
                  value={bridgeSettings.wsUrl || 'not configured'}
                />
                {errors.length === 0 ? (
                  <Text style={styles.settingHint}>No current errors.</Text>
                ) : null}
                {errors.map(item => (
                  <Text key={item} style={styles.errorLine}>
                    {item}
                  </Text>
                ))}
              </>
            ) : null}
            <View style={styles.settingsActions}>
              <TextButton
                label="Full app reset"
                variant="danger"
                onPress={() => onFullReset().catch(() => undefined)}
              />
            </View>
          </SettingsSection>
        );

      default:
        return null;
    }
  };

  return (
    <View style={styles.fill}>
      {selectedPane ? (
        <ScrollView
          style={styles.fill}
          contentContainerStyle={styles.settingsContent}
          keyboardShouldPersistTaps="handled"
        >
          <SettingsSubHeader
            pane={selectedPane}
            onBack={() => setActivePane(null)}
          />
          {renderSelectedPane()}
          <SettingsAppInfo
            bridgeHealth={bridgeHealth}
            socketState={socketState}
            sessionsCount={sessionsCount}
          />
        </ScrollView>
      ) : (
        <ScrollView
          style={styles.fill}
          contentContainerStyle={styles.settingsMenuContent}
          keyboardShouldPersistTaps="handled"
        >
          <View style={styles.settingsMenuHeader}>
            <Text style={styles.settingsMenuTitle}>Settings</Text>
            <Text style={styles.settingsMenuSubtitle}>
              Choose a section to configure the bridge and app.
            </Text>
          </View>
          {settingsPanes.map(pane => (
            <SettingsMenuCard
              key={pane.key}
              pane={pane}
              onPress={() => setActivePane(pane.key)}
            />
          ))}
          <SettingsAppInfo
            bridgeHealth={bridgeHealth}
            socketState={socketState}
            sessionsCount={sessionsCount}
          />
        </ScrollView>
      )}

      <QrScannerModal
        visible={scannerOpen}
        onClose={() => setScannerOpen(false)}
        onScanned={value => pair(value).catch(() => undefined)}
      />
    </View>
  );
}

function SettingsSection({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle?: string;
  children: React.ReactNode;
}) {
  return (
    <View style={styles.settingsSection}>
      <Text style={styles.settingsSectionTitle}>{title}</Text>
      {subtitle ? (
        <Text style={styles.settingsSectionSubtitle}>{subtitle}</Text>
      ) : null}
      {children}
    </View>
  );
}

function SettingsMenuCard({
  pane,
  onPress,
}: {
  pane: SettingsPane;
  onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`Open ${pane.title} settings`}
      onPress={onPress}
      style={({ pressed }) => [
        styles.settingsMenuCard,
        pressed && styles.pressed,
      ]}
    >
      <View style={styles.settingsMenuIcon}>
        <Text style={styles.settingsMenuIconText}>{pane.icon}</Text>
      </View>
      <View style={styles.settingsMenuText}>
        <View style={styles.settingsMenuRow}>
          <Text style={styles.settingsMenuCardTitle}>{pane.title}</Text>
        </View>
        <Text style={styles.settingsMenuCardSubtitle} numberOfLines={1}>
          {pane.subtitle}
        </Text>
        <Text style={styles.settingsMenuCardDetail} numberOfLines={1}>
          {pane.detail}
        </Text>
      </View>
      <Text style={styles.settingsMenuChevron}>›</Text>
    </Pressable>
  );
}

function SettingsSubHeader({
  pane,
  onBack,
}: {
  pane: SettingsPane;
  onBack: () => void;
}) {
  return (
    <View style={styles.settingsSubHeader}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Back to settings"
        onPress={onBack}
        hitSlop={10}
        style={({ pressed }) => [
          styles.settingsBackButton,
          pressed && styles.pressed,
        ]}
      >
        <Text style={styles.settingsBackText}>‹</Text>
      </Pressable>
      <View style={styles.settingsSubIcon}>
        <Text style={styles.settingsSubIconText}>{pane.icon}</Text>
      </View>
      <View style={styles.settingsSubText}>
        <Text style={styles.settingsSubTitle}>{pane.title}</Text>
        <Text style={styles.settingsSubSubtitle} numberOfLines={1}>
          {pane.subtitle}
        </Text>
      </View>
    </View>
  );
}

function BridgeProfilesPanel({
  bridgeSettings,
}: {
  bridgeSettings: ReturnType<typeof useBridgeSettings>;
}) {
  if (bridgeSettings.bridges.length === 0) {
    return (
      <Text style={styles.settingHint}>
        No saved bridge profiles yet. Pair with a bridge to save it here.
      </Text>
    );
  }
  return (
    <View style={styles.inlinePanel}>
      <Text style={styles.inlinePanelTitle}>Saved PCs</Text>
      {bridgeSettings.bridges.map(bridge => (
        <Pressable
          key={bridge.id}
          onPress={() =>
            bridgeSettings.switchBridge(bridge.id).catch(() => undefined)
          }
          style={({ pressed }) => [
            styles.accountRow,
            bridge.id === bridgeSettings.activeBridgeId &&
              styles.accountRowActive,
            pressed && styles.pressed,
          ]}
        >
          <View style={styles.accountTextBlock}>
            <Text style={styles.deviceName} numberOfLines={1}>
              {bridge.label}
            </Text>
            <Text style={styles.deviceMeta} numberOfLines={1}>
              {bridge.bridgeUrl}
            </Text>
          </View>
          <Text
            style={
              bridge.id === bridgeSettings.activeBridgeId
                ? styles.currentDeviceText
                : styles.projectRefresh
            }
          >
            {bridge.id === bridgeSettings.activeBridgeId ? 'active' : 'switch'}
          </Text>
        </Pressable>
      ))}
    </View>
  );
}

function UsagePanel({
  usage,
  loading,
  onRefresh,
}: {
  usage: UsageStatus | null;
  loading: boolean;
  onRefresh: () => Promise<void>;
}) {
  const tone = usage?.limits.status ?? 'unknown';
  return (
    <View style={styles.inlinePanel}>
      <View style={styles.inlinePanelHeader}>
        <Text style={styles.inlinePanelTitle}>Usage</Text>
        <TextButton
          label={loading ? 'Checking…' : 'Refresh'}
          onPress={() => onRefresh().catch(() => undefined)}
          disabled={loading}
        />
      </View>
      <StatusRow
        label="Context"
        value={
          usage?.context.percent !== null &&
          usage?.context.percent !== undefined
            ? `${usage.context.percent}% (${formatCompactNumber(usage.context.usedTokens ?? 0)} / ${formatCompactNumber(usage.context.windowTokens ?? 0)})`
            : usage?.context.usedTokens !== null &&
                usage?.context.usedTokens !== undefined
              ? `${formatCompactNumber(usage.context.usedTokens)} tokens`
              : 'unknown'
        }
        tone={usage?.context.percent === null ? 'idle' : 'ok'}
      />
      <StatusRow
        label="Limits"
        value={usage?.limits.label ?? 'unknown'}
        tone={usageStatusTone(usage?.limits.status)}
      />
      {usage?.limits.detail ? (
        <Text style={styles.settingHint}>{usage.limits.detail}</Text>
      ) : null}
      <View
        style={[
          styles.usageMeter,
          tone === 'warn' && styles.usageMeterWarn,
          tone === 'error' && styles.usageMeterError,
        ]}
      >
        <View
          style={[
            styles.usageMeterFill,
            {
              width: `${Math.min(100, Math.max(0, usage?.context.percent ?? 0))}%`,
            },
            tone === 'warn' && styles.usageMeterFillWarn,
            tone === 'error' && styles.usageMeterFillError,
          ]}
        />
      </View>
    </View>
  );
}

function CodexAuthPanel({
  codexAuth,
}: {
  codexAuth: ReturnType<typeof useCodexAuth>;
}) {
  const status = codexAuth.status;

  return (
    <View style={styles.inlinePanel}>
      <View style={styles.inlinePanelHeader}>
        <Text style={styles.inlinePanelTitle}>Codex account</Text>
        <TextButton
          label={codexAuth.loading ? 'Loading…' : 'Reload'}
          onPress={() => codexAuth.refresh().catch(() => undefined)}
          disabled={codexAuth.loading}
        />
      </View>
      {!status ? (
        <Text style={styles.settingHint}>
          Account status has not loaded yet.
        </Text>
      ) : status.installed ? (
        <>
          <StatusRow
            label="Active"
            value={status.activeAccount?.label ?? 'none'}
            tone={status.activeAccount ? 'ok' : 'warn'}
          />
          <StatusRow
            label="Auto switch"
            value={status.autoSwitch}
            tone={status.autoSwitch === 'ON' ? 'ok' : 'idle'}
          />
          <StatusRow
            label="Usage API"
            value={status.usageApi}
            tone={
              status.usageApi === 'api' || status.usageApi === 'ON'
                ? 'ok'
                : 'warn'
            }
          />
          {status.accounts.length === 0 ? (
            <Text style={styles.settingHint}>
              No codex-auth accounts found.
            </Text>
          ) : (
            status.accounts.map(account => (
              <Pressable
                key={`${account.index}-${account.label}`}
                disabled={account.active || Boolean(codexAuth.switching)}
                onPress={() =>
                  codexAuth.switchAccount(account.index).catch(() => undefined)
                }
                style={({ pressed }) => [
                  styles.accountRow,
                  account.active && styles.accountRowActive,
                  pressed && styles.pressed,
                ]}
              >
                <View style={styles.accountTextBlock}>
                  <Text style={styles.deviceName} numberOfLines={1}>
                    {account.active ? '● ' : ''}
                    {account.label}
                  </Text>
                  <Text style={styles.deviceMeta} numberOfLines={1}>
                    {account.plan} · 5h {account.usage5h} · weekly{' '}
                    {account.usageWeekly}
                  </Text>
                </View>
                <Text
                  style={
                    account.active
                      ? styles.currentDeviceText
                      : styles.projectRefresh
                  }
                >
                  {account.active
                    ? 'active'
                    : codexAuth.switching === account.index
                      ? 'switching…'
                      : 'switch'}
                </Text>
              </Pressable>
            ))
          )}
        </>
      ) : (
        <>
          <StatusRow label="codex-auth" value="not installed" tone="warn" />
          <Text style={styles.settingHint}>{status.installHint}</Text>
        </>
      )}
      {codexAuth.error || status?.error ? (
        <Text style={styles.errorLine}>{codexAuth.error || status?.error}</Text>
      ) : null}
    </View>
  );
}

function usageStatusTone(
  status: UsageStatus['status'] | undefined,
): StatusKind {
  if (status === 'ok' || status === 'warn' || status === 'error') return status;
  return 'idle';
}

function accountPaneDetail(
  status: CodexAuthStatus | null,
  usage: UsageStatus | null,
): string {
  const account =
    status?.activeAccount?.label ??
    (status?.installed === false ? 'codex-auth missing' : 'account unknown');
  const usageText = usage ? usageSummary(usage) : 'usage unknown';
  return `${account} · ${usageText}`;
}

function SettingsAppInfo({
  bridgeHealth,
  socketState,
  sessionsCount,
}: {
  bridgeHealth: string;
  socketState: string;
  sessionsCount: number;
}) {
  return (
    <View style={styles.settingsAppInfo}>
      <Text style={styles.settingsAppInfoText}>dexyd mobile</Text>
      <Text style={styles.settingsAppInfoSubtext}>
        bridge {bridgeHealth} · realtime {socketState} · {sessionsCount} session
        {sessionsCount === 1 ? '' : 's'}
      </Text>
    </View>
  );
}

function LabeledInput({
  label,
  ...props
}: { label: string } & React.ComponentProps<typeof TextInput>) {
  return (
    <View style={styles.inputGroup}>
      <Text style={styles.inputLabel}>{label}</Text>
      <TextInput
        {...props}
        placeholderTextColor={palette.dim}
        autoCorrect={props.autoCorrect ?? false}
        style={[
          styles.input,
          props.multiline && styles.inputMultiline,
          props.style,
        ]}
      />
    </View>
  );
}

function StatusRow({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone: StatusKind;
}) {
  return (
    <View style={styles.settingRow}>
      <Text style={styles.settingLabel}>{label}</Text>
      <View style={styles.settingValueWrap}>
        <View
          style={[
            styles.statusDotSmall,
            { backgroundColor: statusColor(tone) },
          ]}
        />
        <Text style={styles.settingValue} numberOfLines={1}>
          {value}
        </Text>
      </View>
    </View>
  );
}

function SettingLine({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.settingRow}>
      <Text style={styles.settingLabel}>{label}</Text>
      <Text style={styles.settingValueWide} numberOfLines={2}>
        {value}
      </Text>
    </View>
  );
}

function attentionItemFromEvent(
  event: EventEnvelope | null,
  sessions: DexydSession[],
): AttentionItem | null {
  if (!event) return null;
  const eventType = event.eventType.toLowerCase();
  const payload = (event.payload ?? {}) as Record<string, unknown>;
  const session = event.sessionId
    ? sessions.find(item => item.id === event.sessionId)
    : null;
  const sessionTitle = session?.title || session?.workspacePath || 'Session';
  const body = attentionBody(payload);
  const requestId = interactionRequestId(payload, event);

  if (eventType === 'chat.message.assistant') {
    return {
      id: `message-${event.sequence}`,
      requestId,
      kind: 'message',
      title: `New message · ${sessionTitle}`,
      body,
      timestamp: event.timestamp,
      sessionId: event.sessionId,
    };
  }

  if (eventType === 'chat.turn.started') {
    return {
      id: `update-${event.sequence}`,
      requestId,
      kind: 'update',
      title: `Agent started · ${sessionTitle}`,
      body: body || 'Codex is working.',
      timestamp: event.timestamp,
      sessionId: event.sessionId,
    };
  }

  if (eventType === 'chat.turn.failed' || eventType === 'chat.turn.cancelled') {
    return {
      id: `update-${event.sequence}`,
      requestId,
      kind: 'update',
      title:
        eventType === 'chat.turn.failed'
          ? `Agent failed · ${sessionTitle}`
          : `Agent cancelled · ${sessionTitle}`,
      body,
      timestamp: event.timestamp,
      sessionId: event.sessionId,
    };
  }

  if (eventType.includes('approval')) {
    return {
      id: `approval-${event.sequence}`,
      requestId,
      kind: 'approval',
      title: attentionTitle(payload, `Approval request · ${sessionTitle}`),
      body,
      timestamp: event.timestamp,
      sessionId: event.sessionId,
    };
  }

  if (eventType.includes('question')) {
    return {
      id: `question-${event.sequence}`,
      requestId,
      kind: 'question',
      title: attentionTitle(payload, `Agent question · ${sessionTitle}`),
      body,
      timestamp: event.timestamp,
      sessionId: event.sessionId,
      choices: attentionChoices(payload),
    };
  }

  if (eventType.includes('notification') || eventType.includes('update')) {
    return {
      id: `update-${event.sequence}`,
      requestId,
      kind: 'update',
      title: attentionTitle(payload, `Update · ${sessionTitle}`),
      body,
      timestamp: event.timestamp,
      sessionId: event.sessionId,
    };
  }

  return null;
}

function notificationFromAttention(item: AttentionItem): SystemNotification {
  const kind: SystemNotificationKind =
    item.kind === 'message'
      ? 'response'
      : item.kind === 'approval'
        ? 'approval'
        : item.kind === 'question'
          ? 'question'
          : item.title.toLowerCase().includes('failed')
            ? 'alert'
            : 'response';

  return {
    id: `notice-${item.id}`,
    kind,
    title: item.title,
    body: item.body,
    timestamp: item.timestamp,
    sessionId: item.sessionId,
  };
}

function notificationIcon(kind: SystemNotificationKind): string {
  if (kind === 'alert') return '!';
  if (kind === 'approval') return '✓';
  if (kind === 'question') return '?';
  if (kind === 'usage') return '%';
  return '•';
}

function interactionResponseFromEvent(
  event: EventEnvelope | null,
): { requestId: string; label: string } | null {
  if (!event) return null;
  const eventType = event.eventType.toLowerCase();
  if (
    eventType !== 'interaction.approval.responded' &&
    eventType !== 'interaction.question.answered'
  ) {
    return null;
  }

  const payload = (event.payload ?? {}) as Record<string, unknown>;
  const requestId =
    typeof payload.interactionId === 'string'
      ? payload.interactionId
      : typeof payload.requestId === 'string'
        ? payload.requestId
        : '';

  if (!requestId) return null;

  const label =
    typeof payload.decision === 'string'
      ? payload.decision
      : typeof payload.answer === 'string'
        ? payload.answer
        : 'sent';

  return { requestId, label };
}

function interactionRequestId(
  payload: Record<string, unknown>,
  event: EventEnvelope,
): string {
  for (const key of [
    'interactionId',
    'requestId',
    'approvalId',
    'questionId',
    'id',
  ]) {
    if (typeof payload[key] === 'string' && payload[key].trim()) {
      return payload[key].trim();
    }
  }
  return `${event.eventType}-${event.sequence}`;
}

function attentionTitle(
  payload: Record<string, unknown>,
  fallback: string,
): string {
  for (const key of ['title', 'label', 'summary']) {
    if (typeof payload[key] === 'string' && payload[key].trim()) {
      return payload[key].trim();
    }
  }
  return fallback;
}

function attentionBody(payload: Record<string, unknown>): string {
  for (const key of [
    'message',
    'content',
    'text',
    'prompt',
    'question',
    'detail',
  ]) {
    if (typeof payload[key] === 'string' && payload[key].trim()) {
      return payload[key].trim();
    }
  }
  return 'No details.';
}

function attentionChoices(payload: Record<string, unknown>): AttentionChoice[] {
  const raw = Array.isArray(payload.choices)
    ? payload.choices
    : Array.isArray(payload.options)
      ? payload.options
      : [];

  return raw
    .map((choice, index): AttentionChoice | null => {
      if (typeof choice === 'string') {
        return { id: choice || String(index), label: choice };
      }

      if (!choice || typeof choice !== 'object') {
        return null;
      }

      const item = choice as Record<string, unknown>;
      const label =
        typeof item.label === 'string'
          ? item.label
          : typeof item.title === 'string'
            ? item.title
            : typeof item.text === 'string'
              ? item.text
              : '';

      if (!label.trim()) return null;

      return {
        id:
          typeof item.id === 'string' && item.id.trim()
            ? item.id
            : String(index),
        label: label.trim(),
        ...(typeof item.description === 'string' && item.description.trim()
          ? { description: item.description.trim() }
          : {}),
      };
    })
    .filter((choice): choice is AttentionChoice => Boolean(choice));
}

function attentionKindLabel(kind: AttentionKind): string {
  if (kind === 'approval') return 'approval';
  if (kind === 'question') return 'question';
  if (kind === 'message') return 'message';
  return 'update';
}

function usageSummary(usage: UsageStatus): string {
  const context =
    usage.context.percent !== null
      ? `${usage.context.percent}% context`
      : usage.context.usedTokens !== null
        ? `${formatCompactNumber(usage.context.usedTokens)} tokens`
        : 'context unknown';
  return `${accountUsageLabel(usage)} · ${context}`;
}

function accountUsageLabel(usage: UsageStatus): string {
  const remaining = accountRemainingPercent(usage);
  if (remaining !== null) {
    return `account ${Math.max(0, Math.round(remaining))}% left`;
  }
  if (usage.limits.label && usage.limits.label !== 'limits unknown') {
    return usage.limits.label;
  }
  return 'account usage unknown';
}

function accountUsageWarningThreshold(usage: UsageStatus | null): number | null {
  const remaining = accountRemainingPercent(usage);
  if (remaining === null) return null;
  if (remaining <= 10) return 10;
  if (remaining <= 25) return 25;
  if (remaining <= 50) return 50;
  return null;
}

function accountUsageWarningBody(
  usage: UsageStatus,
  threshold: number,
): string {
  const remaining = accountRemainingPercent(usage);
  const remainingText =
    remaining === null
      ? `below ${threshold}% remaining`
      : `${Math.max(0, Math.round(remaining))}% remaining`;
  const label = usage.limits.label ? ` · ${usage.limits.label}` : '';
  return `Account usage is ${remainingText}${label}`;
}

function accountRemainingPercent(usage: UsageStatus | null): number | null {
  if (!usage) return null;
  const rawRemaining = lowestRemainingPercent(usage.limits.raw);
  if (rawRemaining !== null) return rawRemaining;
  const match = usage.limits.detail.match(/(\d+(?:\.\d+)?)%\s+remaining/i);
  if (!match) return null;
  const parsed = Number(match[1]);
  return Number.isFinite(parsed) ? parsed : null;
}

function lowestRemainingPercent(value: unknown): number | null {
  if (Array.isArray(value)) {
    return value.reduce<number | null>((lowest, item) => {
      const percent = lowestRemainingPercent(item);
      if (percent === null) return lowest;
      return lowest === null ? percent : Math.min(lowest, percent);
    }, null);
  }

  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  const usedPercent =
    numericField(record, 'used_percent') ?? numericField(record, 'usedPercentage');
  const percent =
    numericField(record, 'remaining_percent') ??
    numericField(record, 'remainingPercentage') ??
    (usedPercent !== null ? Math.max(0, 100 - usedPercent) : null);
  if (percent !== null) return percent;

  const remaining = numericField(record, 'remaining');
  const limit = numericField(record, 'limit');
  if (remaining !== null && limit !== null && limit > 0) {
    return (remaining / limit) * 100;
  }

  return Object.values(record).reduce<number | null>((lowest, item) => {
    const nested = lowestRemainingPercent(item);
    if (nested === null) return lowest;
    return lowest === null ? nested : Math.min(lowest, nested);
  }, null);
}

function numericField(
  record: Record<string, unknown>,
  key: string,
): number | null {
  const value = record[key];
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function usageSendBlockMessage(usage: UsageStatus | null): string | null {
  if (usage?.limits.status !== 'error') return null;
  const detail =
    usage.limits.detail &&
    usage.limits.detail !== 'Rate-limit telemetry is available from Codex.'
      ? usage.limits.detail
      : 'Wait for the limit to reset or switch Codex account.';
  return `Usage limit reached · ${detail}`;
}

function formatCompactNumber(value: number): string {
  if (value >= 1_000_000) return `${Math.round(value / 100_000) / 10}m`;
  if (value >= 1_000) return `${Math.round(value / 100) / 10}k`;
  return String(value);
}

function ToggleRow({
  label,
  value,
  onValueChange,
  detail,
}: {
  label: string;
  value: boolean;
  onValueChange: (value: boolean) => void;
  detail?: string;
}) {
  return (
    <Pressable
      accessibilityRole="switch"
      accessibilityState={{ checked: value }}
      onPress={() => onValueChange(!value)}
      style={({ pressed }) => [styles.toggleRow, pressed && styles.pressed]}
    >
      <View style={styles.toggleTextBlock}>
        <Text style={styles.settingLabel}>{label}</Text>
        {detail ? <Text style={styles.toggleDetail}>{detail}</Text> : null}
      </View>
      <View style={[styles.toggleTrack, value && styles.toggleTrackOn]}>
        <View style={[styles.toggleKnob, value && styles.toggleKnobOn]} />
      </View>
    </Pressable>
  );
}

function shortId(id: string): string {
  return id.length > 13 ? `${id.slice(0, 6)}…${id.slice(-4)}` : id;
}

function formatDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'unknown';
  return date.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function TextButton({
  label,
  onPress,
  variant = 'default',
  disabled = false,
}: {
  label: string;
  onPress: () => void;
  variant?: 'default' | 'primary' | 'danger';
  disabled?: boolean;
}) {
  return (
    <Pressable
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [
        styles.textButton,
        variant === 'primary' && styles.textButtonPrimary,
        variant === 'danger' && styles.textButtonDanger,
        disabled && styles.textButtonDisabled,
        pressed && !disabled && styles.pressed,
      ]}
    >
      <Text
        style={[
          styles.textButtonLabel,
          variant === 'primary' && styles.textButtonLabelPrimary,
          variant === 'danger' && styles.textButtonLabelDanger,
          disabled && styles.textButtonLabelDisabled,
        ]}
      >
        {label}
      </Text>
    </Pressable>
  );
}

function BottomTabs({
  active,
  onSelect,
}: {
  active: TabKey;
  onSelect: (tab: BottomTabKey) => void;
}) {
  return (
    <View style={styles.bottomTabs}>
      {tabs.map(tab => {
        const selected = tab.key === active;
        return (
          <Pressable
            key={tab.key}
            onPress={() => onSelect(tab.key)}
            style={({ pressed }) => [styles.tabItem, pressed && styles.pressed]}
          >
            <Text style={[styles.tabIcon, selected && styles.tabIconActive]}>
              {tab.icon}
            </Text>
            <Text style={[styles.tabLabel, selected && styles.tabLabelActive]}>
              {tab.label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

function QuietSpinner() {
  return (
    <View style={styles.emptyFill}>
      <ActivityIndicator color={palette.text} size="small" />
    </View>
  );
}

function QuietCenter({ text }: { text: string }) {
  return (
    <View style={styles.emptyFill}>
      <Text style={styles.quietText}>{text}</Text>
    </View>
  );
}

function statusColor(kind: StatusKind | 'unknown'): string {
  if (kind === 'ok') return palette.ok;
  if (kind === 'warn') return palette.warn;
  if (kind === 'error') return palette.error;
  return palette.dim;
}

const palette = {
  bg: '#1e1e1f',
  bg2: '#202021',
  line: '#2a2a2b',
  text: '#f2f2f2',
  muted: '#aaa8ae',
  dim: '#77757c',
  error: '#ff493f',
  ok: '#64d98b',
  warn: '#e1b84f',
};

const styles = StyleSheet.create({
  safe: {
    flex: 1,
    backgroundColor: palette.bg,
  },
  shell: {
    flex: 1,
    backgroundColor: palette.bg,
  },
  topBar: {
    height: 58,
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 8,
  },
  brandTextBlock: {
    position: 'absolute',
    left: 16,
    top: 12,
    minWidth: 82,
  },
  brandText: {
    color: palette.text,
    fontSize: 17,
    fontWeight: '900',
    letterSpacing: -0.3,
  },
  brandStatus: {
    marginTop: 1,
    fontSize: 11,
    fontWeight: '700',
  },
  brandMark: {
    position: 'absolute',
    left: 22,
    top: 21,
    width: 22,
    height: 22,
    alignItems: 'center',
    justifyContent: 'center',
  },
  brandDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: palette.text,
    position: 'absolute',
    top: 2,
    left: 2,
  },
  brandSlash: {
    width: 17,
    height: 2,
    borderRadius: 1,
    backgroundColor: palette.muted,
    transform: [{ rotate: '-45deg' }],
  },
  titleBlock: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  projectSelector: {
    position: 'absolute',
    left: 12,
    maxWidth: '58%',
    minWidth: 132,
    minHeight: 44,
    alignItems: 'flex-start',
    justifyContent: 'center',
    paddingHorizontal: 12,
    borderRadius: 14,
  },
  projectSelectorActive: {
    backgroundColor: '#262628',
  },
  title: {
    color: palette.text,
    fontSize: 18,
    fontWeight: '800',
    letterSpacing: -0.4,
  },
  statusLine: {
    marginTop: 2,
    flexDirection: 'row',
    alignItems: 'center',
  },
  statusDot: {
    width: 7,
    height: 7,
    borderRadius: radii.pill,
    marginRight: 7,
  },
  statusText: {
    fontSize: 12,
    fontWeight: '600',
  },
  projectChevron: {
    marginLeft: 6,
    color: palette.dim,
    fontSize: 12,
    fontWeight: '800',
  },
  usageStrip: {
    minHeight: 28,
    marginHorizontal: 12,
    marginBottom: 6,
    paddingHorizontal: 10,
    borderWidth: 1,
    borderColor: palette.line,
    borderRadius: 12,
    backgroundColor: '#202021',
    flexDirection: 'row',
    alignItems: 'center',
  },
  usageStripWarn: {
    borderColor: '#554729',
    backgroundColor: '#28251d',
  },
  usageStripError: {
    borderColor: '#5d3532',
    backgroundColor: '#2a2221',
  },
  usageStripText: {
    flex: 1,
    color: palette.muted,
    fontSize: 11,
    fontWeight: '700',
  },
  systemToast: {
    position: 'absolute',
    left: 12,
    right: 12,
    top: 8,
    minHeight: 58,
    flexDirection: 'row',
    alignItems: 'center',
    padding: 10,
    borderWidth: 1,
    borderColor: '#3a3a3d',
    borderRadius: 14,
    backgroundColor: '#252527',
    shadowColor: '#000',
    shadowOpacity: 0.25,
    shadowRadius: 10,
    shadowOffset: { width: 0, height: 4 },
    elevation: 12,
    zIndex: 30,
  },
  systemToastAlert: {
    borderColor: '#5d3532',
    backgroundColor: '#2d2322',
  },
  systemToastApproval: {
    borderColor: '#4d5f56',
  },
  systemToastQuestion: {
    borderColor: '#4c5364',
  },
  systemToastUsage: {
    borderColor: '#554729',
  },
  systemToastIcon: {
    width: 32,
    height: 32,
    borderRadius: 11,
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: 9,
    backgroundColor: '#303033',
  },
  systemToastIconText: {
    color: palette.text,
    fontSize: 16,
    fontWeight: '900',
  },
  systemToastTextBlock: {
    flex: 1,
    minWidth: 0,
  },
  systemToastTitle: {
    color: palette.text,
    fontSize: 13,
    fontWeight: '900',
    marginBottom: 2,
  },
  systemToastBody: {
    color: palette.muted,
    fontSize: 12,
    lineHeight: 16,
  },
  systemToastClose: {
    color: palette.dim,
    fontSize: 20,
    fontWeight: '800',
    paddingLeft: 10,
  },
  projectMenu: {
    position: 'absolute',
    top: 58,
    left: 16,
    right: 16,
    zIndex: 20,
    padding: 10,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: '#38383a',
    backgroundColor: '#222223',
    shadowColor: '#000',
    shadowOpacity: 0.28,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 6 },
    elevation: 8,
  },
  projectMenuHeader: {
    minHeight: 28,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 6,
  },
  projectMenuTitle: {
    color: palette.text,
    fontSize: 12,
    fontWeight: '800',
    textTransform: 'uppercase',
  },
  projectRefresh: {
    color: palette.muted,
    fontSize: 12,
    fontWeight: '700',
  },
  projectMenuRow: {
    minHeight: 44,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 10,
    paddingVertical: 7,
    borderRadius: 12,
  },
  projectMenuRowActive: {
    backgroundColor: '#2a2f2b',
  },
  projectNewRow: {
    marginTop: 6,
    borderTopWidth: 1,
    borderTopColor: palette.line,
  },
  projectMenuText: {
    flex: 1,
    paddingRight: 10,
  },
  projectMenuName: {
    color: palette.text,
    fontSize: 14,
    fontWeight: '800',
  },
  projectMenuDetail: {
    marginTop: 2,
    color: palette.dim,
    fontSize: 11,
  },
  projectSelected: {
    color: palette.ok,
    fontSize: 14,
    fontWeight: '900',
  },
  projectMenuActions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  projectRemove: {
    color: palette.dim,
    fontSize: 22,
    fontWeight: '800',
    lineHeight: 24,
  },
  pickerOverlay: {
    position: 'absolute',
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    zIndex: 30,
    justifyContent: 'flex-end',
    backgroundColor: 'rgba(0,0,0,0.48)',
  },
  addSessionPanel: {
    maxHeight: '78%',
    paddingHorizontal: 14,
    paddingTop: 14,
    paddingBottom: 18,
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    borderWidth: 1,
    borderColor: '#38383a',
    backgroundColor: palette.bg,
  },
  projectPickList: {
    maxHeight: 260,
    marginTop: 4,
  },
  pickerPanel: {
    maxHeight: '82%',
    paddingHorizontal: 14,
    paddingTop: 14,
    paddingBottom: 18,
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    borderWidth: 1,
    borderColor: '#38383a',
    backgroundColor: palette.bg,
  },
  pickerHeader: {
    minHeight: 44,
    flexDirection: 'row',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    marginBottom: 10,
  },
  pickerTitleBlock: {
    flex: 1,
    paddingRight: 12,
  },
  pickerTitle: {
    color: palette.text,
    fontSize: 18,
    fontWeight: '900',
  },
  pickerPath: {
    marginTop: 3,
    color: palette.dim,
    fontSize: 12,
  },
  pickerClose: {
    color: palette.text,
    fontSize: 28,
    lineHeight: 30,
  },
  pickerActions: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
    marginBottom: 10,
  },
  pickerList: {
    maxHeight: 440,
  },
  pickerRow: {
    minHeight: 48,
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 10,
    paddingVertical: 8,
    borderRadius: 12,
  },
  pickerFolderGlyph: {
    width: 28,
    height: 28,
    borderRadius: 10,
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: 10,
    backgroundColor: '#2a2a2c',
  },
  pickerFolderGlyphText: {
    color: palette.muted,
    fontSize: 15,
    fontWeight: '800',
  },
  helpChatButton: {
    position: 'absolute',
    right: 58,
    top: 13,
    width: 34,
    height: 34,
    alignItems: 'center',
    justifyContent: 'center',
  },
  helpChatIcon: {
    color: palette.text,
    fontSize: 24,
    fontWeight: '500',
  },
  plusButton: {
    position: 'absolute',
    right: 18,
    top: 13,
    width: 34,
    height: 34,
    alignItems: 'center',
    justifyContent: 'center',
  },
  plus: {
    color: palette.text,
    fontSize: 34,
    fontWeight: '200',
    lineHeight: 36,
  },
  pressed: {
    opacity: 0.65,
  },
  content: {
    flex: 1,
  },
  onboardingShell: {
    flex: 1,
    justifyContent: 'center',
    paddingHorizontal: 28,
    paddingBottom: 36,
  },
  onboardingKicker: {
    color: palette.muted,
    fontSize: 12,
    fontWeight: '800',
    letterSpacing: 1.4,
    textTransform: 'uppercase',
    marginBottom: 10,
  },
  onboardingTitle: {
    color: palette.text,
    fontSize: 30,
    fontWeight: '900',
    letterSpacing: -1.1,
    lineHeight: 34,
    marginBottom: 14,
  },
  onboardingBody: {
    color: palette.muted,
    fontSize: 15,
    lineHeight: 22,
    marginBottom: 20,
  },
  onboardingSteps: {
    borderLeftWidth: 1,
    borderLeftColor: palette.line,
    paddingLeft: 14,
    marginBottom: 18,
    gap: 8,
  },
  onboardingStep: {
    color: palette.text,
    fontSize: 13,
    fontWeight: '600',
  },
  onboardingHint: {
    color: palette.dim,
    fontSize: 12,
    marginBottom: 16,
  },
  onboardingActions: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
  },
  fill: {
    flex: 1,
  },
  emptyFill: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  emptyTapArea: {
    flex: 1,
    width: '100%',
    alignItems: 'center',
    justifyContent: 'center',
  },
  quietText: {
    color: palette.dim,
    fontSize: 14,
  },
  messages: {
    paddingHorizontal: 14,
    paddingTop: 10,
    paddingBottom: 10,
  },
  chatHeader: {
    minHeight: 52,
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderBottomWidth: 1,
    borderBottomColor: palette.line,
    backgroundColor: palette.bg,
  },
  chatBackButton: {
    width: 36,
    height: 36,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: 8,
    backgroundColor: '#242425',
  },
  chatBackText: {
    color: palette.text,
    fontSize: 30,
    lineHeight: 32,
    fontWeight: '700',
  },
  chatHeaderText: {
    flex: 1,
    minWidth: 0,
  },
  chatHeaderTitle: {
    color: palette.text,
    fontSize: 15,
    fontWeight: '900',
  },
  chatHeaderMeta: {
    color: palette.dim,
    fontSize: 11,
    lineHeight: 15,
    marginTop: 1,
  },
  messageRow: {
    marginBottom: 12,
    alignItems: 'flex-start',
  },
  messageRowUser: {
    alignItems: 'flex-end',
  },
  workingState: {
    alignSelf: 'center',
    flexDirection: 'row',
    alignItems: 'center',
    maxWidth: '92%',
    marginTop: 6,
    marginBottom: 10,
    paddingHorizontal: 12,
    paddingVertical: 9,
    borderRadius: radii.pill,
    backgroundColor: '#252527',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: palette.line,
  },
  workingStateDock: {
    position: 'absolute',
    left: 12,
    right: 12,
    alignItems: 'center',
    zIndex: 5,
  },
  workingText: {
    color: palette.muted,
    fontSize: 12,
    fontWeight: '700',
    marginLeft: 8,
  },
  queuePanel: {
    marginHorizontal: 12,
    marginBottom: 10,
    paddingHorizontal: 10,
    paddingVertical: 9,
    borderRadius: 14,
    backgroundColor: '#222224',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: '#3b3b3e',
  },
  queueHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 8,
  },
  queueTitle: {
    flex: 1,
    color: palette.text,
    fontSize: 12,
    fontWeight: '800',
    letterSpacing: 0.4,
    textTransform: 'uppercase',
  },
  queueCount: {
    color: palette.dim,
    fontSize: 12,
    fontWeight: '800',
  },
  queueItem: {
    flexDirection: 'row',
    gap: 8,
    paddingVertical: 8,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: '#363639',
  },
  queueItemActive: {
    backgroundColor: '#2a2924',
  },
  queueItemText: {
    flex: 1,
  },
  queueItemTitle: {
    color: palette.muted,
    fontSize: 11,
    fontWeight: '800',
    marginBottom: 3,
  },
  queueItemBody: {
    color: palette.text,
    fontSize: 13,
    lineHeight: 18,
  },
  queueActions: {
    justifyContent: 'center',
    alignItems: 'flex-end',
    gap: 6,
  },
  queueActionButton: {
    paddingHorizontal: 8,
    paddingVertical: 5,
    borderRadius: 10,
    backgroundColor: '#303033',
  },
  queueActionButtonActive: {
    backgroundColor: '#4a412b',
  },
  queueActionText: {
    color: palette.text,
    fontSize: 11,
    fontWeight: '800',
  },
  queueRemoveText: {
    color: '#f0a5a0',
    fontSize: 11,
    fontWeight: '800',
  },
  progressRow: {
    marginBottom: 8,
    alignItems: 'center',
  },
  progressCard: {
    maxWidth: '88%',
    minHeight: 28,
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: '#313133',
    backgroundColor: '#242425',
  },
  progressCardError: {
    borderColor: '#4a2a28',
    backgroundColor: '#2a2221',
  },
  progressDot: {
    width: 7,
    height: 7,
    borderRadius: 4,
    marginRight: 8,
    backgroundColor: palette.dim,
  },
  progressDotError: {
    backgroundColor: palette.error,
  },
  progressText: {
    marginLeft: 8,
    color: palette.muted,
    fontSize: 12,
    fontWeight: '700',
  },
  progressTextError: {
    color: '#ff9d97',
  },
  messageBubble: {
    maxWidth: '88%',
    flexShrink: 1,
  },
  messageBubbleUser: {
    backgroundColor: '#2b2b2d',
    borderRadius: 14,
    paddingHorizontal: 10,
    paddingVertical: 7,
  },
  messageBubbleSystem: {
    maxWidth: '92%',
  },
  diffButton: {
    marginTop: 6,
    paddingHorizontal: 10,
    paddingVertical: 7,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#3a3a3d',
    backgroundColor: '#242425',
  },
  diffButtonUser: {
    alignSelf: 'flex-end',
  },
  diffButtonDisabled: {
    opacity: 0.55,
  },
  diffButtonText: {
    color: palette.text,
    fontSize: 12,
    fontWeight: '800',
  },
  messageText: {
    color: palette.text,
    fontSize: 14,
    lineHeight: 20,
  },
  messageTextUser: {
    color: palette.text,
  },
  messageTextSystem: {
    color: palette.muted,
    fontSize: 13,
  },
  messageBlock: {
    marginBottom: 8,
  },
  messageBlockLast: {
    marginBottom: 0,
  },
  messageHeading: {
    marginBottom: 6,
    fontSize: 15,
    lineHeight: 21,
    fontWeight: '800',
  },
  messageHeadingLarge: {
    fontSize: 16,
    lineHeight: 22,
  },
  boldText: {
    fontWeight: '800',
  },
  inlineCode: {
    color: palette.text,
    backgroundColor: '#303033',
    borderRadius: 4,
    fontFamily: Platform.select({ android: 'monospace', default: undefined }),
    fontSize: 13,
  },
  codeBlock: {
    alignSelf: 'stretch',
    marginBottom: 8,
    paddingHorizontal: 10,
    paddingVertical: 8,
    borderRadius: 10,
    backgroundColor: '#202022',
    borderWidth: 1,
    borderColor: palette.line,
  },
  codeText: {
    color: '#e7e3dc',
    fontFamily: Platform.select({ android: 'monospace', default: undefined }),
    fontSize: 12,
    lineHeight: 18,
  },
  bulletRow: {
    width: '100%',
    alignSelf: 'stretch',
    flexDirection: 'row',
    marginBottom: 4,
  },
  bulletMarker: {
    width: 14,
    flexShrink: 0,
    color: palette.muted,
  },
  bulletText: {
    flex: 1,
    flexShrink: 1,
    minWidth: 0,
  },
  latestButton: {
    position: 'absolute',
    right: 16,
    bottom: 58,
    width: 34,
    height: 34,
    borderRadius: 17,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#343436',
    borderWidth: 1,
    borderColor: '#444448',
    shadowColor: '#000',
    shadowOpacity: 0.22,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 3 },
    elevation: 5,
    zIndex: 4,
  },
  latestButtonText: {
    color: palette.text,
    fontSize: 18,
    fontWeight: '800',
    lineHeight: 20,
  },
  composer: {
    minHeight: 40,
    paddingHorizontal: 10,
    paddingTop: 6,
    paddingBottom: 8,
    borderTopWidth: 1,
    borderTopColor: palette.line,
    backgroundColor: palette.bg,
  },
  composerNotice: {
    marginBottom: 6,
    paddingHorizontal: 10,
    paddingVertical: 7,
    borderRadius: 12,
    backgroundColor: '#2a2521',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: '#5f4630',
  },
  composerNoticeText: {
    color: '#f0c58c',
    fontSize: 12,
    fontWeight: '700',
    lineHeight: 16,
  },
  steeringNoticeRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  steeringCancel: {
    color: '#f0c58c',
    fontSize: 12,
    fontWeight: '900',
    textTransform: 'uppercase',
  },
  composerRow: {
    flexDirection: 'row',
    alignItems: 'flex-end',
  },
  composerDocked: {
    position: 'absolute',
    left: 0,
    right: 0,
    zIndex: 5,
    elevation: 6,
  },
  composerInput: {
    flex: 1,
    maxHeight: 92,
    minHeight: 34,
    color: palette.text,
    fontSize: 14,
    paddingHorizontal: 10,
    paddingVertical: Platform.OS === 'ios' ? 10 : 6,
    backgroundColor: '#29292a',
    borderRadius: 16,
  },
  sendButton: {
    width: 40,
    height: 40,
    borderRadius: 16,
    alignItems: 'center',
    justifyContent: 'center',
    marginLeft: 8,
    backgroundColor: '#343436',
  },
  sendButtonDisabled: {
    opacity: 0.45,
  },
  sendText: {
    color: palette.text,
    fontSize: 18,
    fontWeight: '700',
  },
  sendTextDisabled: {
    color: palette.dim,
  },
  diffOverlay: {
    position: 'absolute',
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    zIndex: 20,
    elevation: 20,
    backgroundColor: '#161617',
  },
  diffSafeArea: {
    flex: 1,
    backgroundColor: '#161617',
  },
  diffPanel: {
    flex: 1,
    backgroundColor: '#161617',
    paddingTop: 4,
  },
  diffHeader: {
    minHeight: 40,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginBottom: 4,
    paddingHorizontal: 8,
  },
  diffHeaderText: {
    flex: 1,
    minWidth: 0,
  },
  diffTitle: {
    color: palette.text,
    fontSize: 15,
    fontWeight: '900',
  },
  diffMeta: {
    color: palette.dim,
    fontSize: 10,
    marginTop: 1,
  },
  diffHeaderButton: {
    width: 32,
    height: 32,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 10,
    backgroundColor: '#252527',
  },
  diffHeaderButtonText: {
    color: palette.text,
    fontSize: 17,
    fontWeight: '800',
  },
  diffError: {
    color: '#ff9d97',
    fontSize: 12,
    fontWeight: '700',
    marginBottom: 6,
    marginHorizontal: 8,
  },
  diffFileSelectorWrap: {
    position: 'relative',
    zIndex: 30,
    marginBottom: 4,
    marginHorizontal: 8,
  },
  diffFileSelector: {
    minHeight: 34,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 10,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: '#343438',
    backgroundColor: '#202022',
  },
  diffFileSelectorSingle: {
    borderColor: '#27272a',
  },
  diffFileName: {
    flex: 1,
    minWidth: 0,
    color: palette.text,
    fontSize: 12,
    fontWeight: '900',
  },
  diffFileCounts: {
    color: palette.dim,
    fontSize: 11,
    fontWeight: '800',
    fontFamily: Platform.select({ android: 'monospace', default: undefined }),
  },
  diffDropdownIcon: {
    color: palette.muted,
    fontSize: 16,
    fontWeight: '900',
    marginLeft: -2,
  },
  diffDropdown: {
    position: 'absolute',
    top: 38,
    left: 0,
    right: 0,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#37373b',
    overflow: 'hidden',
    backgroundColor: '#202022',
    zIndex: 40,
    elevation: 40,
  },
  diffDropdownScroll: {
    flex: 1,
  },
  diffDropdownContent: {
    paddingVertical: 2,
  },
  diffDropdownItem: {
    minHeight: 38,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#303034',
  },
  diffDropdownItemActive: {
    backgroundColor: '#293129',
  },
  diffDropdownText: {
    flex: 1,
    minWidth: 0,
    color: palette.muted,
    fontSize: 12,
    fontWeight: '800',
  },
  diffDropdownTextActive: {
    color: palette.text,
  },
  diffDropdownMeta: {
    color: palette.dim,
    fontSize: 10,
    fontWeight: '800',
    fontFamily: Platform.select({ android: 'monospace', default: undefined }),
  },
  diffScroll: {
    flex: 1,
    backgroundColor: '#161617',
  },
  diffHorizontalContent: {
    flexGrow: 1,
  },
  diffVerticalScroll: {
    flexGrow: 1,
  },
  diffVerticalContent: {
    flexGrow: 1,
  },
  diffCode: {
    color: '#e7e3dc',
    fontFamily: Platform.select({ android: 'monospace', default: undefined }),
    fontSize: 12,
    lineHeight: 17,
    paddingHorizontal: 8,
    paddingVertical: 4,
  },
  diffLineList: {
    paddingVertical: 2,
    minWidth: Math.max(560, Dimensions.get('window').width),
  },
  diffLine: {
    minHeight: 19,
    paddingHorizontal: 8,
    justifyContent: 'center',
  },
  diffLineAddition: {
    backgroundColor: 'rgba(58, 132, 82, 0.18)',
  },
  diffLineDeletion: {
    backgroundColor: 'rgba(181, 76, 70, 0.18)',
  },
  diffLineHunk: {
    backgroundColor: 'rgba(102, 116, 182, 0.18)',
  },
  diffLineMeta: {
    backgroundColor: 'rgba(255,255,255,0.025)',
  },
  diffLineText: {
    color: '#ddd8cf',
    fontFamily: Platform.select({ android: 'monospace', default: undefined }),
    fontSize: 12,
    lineHeight: 18,
  },
  diffLineTextAddition: {
    color: '#9be3aa',
  },
  diffLineTextDeletion: {
    color: '#ffaaa3',
  },
  diffLineTextHunk: {
    color: '#bfc8ff',
    fontWeight: '800',
  },
  diffLineTextMeta: {
    color: palette.dim,
  },
  inboxList: {
    paddingHorizontal: 12,
    paddingTop: 6,
    paddingBottom: 16,
  },
  inboxHeader: {
    minHeight: 42,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 6,
  },
  inboxSummary: {
    color: palette.muted,
    fontSize: 12,
    fontWeight: '700',
    textTransform: 'uppercase',
  },
  inboxItem: {
    marginBottom: 10,
    padding: 12,
    borderWidth: 1,
    borderColor: palette.line,
    borderRadius: 14,
    backgroundColor: '#202021',
  },
  inboxItemApproval: {
    borderColor: '#5d3532',
  },
  inboxItemQuestion: {
    borderColor: '#4d5f56',
  },
  inboxItemTop: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 7,
  },
  inboxKind: {
    color: palette.muted,
    fontSize: 11,
    fontWeight: '800',
    letterSpacing: 0.5,
    textTransform: 'uppercase',
  },
  inboxTime: {
    color: palette.dim,
    fontSize: 11,
  },
  inboxTitle: {
    color: palette.text,
    fontSize: 14,
    fontWeight: '800',
    marginBottom: 4,
  },
  inboxBody: {
    color: palette.muted,
    fontSize: 13,
    lineHeight: 18,
  },
  inboxActions: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
    marginTop: 10,
  },
  inboxChoiceList: {
    marginTop: 10,
    gap: 8,
  },
  inboxActionButton: {
    minHeight: 34,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: '#3a3a3d',
    backgroundColor: '#262628',
    justifyContent: 'center',
  },
  inboxActionLabel: {
    color: palette.text,
    fontSize: 13,
    fontWeight: '800',
  },
  inboxActionDetail: {
    color: palette.dim,
    fontSize: 11,
    lineHeight: 15,
    marginTop: 2,
  },
  inboxResolved: {
    color: palette.ok,
    fontSize: 12,
    fontWeight: '800',
    marginTop: 10,
  },
  inboxEmpty: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 32,
  },
  inboxEmptyTitle: {
    color: palette.text,
    fontSize: 16,
    fontWeight: '800',
    marginBottom: 6,
  },
  inboxEmptyText: {
    color: palette.dim,
    fontSize: 13,
    lineHeight: 18,
    textAlign: 'center',
  },
  terminalList: {
    paddingHorizontal: 12,
    paddingTop: 6,
    paddingBottom: 16,
  },
  sessionProjectGroup: {
    marginBottom: 12,
  },
  sessionProjectName: {
    color: palette.text,
    fontSize: 14,
    fontWeight: '800',
    marginBottom: 2,
  },
  sessionProjectPath: {
    color: palette.dim,
    fontSize: 11,
    marginBottom: 2,
  },
  sessionProjectStatus: {
    color: palette.muted,
    fontSize: 11,
    fontWeight: '800',
    marginBottom: 7,
  },
  sessionUsageSummary: {
    minHeight: 44,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 10,
    marginBottom: 10,
    paddingHorizontal: 10,
    paddingVertical: 8,
    borderWidth: 1,
    borderColor: palette.line,
    borderRadius: 12,
    backgroundColor: '#202021',
  },
  sessionUsageSummaryWarn: {
    borderColor: '#5a4a31',
    backgroundColor: '#312a20',
  },
  sessionUsageSummaryError: {
    borderColor: '#5a3431',
    backgroundColor: '#312220',
  },
  sessionUsageSummaryText: {
    flex: 1,
    minWidth: 0,
  },
  sessionUsageTitle: {
    color: palette.text,
    fontSize: 12,
    fontWeight: '800',
  },
  sessionUsageMeta: {
    marginTop: 2,
    color: palette.dim,
    fontSize: 11,
  },
  sessionUsagePercent: {
    color: palette.text,
    fontSize: 12,
    fontWeight: '800',
  },
  terminalRow: {
    minHeight: 48,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 7,
    paddingHorizontal: 10,
    paddingVertical: 8,
    borderWidth: 1,
    borderColor: palette.line,
    borderRadius: 12,
    backgroundColor: '#202021',
  },
  terminalRowActive: {
    borderColor: '#4d5f56',
    backgroundColor: '#222a25',
  },
  terminalTextBlock: {
    flex: 1,
    paddingRight: 12,
  },
  terminalName: {
    color: palette.text,
    fontSize: 14,
    fontWeight: '600',
  },
  terminalMeta: {
    color: palette.dim,
    fontSize: 11,
    marginTop: 2,
  },
  sessionActions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  sessionStatusPill: {
    minHeight: 26,
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 8,
    paddingVertical: 5,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: '#343436',
    backgroundColor: '#252527',
  },
  sessionStatusOk: {
    borderColor: '#315241',
    backgroundColor: '#203127',
  },
  sessionStatusWarn: {
    borderColor: '#5a4a31',
    backgroundColor: '#312a20',
  },
  sessionStatusError: {
    borderColor: '#5a3431',
    backgroundColor: '#312220',
  },
  sessionStatusDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    marginRight: 6,
  },
  sessionStatusText: {
    color: palette.text,
    fontSize: 11,
    fontWeight: '900',
  },
  hiddenSessionsBlock: {
    marginTop: 16,
    paddingTop: 8,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: palette.line,
  },
  hiddenSessionsHeader: {
    minHeight: 44,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  hiddenSessionsTitle: {
    color: palette.muted,
    fontSize: 13,
    fontWeight: '900',
  },
  hiddenSessionsCount: {
    color: palette.dim,
    fontSize: 12,
    fontWeight: '700',
  },
  stopText: {
    color: palette.error,
    fontSize: 13,
    fontWeight: '700',
  },
  deleteText: {
    color: palette.dim,
    fontSize: 13,
    fontWeight: '700',
  },
  offlineBanner: {
    color: palette.warn,
    fontSize: 12,
    fontWeight: '800',
    marginBottom: 10,
  },
  settingsContent: {
    paddingHorizontal: 12,
    paddingTop: 6,
    paddingBottom: 24,
    flexGrow: 1,
  },
  settingsMenuContent: {
    paddingHorizontal: 12,
    paddingTop: 6,
    paddingBottom: 20,
    flexGrow: 1,
  },
  settingsMenuHeader: {
    paddingHorizontal: 2,
    paddingTop: 2,
    paddingBottom: 10,
  },
  settingsMenuTitle: {
    color: palette.text,
    fontSize: 18,
    fontWeight: '900',
    marginBottom: 2,
  },
  settingsMenuSubtitle: {
    color: palette.dim,
    fontSize: 12,
    lineHeight: 17,
  },
  settingsMenuCard: {
    minHeight: 58,
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 2,
    paddingVertical: 8,
    borderBottomWidth: 1,
    borderBottomColor: palette.line,
  },
  settingsMenuIcon: {
    width: 32,
    height: 32,
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: 10,
  },
  settingsMenuIconText: {
    color: palette.text,
    fontSize: 20,
    fontWeight: '800',
    lineHeight: 24,
  },
  settingsMenuText: {
    flex: 1,
    minWidth: 0,
  },
  settingsMenuRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 2,
  },
  settingsMenuCardTitle: {
    flex: 1,
    color: palette.text,
    fontSize: 14,
    fontWeight: '900',
  },
  settingsMenuCardSubtitle: {
    color: palette.muted,
    fontSize: 12,
    lineHeight: 16,
  },
  settingsMenuCardDetail: {
    color: palette.dim,
    fontSize: 11,
    lineHeight: 15,
    marginTop: 2,
  },
  settingsMenuChevron: {
    color: palette.dim,
    fontSize: 26,
    lineHeight: 28,
    marginLeft: 10,
  },
  settingsSubHeader: {
    minHeight: 56,
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 10,
  },
  settingsBackButton: {
    width: 34,
    height: 34,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: 8,
    borderWidth: 1,
    borderColor: palette.line,
    backgroundColor: '#242425',
  },
  settingsBackText: {
    color: palette.text,
    fontSize: 28,
    lineHeight: 30,
    fontWeight: '700',
  },
  settingsSubIcon: {
    width: 38,
    height: 38,
    borderRadius: 13,
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: 10,
    borderWidth: 1,
    borderColor: '#333337',
    backgroundColor: '#262628',
  },
  settingsSubIconText: {
    color: palette.text,
    fontSize: 19,
    lineHeight: 22,
    fontWeight: '800',
  },
  settingsSubText: {
    flex: 1,
    minWidth: 0,
  },
  settingsSubTitle: {
    color: palette.text,
    fontSize: 16,
    fontWeight: '900',
  },
  settingsSubSubtitle: {
    color: palette.dim,
    fontSize: 12,
    lineHeight: 17,
  },
  settingsAppInfo: {
    marginTop: 'auto',
    paddingTop: 18,
    alignItems: 'center',
  },
  settingsAppInfoText: {
    color: palette.dim,
    fontSize: 10,
    fontWeight: '800',
    letterSpacing: 0.8,
    textTransform: 'uppercase',
  },
  settingsAppInfoSubtext: {
    color: '#5f5d63',
    fontSize: 10,
    lineHeight: 15,
    marginTop: 2,
    textAlign: 'center',
  },
  settingsSection: {
    marginBottom: 10,
    paddingHorizontal: 2,
    paddingBottom: 12,
  },
  settingsSectionTitle: {
    color: palette.text,
    fontSize: 16,
    fontWeight: '800',
    marginBottom: 3,
  },
  settingsSectionSubtitle: {
    color: palette.dim,
    fontSize: 12,
    lineHeight: 17,
    marginBottom: 10,
  },
  inputGroup: {
    marginTop: 10,
  },
  inputLabel: {
    color: palette.muted,
    fontSize: 11,
    fontWeight: '700',
    marginBottom: 2,
    textTransform: 'uppercase',
  },
  input: {
    minHeight: 40,
    color: palette.text,
    fontSize: 14,
    paddingHorizontal: 10,
    paddingVertical: Platform.OS === 'ios' ? 10 : 7,
    borderWidth: 1,
    borderColor: palette.line,
    borderRadius: 10,
    backgroundColor: '#1a1a1b',
    marginBottom: spacing.md,
  },
  inputMultiline: {
    minHeight: 74,
    textAlignVertical: 'top',
  },
  settingsActions: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
    marginTop: 8,
    marginBottom: 12,
  },
  textButton: {
    minHeight: 34,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: '#3a3a3d',
    backgroundColor: '#262628',
    alignItems: 'center',
    justifyContent: 'center',
  },
  textButtonPrimary: {
    borderColor: '#4d5f56',
    backgroundColor: '#2d3a33',
  },
  textButtonDanger: {
    borderColor: '#5d3532',
    backgroundColor: '#3a2727',
  },
  textButtonDisabled: {
    opacity: 0.45,
  },
  textButtonLabel: {
    color: palette.text,
    fontSize: 13,
    fontWeight: '800',
  },
  textButtonLabelPrimary: {
    color: '#bdf5cf',
  },
  textButtonLabelDanger: {
    color: '#ffb0aa',
  },
  textButtonLabelDisabled: {
    color: palette.dim,
  },
  settingHint: {
    color: palette.dim,
    fontSize: 12,
    lineHeight: 17,
  },
  settingRow: {
    minHeight: 36,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    borderBottomWidth: 1,
    borderBottomColor: '#252526',
  },
  settingLabel: {
    color: palette.muted,
    fontSize: 13,
    paddingRight: 12,
  },
  settingValueWrap: {
    flexDirection: 'row',
    alignItems: 'center',
    flexShrink: 1,
  },
  statusDotSmall: {
    width: 7,
    height: 7,
    borderRadius: radii.pill,
    marginRight: 7,
  },
  settingValue: {
    color: palette.text,
    fontSize: 13,
    fontWeight: '700',
    maxWidth: 180,
  },
  settingValueWide: {
    color: palette.text,
    fontSize: 12,
    lineHeight: 16,
    maxWidth: 210,
    textAlign: 'right',
  },
  toggleRow: {
    minHeight: 48,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    borderBottomWidth: 1,
    borderBottomColor: '#252526',
  },
  toggleTextBlock: {
    flex: 1,
    paddingRight: 12,
  },
  toggleDetail: {
    color: palette.dim,
    fontSize: 11,
    lineHeight: 15,
    marginTop: 2,
  },
  toggleTrack: {
    width: 42,
    height: 24,
    padding: 3,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#424246',
    backgroundColor: '#1a1a1b',
    justifyContent: 'center',
  },
  toggleTrackOn: {
    borderColor: '#4d5f56',
    backgroundColor: '#29362f',
  },
  toggleKnob: {
    width: 16,
    height: 16,
    borderRadius: 8,
    backgroundColor: palette.dim,
  },
  toggleKnobOn: {
    alignSelf: 'flex-end',
    backgroundColor: palette.ok,
  },
  deviceRow: {
    minHeight: 58,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    borderBottomWidth: 1,
    borderBottomColor: '#252526',
  },
  deviceTextBlock: {
    flex: 1,
    paddingRight: 12,
  },
  deviceName: {
    color: palette.text,
    fontSize: 13,
    fontWeight: '800',
  },
  deviceMeta: {
    color: palette.dim,
    fontSize: 11,
    marginTop: 2,
  },
  currentDeviceText: {
    color: palette.ok,
    fontSize: 12,
    fontWeight: '700',
  },
  historyItem: {
    paddingVertical: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: palette.line,
  },
  historyTopRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 4,
  },
  historyLevel: {
    fontSize: 11,
    fontWeight: '900',
    textTransform: 'uppercase',
  },
  historyError: {
    color: palette.error,
  },
  historyWarning: {
    color: palette.warn,
  },
  historyTime: {
    color: palette.dim,
    fontSize: 11,
    fontWeight: '700',
  },
  historyTitle: {
    color: palette.text,
    fontSize: 13,
    fontWeight: '900',
    marginBottom: 3,
  },
  historyBody: {
    color: palette.muted,
    fontSize: 12,
    lineHeight: 17,
  },
  errorLine: {
    color: palette.error,
    fontSize: 13,
    lineHeight: 18,
    marginTop: 8,
  },
  inlinePanel: {
    marginTop: 10,
    borderTopWidth: 1,
    borderTopColor: palette.line,
    paddingTop: 8,
  },
  inlinePanelHeader: {
    minHeight: 40,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  inlinePanelTitle: {
    color: palette.text,
    fontSize: 13,
    fontWeight: '900',
    textTransform: 'uppercase',
  },
  usageMeter: {
    height: 5,
    marginTop: 10,
    borderRadius: 3,
    backgroundColor: '#2a2a2c',
    overflow: 'hidden',
  },
  usageMeterWarn: {
    backgroundColor: '#342d1c',
  },
  usageMeterError: {
    backgroundColor: '#3a2422',
  },
  usageMeterFill: {
    height: '100%',
    borderRadius: 3,
    backgroundColor: palette.ok,
  },
  usageMeterFillWarn: {
    backgroundColor: palette.warn,
  },
  usageMeterFillError: {
    backgroundColor: palette.error,
  },
  accountRow: {
    minHeight: 50,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    borderBottomWidth: 1,
    borderBottomColor: '#252526',
  },
  accountRowActive: {
    backgroundColor: '#202820',
  },
  accountTextBlock: {
    flex: 1,
    minWidth: 0,
    paddingRight: 10,
  },
  suggestionStrip: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 6,
    marginTop: -4,
    marginBottom: 8,
  },
  suggestionPill: {
    maxWidth: 130,
    minHeight: 28,
    justifyContent: 'center',
    paddingHorizontal: 9,
    borderRadius: 14,
    backgroundColor: '#29292a',
    borderWidth: 1,
    borderColor: palette.line,
  },
  suggestionText: {
    color: palette.muted,
    fontSize: 12,
    fontWeight: '700',
  },
  bottomTabs: {
    height: 60,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-around',
    paddingBottom: 6,
    borderTopWidth: 1,
    borderTopColor: palette.line,
    backgroundColor: palette.bg2,
  },
  tabItem: {
    width: 78,
    height: 44,
    alignItems: 'center',
    justifyContent: 'center',
  },
  tabIcon: {
    color: palette.muted,
    fontSize: 18,
    marginBottom: 0,
  },
  tabIconActive: {
    color: palette.text,
  },
  tabLabel: {
    color: palette.muted,
    fontSize: 10,
    fontWeight: '500',
  },
  tabLabelActive: {
    color: palette.text,
    fontWeight: '800',
  },
});
