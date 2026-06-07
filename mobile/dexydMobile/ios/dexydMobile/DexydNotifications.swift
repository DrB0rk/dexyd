import Foundation
import React
import UIKit
import UserNotifications

@objc(DexydNotifications)
class DexydNotifications: NSObject {
  @objc static func requiresMainQueueSetup() -> Bool {
    false
  }

  @objc(areNotificationsEnabled:rejecter:)
  func areNotificationsEnabled(
    _ resolve: @escaping RCTPromiseResolveBlock,
    rejecter reject: @escaping RCTPromiseRejectBlock
  ) {
    UNUserNotificationCenter.current().getNotificationSettings { settings in
      switch settings.authorizationStatus {
      case .authorized, .provisional, .ephemeral:
        resolve(true)
      default:
        resolve(false)
      }
    }
  }

  @objc(requestNotificationsPermission:rejecter:)
  func requestNotificationsPermission(
    _ resolve: @escaping RCTPromiseResolveBlock,
    rejecter reject: @escaping RCTPromiseRejectBlock
  ) {
    UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .badge, .sound]) { granted, error in
      if let error = error {
        reject("notification_permission_failed", error.localizedDescription, error)
        return
      }
      resolve(granted)
    }
  }

  @objc(openNotificationSettings:rejecter:)
  func openNotificationSettings(
    _ resolve: @escaping RCTPromiseResolveBlock,
    rejecter reject: @escaping RCTPromiseRejectBlock
  ) {
    DispatchQueue.main.async {
      guard let url = URL(string: UIApplication.openSettingsURLString) else {
        resolve(false)
        return
      }
      UIApplication.shared.open(url, options: [:]) { opened in
        resolve(opened)
      }
    }
  }

  @objc(showNotification:body:kind:sessionId:resolver:rejecter:)
  func showNotification(
    _ title: String,
    body: String,
    kind: String,
    sessionId: String?,
    resolver resolve: @escaping RCTPromiseResolveBlock,
    rejecter reject: @escaping RCTPromiseRejectBlock
  ) {
    let content = UNMutableNotificationContent()
    content.title = title
    content.body = body
    content.sound = .default
    content.userInfo = [
      "kind": kind,
      "sessionId": sessionId ?? "",
    ]

    let request = UNNotificationRequest(
      identifier: "dexyd-\(UUID().uuidString)",
      content: content,
      trigger: nil
    )

    UNUserNotificationCenter.current().add(request) { error in
      if let error = error {
        reject("notification_show_failed", error.localizedDescription, error)
        return
      }
      resolve(true)
    }
  }
}
