import { NativeModules, Platform } from 'react-native';

type DexydNotificationsNativeModule = {
  areNotificationsEnabled: () => Promise<boolean>;
  requestNotificationsPermission: () => Promise<boolean>;
  openNotificationSettings: () => Promise<boolean>;
  showNotification: (
    title: string,
    body: string,
    kind: string,
    sessionId: string | null,
  ) => Promise<boolean>;
};

const nativeModule = NativeModules.DexydNotifications as
  | DexydNotificationsNativeModule
  | undefined;

export const DexydNotifications = {
  available: (Platform.OS === 'android' || Platform.OS === 'ios') && Boolean(nativeModule),

  async areEnabled(): Promise<boolean> {
    if (!nativeModule) return false;
    return nativeModule.areNotificationsEnabled();
  },

  async requestPermission(): Promise<boolean> {
    if (!nativeModule) return false;
    return nativeModule.requestNotificationsPermission();
  },

  async openSettings(): Promise<boolean> {
    if (!nativeModule) return false;
    return nativeModule.openNotificationSettings();
  },

  async show(input: {
    title: string;
    body: string;
    kind: string;
    sessionId: string | null;
  }): Promise<boolean> {
    if (!nativeModule) return false;
    return nativeModule.showNotification(
      input.title,
      input.body,
      input.kind,
      input.sessionId,
    );
  },
};
