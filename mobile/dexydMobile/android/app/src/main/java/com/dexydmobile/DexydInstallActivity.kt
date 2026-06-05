package com.dexydmobile

import android.app.Activity
import android.app.PendingIntent
import android.content.Intent
import android.content.pm.PackageInstaller
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.view.Gravity
import android.view.View
import android.widget.LinearLayout
import android.widget.ProgressBar
import android.widget.TextView
import android.widget.Toast
import java.io.BufferedInputStream
import java.io.IOException
import java.net.HttpURLConnection
import java.net.URL
import java.util.Locale
import java.util.concurrent.Executors

class DexydInstallActivity : Activity() {
  private val executor = Executors.newSingleThreadExecutor()
  private lateinit var titleView: TextView
  private lateinit var detailView: TextView
  private lateinit var progressBar: ProgressBar

  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)
    setContentView(createContentView())
    handleIntent(intent)
  }

  override fun onNewIntent(intent: Intent) {
    super.onNewIntent(intent)
    handleIntent(intent)
  }

  override fun onDestroy() {
    executor.shutdownNow()
    super.onDestroy()
  }

  private fun handleIntent(intent: Intent?) {
    when (intent?.action) {
      ACTION_PREPARE_INSTALL -> prepareInstall(intent)
      ACTION_INSTALL_COMMIT -> handleInstallCommit(intent)
      else -> finish()
    }
  }

  private fun prepareInstall(intent: Intent) {
    val url = intent.getStringExtra(EXTRA_APK_URL)
    val apkName = sanitizeApkFileName(intent.getStringExtra(EXTRA_APK_NAME) ?: "dexyd-update.apk")
    if (url.isNullOrBlank() || !isTrustedApkSource(Uri.parse(url))) {
      showErrorAndFinish("Update APK URL is not trusted.")
      return
    }

    setStatus("Preparing Dexyd update", "Downloading $apkName…")
    executor.execute {
      var sessionId = -1
      var installer: PackageInstaller? = null
      var connection: HttpURLConnection? = null
      try {
        installer = packageManager.packageInstaller
        val params = PackageInstaller.SessionParams(PackageInstaller.SessionParams.MODE_FULL_INSTALL).apply {
          setAppPackageName(packageName)
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
            session.openWrite(apkName, 0, contentLength).use { output ->
              val buffer = ByteArray(DEFAULT_BUFFER_SIZE)
              var copied = 0L
              var lastProgress = -1
              while (true) {
                val read = input.read(buffer)
                if (read <= 0) break
                output.write(buffer, 0, read)
                copied += read.toLong()
                if (contentLength > 0L) {
                  val progress = ((copied * 100L) / contentLength).toInt().coerceIn(0, 100)
                  if (progress != lastProgress && (progress == 100 || progress - lastProgress >= 5)) {
                    lastProgress = progress
                    setStatus("Preparing Dexyd update", "Downloading $apkName… $progress%")
                  }
                }
              }
              session.fsync(output)
            }
          }

          setStatus("Preparing Dexyd update", "Opening Android update prompt…")
          val callback = Intent(this, DexydInstallActivity::class.java).apply {
            action = ACTION_INSTALL_COMMIT
            putExtra(EXTRA_APK_NAME, apkName)
          }
          val pendingIntent = PendingIntent.getActivity(
            this,
            sessionId,
            callback,
            pendingIntentFlags(),
          )
          session.commit(pendingIntent.intentSender)
        }
      } catch (error: Exception) {
        if (sessionId != -1) {
          try {
            installer?.abandonSession(sessionId)
          } catch (_: Exception) {
            // Best-effort cleanup; original failure is reported below.
          }
        }
        showErrorAndFinish("Dexyd update failed: ${error.message ?: "unknown error"}")
      } finally {
        connection?.disconnect()
      }
    }
  }

  private fun handleInstallCommit(intent: Intent) {
    when (intent.getIntExtra(PackageInstaller.EXTRA_STATUS, PackageInstaller.STATUS_FAILURE)) {
      PackageInstaller.STATUS_PENDING_USER_ACTION -> openConfirmation(intent)
      PackageInstaller.STATUS_SUCCESS -> {
        Toast.makeText(this, "Dexyd update installed.", Toast.LENGTH_LONG).show()
        finish()
      }
      else -> {
        val message = intent.getStringExtra(PackageInstaller.EXTRA_STATUS_MESSAGE) ?: "unknown error"
        showErrorAndFinish("Dexyd update failed: $message")
      }
    }
  }

  private fun openConfirmation(intent: Intent) {
    val confirmation = getConfirmationIntent(intent)
    if (confirmation == null) {
      showErrorAndFinish("Android installer prompt was unavailable.")
      return
    }
    try {
      startActivity(confirmation)
      finish()
    } catch (error: Exception) {
      showErrorAndFinish("Could not open Android update prompt: ${error.message ?: "unknown error"}")
    }
  }

  private fun getConfirmationIntent(intent: Intent): Intent? {
    return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
      intent.getParcelableExtra(Intent.EXTRA_INTENT, Intent::class.java)
    } else {
      @Suppress("DEPRECATION")
      intent.getParcelableExtra(Intent.EXTRA_INTENT)
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
      connection.readTimeout = 120_000
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

  private fun createContentView(): View {
    val density = resources.displayMetrics.density
    fun dp(value: Int): Int = (value * density).toInt()

    val root = LinearLayout(this).apply {
      orientation = LinearLayout.VERTICAL
      gravity = Gravity.CENTER
      setPadding(dp(28), dp(28), dp(28), dp(28))
      setBackgroundColor(0xFF181818.toInt())
    }
    titleView = TextView(this).apply {
      text = "Preparing Dexyd update"
      textSize = 20f
      setTextColor(0xFFF4F4F4.toInt())
      gravity = Gravity.CENTER
    }
    detailView = TextView(this).apply {
      text = "Starting…"
      textSize = 14f
      setTextColor(0xFFBDBDBD.toInt())
      gravity = Gravity.CENTER
      setPadding(0, dp(10), 0, dp(20))
    }
    progressBar = ProgressBar(this).apply {
      isIndeterminate = true
    }

    root.addView(titleView)
    root.addView(detailView)
    root.addView(progressBar)
    return root
  }

  private fun setStatus(title: String, detail: String) {
    runOnUiThread {
      titleView.text = title
      detailView.text = detail
    }
  }

  private fun showErrorAndFinish(message: String) {
    runOnUiThread {
      Toast.makeText(this, message, Toast.LENGTH_LONG).show()
      finish()
    }
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

  private fun sanitizeApkFileName(fileName: String): String {
    val safe = fileName.replace(Regex("[^A-Za-z0-9._-]"), "_").take(96)
    val nonEmpty = safe.ifBlank { "dexyd-update.apk" }
    return if (nonEmpty.endsWith(".apk", ignoreCase = true)) nonEmpty else "$nonEmpty.apk"
  }

  companion object {
    const val ACTION_PREPARE_INSTALL = "com.dexydmobile.UPDATE_PREPARE_INSTALL"
    const val ACTION_INSTALL_COMMIT = "com.dexydmobile.UPDATE_INSTALL_COMMIT"
    const val EXTRA_APK_URL = "com.dexydmobile.extra.APK_URL"
    const val EXTRA_APK_NAME = "com.dexydmobile.extra.APK_NAME"

    private const val APK_MIME_TYPE = "application/vnd.android.package-archive"
    private const val MAX_REDIRECTS = 5
    private val HTTP_REDIRECT_CODES = setOf(301, 302, 303, 307, 308)
  }
}
