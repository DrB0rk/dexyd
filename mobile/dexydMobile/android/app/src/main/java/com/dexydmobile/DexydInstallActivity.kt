package com.dexydmobile

import android.app.Activity
import android.content.ActivityNotFoundException
import android.content.Intent
import android.net.Uri
import android.os.Bundle
import android.view.Gravity
import android.view.View
import android.widget.LinearLayout
import android.widget.ProgressBar
import android.widget.TextView
import android.widget.Toast
import androidx.core.content.FileProvider
import java.io.BufferedInputStream
import java.io.File
import java.io.FileOutputStream
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
      try {
        val apkFile = downloadApkToCache(url, apkName)
        setStatus("Preparing Dexyd update", "Opening Android update prompt…")
        runOnUiThread { openSystemInstaller(apkFile) }
      } catch (error: Exception) {
        showErrorAndFinish("Dexyd update failed: ${error.message ?: "unknown error"}")
      }
    }
  }

  private fun downloadApkToCache(url: String, apkName: String): File {
    val updateDir = File(cacheDir, UPDATE_CACHE_DIR).apply {
      if (!exists() && !mkdirs()) {
        throw IOException("Could not create update cache.")
      }
    }
    updateDir.listFiles()?.forEach { file ->
      if (file.isFile) file.delete()
    }

    var connection: HttpURLConnection? = null
    val apkFile = File(updateDir, apkName)
    try {
      connection = openApkConnection(url)
      val contentLength = connection.contentLengthLong.takeIf { it > 0L } ?: -1L
      BufferedInputStream(connection.inputStream).use { input ->
        FileOutputStream(apkFile).use { output ->
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
          output.fd.sync()
        }
      }
      if (apkFile.length() <= 0L) {
        throw IOException("Downloaded update APK was empty.")
      }
      return apkFile
    } catch (error: Exception) {
      apkFile.delete()
      throw error
    } finally {
      connection?.disconnect()
    }
  }

  private fun openSystemInstaller(apkFile: File) {
    val apkUri = FileProvider.getUriForFile(this, "$packageName.fileprovider", apkFile)
    val installIntent = Intent(Intent.ACTION_INSTALL_PACKAGE).apply {
      data = apkUri
      addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
      putExtra(Intent.EXTRA_NOT_UNKNOWN_SOURCE, true)
      putExtra(Intent.EXTRA_RETURN_RESULT, false)
    }
    val fallbackIntent = Intent(Intent.ACTION_VIEW).apply {
      setDataAndType(apkUri, APK_MIME_TYPE)
      addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
      putExtra(Intent.EXTRA_NOT_UNKNOWN_SOURCE, true)
    }

    try {
      grantInstallerReadAccess(installIntent, apkUri)
      startActivity(installIntent)
      finish()
    } catch (_: ActivityNotFoundException) {
      try {
        grantInstallerReadAccess(fallbackIntent, apkUri)
        startActivity(fallbackIntent)
        finish()
      } catch (error: Exception) {
        showErrorAndFinish("Could not open Android update prompt: ${error.message ?: "unknown error"}")
      }
    } catch (error: Exception) {
      showErrorAndFinish("Could not open Android update prompt: ${error.message ?: "unknown error"}")
    }
  }

  private fun grantInstallerReadAccess(intent: Intent, apkUri: Uri) {
    val installers = packageManager.queryIntentActivities(intent, 0)
    installers.forEach { resolveInfo ->
      grantUriPermission(resolveInfo.activityInfo.packageName, apkUri, Intent.FLAG_GRANT_READ_URI_PERMISSION)
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
    const val EXTRA_APK_URL = "com.dexydmobile.extra.APK_URL"
    const val EXTRA_APK_NAME = "com.dexydmobile.extra.APK_NAME"

    private const val APK_MIME_TYPE = "application/vnd.android.package-archive"
    private const val UPDATE_CACHE_DIR = "dexyd-updates"
    private const val MAX_REDIRECTS = 5
    private val HTTP_REDIRECT_CODES = setOf(301, 302, 303, 307, 308)
  }
}
