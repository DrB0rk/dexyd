package com.dexydmobile

import android.app.DownloadManager
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.database.Cursor
import android.net.Uri
import android.os.Build
import android.os.Environment
import android.provider.Settings
import android.widget.Toast
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod

class DexydUpdaterModule(
  private val reactContext: ReactApplicationContext,
) : ReactContextBaseJavaModule(reactContext) {
  private var activeReceiver: BroadcastReceiver? = null

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
    try {
      val uri = Uri.parse(url)
      if (uri.scheme != "https") {
        promise.reject("invalid_update_url", "Update APK URL must use HTTPS.")
        return
      }
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O &&
        !reactContext.packageManager.canRequestPackageInstalls()
      ) {
        promise.reject("install_permission_required", "Allow Dexyd to install unknown apps first.")
        return
      }

      val safeFileName = sanitizeApkFileName(fileName)
      val manager = reactContext.getSystemService(Context.DOWNLOAD_SERVICE) as DownloadManager
      val request = DownloadManager.Request(uri).apply {
        setTitle("Dexyd update")
        setDescription("Downloading $safeFileName")
        setMimeType(APK_MIME_TYPE)
        setAllowedOverMetered(true)
        setAllowedOverRoaming(false)
        setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED)
        setDestinationInExternalFilesDir(
          reactContext,
          Environment.DIRECTORY_DOWNLOADS,
          safeFileName,
        )
      }

      unregisterReceiver()
      val downloadId = manager.enqueue(request)
      val receiver = object : BroadcastReceiver() {
        override fun onReceive(context: Context, intent: Intent) {
          val completedId = intent.getLongExtra(DownloadManager.EXTRA_DOWNLOAD_ID, -1L)
          if (completedId != downloadId) return
          unregisterReceiver()
          openDownloadedApk(manager, downloadId)
        }
      }
      activeReceiver = receiver
      val filter = IntentFilter(DownloadManager.ACTION_DOWNLOAD_COMPLETE)
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
        reactContext.registerReceiver(receiver, filter, Context.RECEIVER_NOT_EXPORTED)
      } else {
        reactContext.registerReceiver(receiver, filter)
      }

      Toast.makeText(reactContext, "Downloading Dexyd update…", Toast.LENGTH_SHORT).show()
      promise.resolve(downloadId.toString())
    } catch (error: Exception) {
      unregisterReceiver()
      promise.reject("update_download_failed", "Could not download Dexyd update.", error)
    }
  }

  private fun openDownloadedApk(manager: DownloadManager, downloadId: Long) {
    try {
      val query = DownloadManager.Query().setFilterById(downloadId)
      val status = manager.query(query).use { cursor -> readDownloadStatus(cursor) }
      if (status != DownloadManager.STATUS_SUCCESSFUL) {
        Toast.makeText(reactContext, "Dexyd update download failed.", Toast.LENGTH_LONG).show()
        return
      }
      val apkUri = manager.getUriForDownloadedFile(downloadId)
      if (apkUri == null) {
        Toast.makeText(reactContext, "Downloaded APK could not be opened.", Toast.LENGTH_LONG).show()
        return
      }
      val installIntent = Intent(Intent.ACTION_VIEW).apply {
        setDataAndType(apkUri, APK_MIME_TYPE)
        addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
      }
      reactContext.startActivity(installIntent)
    } catch (error: Exception) {
      Toast.makeText(reactContext, "Could not open Android installer.", Toast.LENGTH_LONG).show()
    }
  }

  private fun readDownloadStatus(cursor: Cursor?): Int {
    if (cursor == null || !cursor.moveToFirst()) return DownloadManager.STATUS_FAILED
    return cursor.getInt(cursor.getColumnIndexOrThrow(DownloadManager.COLUMN_STATUS))
  }

  private fun unregisterReceiver() {
    val receiver = activeReceiver ?: return
    try {
      reactContext.unregisterReceiver(receiver)
    } catch (_: IllegalArgumentException) {
      // Already unregistered.
    } finally {
      activeReceiver = null
    }
  }

  private fun sanitizeApkFileName(fileName: String): String {
    val safe = fileName.replace(Regex("[^A-Za-z0-9._-]"), "_").take(96)
    val nonEmpty = safe.ifBlank { "dexyd-update.apk" }
    return if (nonEmpty.endsWith(".apk", ignoreCase = true)) nonEmpty else "$nonEmpty.apk"
  }

  companion object {
    private const val APK_MIME_TYPE = "application/vnd.android.package-archive"
  }
}
