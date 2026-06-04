package com.dexydmobile

import android.app.PendingIntent
import android.content.Intent
import android.content.pm.PackageInstaller
import android.net.Uri
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.provider.Settings
import android.widget.Toast
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import java.io.BufferedInputStream
import java.io.IOException
import java.net.HttpURLConnection
import java.net.URL
import java.util.Locale
import java.util.concurrent.Executors

class DexydUpdaterModule(
  private val reactContext: ReactApplicationContext,
) : ReactContextBaseJavaModule(reactContext) {
  private val executor = Executors.newSingleThreadExecutor()
  private val mainHandler = Handler(Looper.getMainLooper())

  override fun getName(): String = "DexydUpdater"

  override fun invalidate() {
    executor.shutdownNow()
    super.invalidate()
  }

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

    val safeFileName = sanitizeApkFileName(fileName)
    showToast("Preparing Dexyd update…")

    executor.execute {
      var sessionId = -1
      var installer: PackageInstaller? = null
      var connection: HttpURLConnection? = null
      try {
        installer = reactContext.packageManager.packageInstaller
        val params = PackageInstaller.SessionParams(PackageInstaller.SessionParams.MODE_FULL_INSTALL).apply {
          setAppPackageName(reactContext.packageName)
          if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            setPackageSource(PackageInstaller.PACKAGE_SOURCE_DOWNLOADED_FILE)
          }
          if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            setRequireUserAction(PackageInstaller.SessionParams.USER_ACTION_REQUIRED)
          }
        }
        sessionId = installer.createSession(params)

        connection = openApkConnection(url)
        val contentLength = connection.contentLengthLong.takeIf { it > 0L } ?: -1L

        installer.openSession(sessionId).use { session ->
          BufferedInputStream(connection.inputStream).use { input ->
            session.openWrite(safeFileName, 0, contentLength).use { output ->
              input.copyTo(output)
              session.fsync(output)
            }
          }

          val callback = Intent(reactContext, DexydInstallReceiver::class.java).apply {
            action = DexydInstallReceiver.ACTION_INSTALL_COMMIT
            putExtra(DexydInstallReceiver.EXTRA_APK_NAME, safeFileName)
          }
          val pendingIntent = PendingIntent.getBroadcast(
            reactContext,
            sessionId,
            callback,
            pendingIntentFlags(),
          )
          session.commit(pendingIntent.intentSender)
        }

        showToast("Opening Android installer…")
        promise.resolve(sessionId.toString())
      } catch (error: Exception) {
        if (sessionId != -1) {
          try {
            installer?.abandonSession(sessionId)
          } catch (_: Exception) {
            // Best-effort cleanup; original failure is reported below.
          }
        }
        showToast("Dexyd update could not be prepared.", Toast.LENGTH_LONG)
        promise.reject("update_install_failed", "Could not stage Dexyd update for Android installer.", error)
      } finally {
        connection?.disconnect()
      }
    }
  }

  private fun openApkConnection(url: String): HttpURLConnection {
    var currentUrl = URL(url)
    repeat(MAX_REDIRECTS + 1) { redirectCount ->
      if (currentUrl.protocol?.lowercase(Locale.US) != "https") {
        throw SecurityException("Update download redirected away from HTTPS.")
      }

      val connection = currentUrl.openConnection()
      if (connection !is HttpURLConnection) {
        throw IOException("Update URL did not create an HTTP connection.")
      }
      connection.instanceFollowRedirects = false
      connection.connectTimeout = 20_000
      connection.readTimeout = 90_000
      connection.setRequestProperty("Accept", "$APK_MIME_TYPE, application/octet-stream")
      connection.setRequestProperty("User-Agent", "Dexyd Android updater")
      connection.connect()

      val status = connection.responseCode
      if (status in HTTP_REDIRECT_CODES) {
        if (redirectCount == MAX_REDIRECTS) {
          connection.disconnect()
          throw IOException("Update download redirected too many times.")
        }
        val location = connection.getHeaderField("Location")
        connection.disconnect()
        if (location.isNullOrBlank()) {
          throw IOException("Update download redirect had no location.")
        }
        currentUrl = URL(currentUrl, location)
        return@repeat
      }

      if (status !in 200..299) {
        connection.disconnect()
        throw IOException("Update download failed with HTTP $status.")
      }
      return connection
    }
    throw IOException("Update download redirected too many times.")
  }

  private fun pendingIntentFlags(): Int {
    val update = PendingIntent.FLAG_UPDATE_CURRENT
    return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
      update or PendingIntent.FLAG_MUTABLE
    } else {
      update
    }
  }

  private fun isTrustedApkSource(uri: Uri): Boolean {
    val host = uri.host?.lowercase(Locale.US) ?: return false
    return uri.scheme.equals("https", ignoreCase = true) &&
      (host == "github.com" || host.endsWith(".github.com"))
  }

  private fun showToast(message: String, length: Int = Toast.LENGTH_SHORT) {
    mainHandler.post {
      Toast.makeText(reactContext, message, length).show()
    }
  }

  private fun sanitizeApkFileName(fileName: String): String {
    val safe = fileName.replace(Regex("[^A-Za-z0-9._-]"), "_").take(96)
    val nonEmpty = safe.ifBlank { "dexyd-update.apk" }
    return if (nonEmpty.endsWith(".apk", ignoreCase = true)) nonEmpty else "$nonEmpty.apk"
  }

  companion object {
    private const val APK_MIME_TYPE = "application/vnd.android.package-archive"
    private const val MAX_REDIRECTS = 5
    private val HTTP_REDIRECT_CODES = setOf(301, 302, 303, 307, 308)
  }
}
