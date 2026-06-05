package com.dexydmobile

import android.content.Intent
import android.net.Uri
import android.os.Build
import android.provider.Settings
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import java.util.Locale

class DexydUpdaterModule(
  private val reactContext: ReactApplicationContext,
) : ReactContextBaseJavaModule(reactContext) {
  override fun getName(): String = "DexydUpdater"

  @ReactMethod
  fun getInstalledVersion(promise: Promise) {
    try {
      val packageInfo = reactContext.packageManager.getPackageInfo(reactContext.packageName, 0)
      promise.resolve(packageInfo.versionName ?: "")
    } catch (error: Exception) {
      promise.reject("version_unavailable", "Could not read installed version.", error)
    }
  }

  @ReactMethod
  fun canRequestPackageInstalls(promise: Promise) {
    try {
      val allowed = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
        reactContext.packageManager.canRequestPackageInstalls()
      } else {
        true
      }
      promise.resolve(allowed)
    } catch (error: Exception) {
      promise.reject("install_permission_check_failed", "Could not check installer permission.", error)
    }
  }

  @ReactMethod
  fun openInstallPermissionSettings(promise: Promise) {
    try {
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
        val intent = Intent(
          Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,
          Uri.parse("package:${reactContext.packageName}"),
        ).apply {
          addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        }
        reactContext.startActivity(intent)
      }
      promise.resolve(true)
    } catch (error: Exception) {
      promise.reject("install_permission_settings_failed", "Could not open installer permission settings.", error)
    }
  }

  @ReactMethod
  fun downloadAndInstallApk(url: String, fileName: String, promise: Promise) {
    val uri = Uri.parse(url)
    if (!isTrustedApkSource(uri)) {
      promise.reject("invalid_update_url", "Update APK URL must be an HTTPS GitHub release asset.")
      return
    }
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O &&
      !reactContext.packageManager.canRequestPackageInstalls()
    ) {
      promise.reject("install_permission_required", "Allow Dexyd to install unknown apps first.")
      return
    }

    try {
      val intent = Intent(reactContext, DexydInstallActivity::class.java).apply {
        action = DexydInstallActivity.ACTION_PREPARE_INSTALL
        addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        putExtra(DexydInstallActivity.EXTRA_APK_URL, url)
        putExtra(DexydInstallActivity.EXTRA_APK_NAME, sanitizeApkFileName(fileName))
      }
      reactContext.startActivity(intent)
      promise.resolve("foreground-installer")
    } catch (error: Exception) {
      promise.reject("update_install_failed", "Could not open Dexyd update installer: ${error.message ?: "unknown error"}", error)
    }
  }

  private fun isTrustedApkSource(uri: Uri): Boolean {
    val host = uri.host?.lowercase(Locale.US) ?: return false
    return uri.scheme.equals("https", ignoreCase = true) &&
      (host == "github.com" || host.endsWith(".github.com"))
  }

  private fun sanitizeApkFileName(fileName: String): String {
    val safe = fileName.replace(Regex("[^A-Za-z0-9._-]"), "_").take(96)
    val nonEmpty = safe.ifBlank { "dexyd-update.apk" }
    return if (nonEmpty.endsWith(".apk", ignoreCase = true)) nonEmpty else "$nonEmpty.apk"
  }
}
