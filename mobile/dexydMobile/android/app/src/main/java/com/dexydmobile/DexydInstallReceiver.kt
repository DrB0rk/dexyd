package com.dexydmobile

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.pm.PackageInstaller
import android.os.Build
import android.widget.Toast

class DexydInstallReceiver : BroadcastReceiver() {
  override fun onReceive(context: Context, intent: Intent) {
    if (intent.action != ACTION_INSTALL_COMMIT) return

    when (intent.getIntExtra(PackageInstaller.EXTRA_STATUS, PackageInstaller.STATUS_FAILURE)) {
      PackageInstaller.STATUS_PENDING_USER_ACTION -> openConfirmation(context, intent)
      PackageInstaller.STATUS_SUCCESS -> {
        Toast.makeText(context, "Dexyd update installed.", Toast.LENGTH_LONG).show()
      }
      else -> {
        val message = intent.getStringExtra(PackageInstaller.EXTRA_STATUS_MESSAGE) ?: "unknown error"
        Toast.makeText(context, "Dexyd update failed: $message", Toast.LENGTH_LONG).show()
      }
    }
  }

  private fun openConfirmation(context: Context, intent: Intent) {
    val confirmation = getConfirmationIntent(intent)
    if (confirmation == null) {
      Toast.makeText(context, "Android installer prompt was unavailable.", Toast.LENGTH_LONG).show()
      return
    }
    confirmation.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
    context.startActivity(confirmation)
  }

  private fun getConfirmationIntent(intent: Intent): Intent? {
    return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
      intent.getParcelableExtra(Intent.EXTRA_INTENT, Intent::class.java)
    } else {
      @Suppress("DEPRECATION")
      intent.getParcelableExtra(Intent.EXTRA_INTENT)
    }
  }

  companion object {
    const val ACTION_INSTALL_COMMIT = "com.dexydmobile.UPDATE_INSTALL_COMMIT"
    const val EXTRA_APK_NAME = "com.dexydmobile.extra.APK_NAME"
  }
}
