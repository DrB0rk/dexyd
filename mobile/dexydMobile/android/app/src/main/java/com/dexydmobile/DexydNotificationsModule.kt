package com.dexydmobile

import android.Manifest
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.provider.Settings
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.modules.core.PermissionAwareActivity
import com.facebook.react.modules.core.PermissionListener
import java.util.concurrent.atomic.AtomicInteger

class DexydNotificationsModule(
  private val reactContext: ReactApplicationContext,
) : ReactContextBaseJavaModule(reactContext), PermissionListener {
  private var permissionPromise: Promise? = null

  override fun getName(): String = "DexydNotifications"

  @ReactMethod
  fun areNotificationsEnabled(promise: Promise) {
    promise.resolve(notificationsAllowed())
  }

  @ReactMethod
  fun requestNotificationsPermission(promise: Promise) {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU || notificationsAllowed()) {
      promise.resolve(true)
      return
    }

    val activity = reactApplicationContext.currentActivity
    if (activity !is PermissionAwareActivity) {
      promise.resolve(false)
      return
    }

    permissionPromise = promise
    activity.requestPermissions(
      arrayOf(Manifest.permission.POST_NOTIFICATIONS),
      NOTIFICATION_PERMISSION_REQUEST,
      this,
    )
  }

  @ReactMethod
  fun openNotificationSettings(promise: Promise) {
    try {
      val intent = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
        Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS).apply {
          putExtra(Settings.EXTRA_APP_PACKAGE, reactContext.packageName)
        }
      } else {
        Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS).apply {
          data = Uri.parse("package:${reactContext.packageName}")
        }
      }.apply {
        addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
      }
      reactContext.startActivity(intent)
      promise.resolve(true)
    } catch (error: Exception) {
      promise.reject("notification_settings_failed", "Could not open notification settings.", error)
    }
  }

  @ReactMethod
  fun showNotification(title: String, body: String, kind: String, sessionId: String?, promise: Promise) {
    try {
      if (!notificationsAllowed()) {
        promise.resolve(false)
        return
      }

      ensureChannel()
      val manager = reactContext.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
      val launchIntent = reactContext.packageManager.getLaunchIntentForPackage(reactContext.packageName)
        ?: Intent(reactContext, MainActivity::class.java)
      launchIntent.addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP)
      if (!sessionId.isNullOrBlank()) {
        launchIntent.putExtra("dexyd.sessionId", sessionId)
      }
      val pendingIntent = PendingIntent.getActivity(
        reactContext,
        nextNotificationId.get(),
        launchIntent,
        pendingIntentFlags(),
      )

      val notification = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
        Notification.Builder(reactContext, CHANNEL_ID)
      } else {
        @Suppress("DEPRECATION")
        Notification.Builder(reactContext)
      }
        .setSmallIcon(reactContext.applicationInfo.icon)
        .setContentTitle(title.take(80))
        .setContentText(body.take(140))
        .setStyle(Notification.BigTextStyle().bigText(body.take(1200)))
        .setContentIntent(pendingIntent)
        .setAutoCancel(true)
        .setShowWhen(true)
        .setCategory(notificationCategory(kind))
        .build()

      manager.notify(nextNotificationId.incrementAndGet(), notification)
      promise.resolve(true)
    } catch (error: Exception) {
      promise.reject("notification_failed", "Could not show notification.", error)
    }
  }

  override fun onRequestPermissionsResult(requestCode: Int, permissions: Array<String>, grantResults: IntArray): Boolean {
    if (requestCode != NOTIFICATION_PERMISSION_REQUEST) return false
    val granted = grantResults.firstOrNull() == PackageManager.PERMISSION_GRANTED
    permissionPromise?.resolve(granted)
    permissionPromise = null
    return true
  }

  private fun notificationsAllowed(): Boolean {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) return true
    return reactContext.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED
  }

  private fun ensureChannel() {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
    val manager = reactContext.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
    if (manager.getNotificationChannel(CHANNEL_ID) != null) return
    val channel = NotificationChannel(
      CHANNEL_ID,
      "Dexyd agent activity",
      NotificationManager.IMPORTANCE_DEFAULT,
    ).apply {
      description = "Responses, completed prompts, approvals, questions, and alerts from Dexyd."
    }
    manager.createNotificationChannel(channel)
  }

  private fun notificationCategory(kind: String): String {
    return when (kind.lowercase()) {
      "approval", "question" -> Notification.CATEGORY_STATUS
      "alert" -> Notification.CATEGORY_ERROR
      else -> Notification.CATEGORY_MESSAGE
    }
  }

  private fun pendingIntentFlags(): Int {
    val update = PendingIntent.FLAG_UPDATE_CURRENT
    return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
      update or PendingIntent.FLAG_IMMUTABLE
    } else {
      update
    }
  }

  companion object {
    private const val CHANNEL_ID = "dexyd_agent_activity"
    private const val NOTIFICATION_PERMISSION_REQUEST = 4205
    private val nextNotificationId = AtomicInteger(1000)
  }
}
