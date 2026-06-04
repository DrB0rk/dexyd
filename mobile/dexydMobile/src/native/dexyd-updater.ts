import { NativeModules, Platform } from 'react-native';

type DexydUpdaterNativeModule = {
  getInstalledVersion: () => Promise<string>;
  canRequestPackageInstalls: () => Promise<boolean>;
  openInstallPermissionSettings: () => Promise<boolean>;
  downloadAndInstallApk: (url: string, fileName: string) => Promise<string>;
};

const nativeModule = NativeModules.DexydUpdater as
  | DexydUpdaterNativeModule
  | undefined;

export const DexydUpdater = {
  available: Platform.OS === 'android' && Boolean(nativeModule),

  async getInstalledVersion(fallback: string): Promise<string> {
    if (!nativeModule) return fallback;
    const version = await nativeModule.getInstalledVersion();
    return version || fallback;
  },

  async canRequestPackageInstalls(): Promise<boolean> {
    if (!nativeModule) return false;
    return nativeModule.canRequestPackageInstalls();
  },

  async openInstallPermissionSettings(): Promise<boolean> {
    if (!nativeModule) return false;
    return nativeModule.openInstallPermissionSettings();
  },

  async downloadAndInstallApk(url: string, fileName: string): Promise<string> {
    if (!nativeModule) {
      throw new Error('Dexyd Android updater is not available in this build.');
    }
    return nativeModule.downloadAndInstallApk(url, fileName);
  },
};
