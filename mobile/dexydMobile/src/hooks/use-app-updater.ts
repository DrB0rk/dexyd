import { useCallback, useMemo, useState } from 'react';
import { Linking, Platform } from 'react-native';
import { DexydUpdater } from '../native/dexyd-updater';
import { errorMessage } from '../utils/error-message';

const FALLBACK_APP_VERSION = '0.0.7';
const GITHUB_LATEST_RELEASE_URL =
  'https://api.github.com/repos/DrB0rk/dexyd/releases/latest';
const GITHUB_RELEASES_URL = 'https://github.com/DrB0rk/dexyd/releases/latest';

type GitHubReleaseAsset = {
  name?: string;
  browser_download_url?: string;
  content_type?: string;
};

type GitHubRelease = {
  tag_name?: string;
  name?: string;
  html_url?: string;
  prerelease?: boolean;
  draft?: boolean;
  assets?: GitHubReleaseAsset[];
};

export type AppUpdateInfo = {
  currentVersion: string;
  latestVersion: string;
  releaseName: string;
  releaseUrl: string;
  apkName: string | null;
  apkUrl: string | null;
  updateAvailable: boolean;
};

function normalizeVersion(version: string): string {
  return version.trim().replace(/^v/i, '').split('-')[0] || '0.0.0';
}

function compareVersions(left: string, right: string): number {
  const a = normalizeVersion(left)
    .split('.')
    .map(value => Number(value) || 0);
  const b = normalizeVersion(right)
    .split('.')
    .map(value => Number(value) || 0);
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const diff = (a[index] ?? 0) - (b[index] ?? 0);
    if (diff !== 0) return diff > 0 ? 1 : -1;
  }
  return 0;
}

function findApkAsset(release: GitHubRelease): GitHubReleaseAsset | null {
  return (
    release.assets?.find(asset => {
      const name = asset.name ?? '';
      return /^dexyd-v.*\.apk$/i.test(name) || name.endsWith('.apk');
    }) ?? null
  );
}

function isTrustedApkUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      url.protocol === 'https:' &&
      (url.hostname === 'github.com' || url.hostname.endsWith('.github.com'))
    );
  } catch {
    return false;
  }
}

export function useAppUpdater() {
  const [checking, setChecking] = useState(false);
  const [installing, setInstalling] = useState(false);
  const [info, setInfo] = useState<AppUpdateInfo | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const check = useCallback(async () => {
    setChecking(true);
    setError(null);
    setMessage(null);
    try {
      const currentVersion = await DexydUpdater.getInstalledVersion(
        FALLBACK_APP_VERSION,
      );
      const response = await fetch(GITHUB_LATEST_RELEASE_URL, {
        headers: {
          Accept: 'application/vnd.github+json',
        },
      });
      if (!response.ok) {
        throw new Error(`GitHub returned HTTP ${response.status}`);
      }
      const release = (await response.json()) as GitHubRelease;
      const latestVersion = release.tag_name ?? '';
      if (!latestVersion) throw new Error('Latest GitHub release has no tag.');
      const apkAsset = findApkAsset(release);
      const apkUrl = apkAsset?.browser_download_url ?? null;
      const apkName = apkAsset?.name ?? null;
      const updateAvailable =
        compareVersions(latestVersion, currentVersion) > 0;
      const nextInfo: AppUpdateInfo = {
        currentVersion,
        latestVersion,
        releaseName: release.name || latestVersion,
        releaseUrl: release.html_url || GITHUB_RELEASES_URL,
        apkName,
        apkUrl,
        updateAvailable,
      };
      setInfo(nextInfo);
      setMessage(
        updateAvailable
          ? `Update available: ${latestVersion}`
          : `Dexyd is up to date (${currentVersion}).`,
      );
      return nextInfo;
    } catch (err) {
      const nextError = errorMessage(err, 'failed to check for updates');
      setError(nextError);
      return null;
    } finally {
      setChecking(false);
    }
  }, []);

  const install = useCallback(async () => {
    setInstalling(true);
    setError(null);
    setMessage(null);
    try {
      const updateInfo = info?.updateAvailable ? info : await check();
      if (!updateInfo) return false;
      if (!updateInfo.updateAvailable) {
        setMessage(`Dexyd is already current (${updateInfo.currentVersion}).`);
        return false;
      }
      if (!updateInfo.apkUrl || !updateInfo.apkName) {
        setMessage('Release has no APK asset. Opening GitHub release page.');
        await Linking.openURL(updateInfo.releaseUrl);
        return false;
      }
      if (!isTrustedApkUrl(updateInfo.apkUrl)) {
        throw new Error('Update APK URL is not a trusted GitHub URL.');
      }
      if (Platform.OS !== 'android' || !DexydUpdater.available) {
        setMessage('Opening GitHub release page for this platform.');
        await Linking.openURL(updateInfo.releaseUrl);
        return false;
      }

      const canInstall = await DexydUpdater.canRequestPackageInstalls();
      if (!canInstall) {
        await DexydUpdater.openInstallPermissionSettings();
        setMessage(
          'Allow Dexyd to install unknown apps, then return here and tap Install update again.',
        );
        return false;
      }

      const updateSessionId = await DexydUpdater.downloadAndInstallApk(
        updateInfo.apkUrl,
        updateInfo.apkName,
      );
      setMessage(
        `Preparing ${updateInfo.apkName}. Android will open the update confirmation prompt when ready.`,
      );
      return Boolean(updateSessionId);
    } catch (err) {
      setError(errorMessage(err, 'failed to install update'));
      return false;
    } finally {
      setInstalling(false);
    }
  }, [check, info]);

  return useMemo(
    () => ({ checking, installing, info, message, error, check, install }),
    [check, checking, error, info, install, installing, message],
  );
}
