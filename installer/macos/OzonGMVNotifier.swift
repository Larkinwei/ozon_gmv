import AppKit
import UserNotifications

struct NotificationInput {
  let title: String
  let message: String
  let destination: URL
}

/**
 Displays one native notification and handles notification-center activation.

 macOS may relaunch the app without command-line arguments when the user clicks
 an older notification, so delivery input is optional while click handling is not.
 */
final class NotificationAppDelegate: NSObject, NSApplicationDelegate, UNUserNotificationCenterDelegate {
  private let input: NotificationInput?
  private let center = UNUserNotificationCenter.current()

  init(input: NotificationInput?) {
    self.input = input
  }

  func applicationDidFinishLaunching(_ notification: Notification) {
    center.delegate = self
    guard let input = input else {
      // A response callback should arrive immediately when macOS relaunches the app after a click.
      DispatchQueue.main.asyncAfter(deadline: .now() + 30) {
        NSApplication.shared.terminate(nil)
      }
      return
    }
    checkAuthorizationAndDeliver(input)
  }

  func userNotificationCenter(
    _ center: UNUserNotificationCenter,
    willPresent notification: UNNotification,
    withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void
  ) {
    completionHandler([.banner, .sound])
  }

  func userNotificationCenter(
    _ center: UNUserNotificationCenter,
    didReceive response: UNNotificationResponse,
    withCompletionHandler completionHandler: @escaping () -> Void
  ) {
    if
      let destinationValue = response.notification.request.content.userInfo["destination"] as? String,
      let destination = URL(string: destinationValue)
    {
      NSWorkspace.shared.open(destination)
    }
    completionHandler()
    NSApplication.shared.terminate(nil)
  }

  private func checkAuthorizationAndDeliver(_ input: NotificationInput) {
    center.getNotificationSettings { [weak self] settings in
      DispatchQueue.main.async {
        guard let self = self else { return }
        switch settings.authorizationStatus {
        case .notDetermined:
          // Bring the one-time macOS permission sheet to the front for this menu-less helper app.
          NSApplication.shared.activate(ignoringOtherApps: true)
          self.requestAuthorizationAndDeliver(input)
        case .authorized, .provisional:
          self.deliver(input)
        case .denied:
          self.fail("macOS 通知权限未开启，请在系统设置 > 通知 > Ozon GMV 中允许通知")
        case .ephemeral:
          self.deliver(input)
        @unknown default:
          self.fail("无法识别当前 macOS 通知权限状态")
        }
      }
    }
  }

  private func requestAuthorizationAndDeliver(_ input: NotificationInput) {
    center.requestAuthorization(options: [.alert, .sound]) { [weak self] granted, error in
      DispatchQueue.main.async {
        guard let self = self else { return }
        if let error = error {
          self.fail("macOS 通知授权失败：\(error.localizedDescription)")
          return
        }
        guard granted else {
          self.fail("macOS 通知权限未开启，请在系统设置 > 通知 > Ozon GMV 中允许通知")
          return
        }
        self.deliver(input)
      }
    }
  }

  private func deliver(_ input: NotificationInput) {
    let content = UNMutableNotificationContent()
    content.title = input.title
    content.body = input.message
    content.sound = .default
    content.userInfo = ["destination": input.destination.absoluteString]

    let request = UNNotificationRequest(identifier: UUID().uuidString, content: content, trigger: nil)
    center.add(request) { [weak self] error in
      DispatchQueue.main.async {
        guard let self = self else { return }
        if let error = error {
          self.fail("macOS 通知投递失败：\(error.localizedDescription)")
          return
        }
        self.writeStandardOutput("DELIVERED")
        // macOS can relaunch this app later from Notification Center when it is clicked.
        DispatchQueue.main.asyncAfter(deadline: .now() + 15) {
          NSApplication.shared.terminate(nil)
        }
      }
    }
  }

  private func fail(_ message: String) {
    FileHandle.standardError.write(Data("\(message)\n".utf8))
    exit(EXIT_FAILURE)
  }

  private func writeStandardOutput(_ message: String) {
    FileHandle.standardOutput.write(Data("\(message)\n".utf8))
  }
}

/** Returns the value immediately following a named command-line argument. */
func argument(after name: String) -> String? {
  guard let index = CommandLine.arguments.firstIndex(of: name), index + 1 < CommandLine.arguments.count else {
    return nil
  }
  return CommandLine.arguments[index + 1]
}

/** Parses a delivery request, while allowing argument-free launches from Notification Center. */
func parseNotificationInput() -> NotificationInput? {
  let title = argument(after: "--title")
  let message = argument(after: "--message")
  let destinationValue = argument(after: "--open")

  if title == nil && message == nil && destinationValue == nil {
    return nil
  }
  guard
    let title = title,
    let message = message,
    let destinationValue = destinationValue,
    let destination = URL(string: destinationValue)
  else {
    fputs("Usage: OzonGMVNotifier --title TITLE --message MESSAGE --open URL\n", stderr)
    exit(EXIT_FAILURE)
  }
  return NotificationInput(title: title, message: message, destination: destination)
}

let application = NSApplication.shared
let delegate = NotificationAppDelegate(input: parseNotificationInput())
application.setActivationPolicy(.accessory)
application.delegate = delegate
application.run()
