import * as Electron from "electron";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as HostProcess from "@t3tools/shared/HostProcess";

import * as ElectronApp from "../../electron/ElectronApp.ts";
import { ElectronWindow } from "../../electron/ElectronWindow.ts";
import { appWindowForSender } from "../multiWindow/appWindows.ts";
import * as DesktopIpc from "../../ipc/DesktopIpc.ts";
import {
  SET_NOTIFICATION_BADGE_CHANNEL,
  SET_UNREAD_ANSWER_BADGE_CHANNEL,
} from "../../ipc/channels.ts";

export const UnreadAnswerBadge = Schema.Struct({
  count: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 1_000_000 })),
  // Windows has no badge API, only a taskbar overlay image, which the renderer draws.
  image: Schema.NullOr(
    Schema.String.check(
      Schema.isMaxLength(16_384),
      Schema.isPattern(/^data:image\/png;base64,[a-z0-9+/]+={0,2}$/i),
    ),
  ),
});

/** Shows the count on the macOS Dock, the Windows taskbar button, or a Linux launcher. */
export function applyUnreadAnswerBadge(
  platform: NodeJS.Platform,
  window: Electron.BrowserWindow | null,
  { count, image }: typeof UnreadAnswerBadge.Type,
): boolean {
  if (platform === "win32") {
    if (window === null || window.isDestroyed()) return false;
    const overlay = count > 0 && image ? Electron.nativeImage.createFromDataURL(image) : null;
    window.setOverlayIcon(
      overlay === null || overlay.isEmpty() ? null : overlay,
      count === 0
        ? ""
        : count === 1
          ? "1 thread with an unread answer"
          : `${count} threads with unread answers`,
    );
    return true;
  }
  // macOS shows Dock badges only to apps allowed to notify (electron/electron#22715). Electron
  // asks for that permission, badges included, when it first sets up notifications, which
  // isSupported() does; so the system asks once, the first time there is something to show.
  if (platform === "darwin" && count > 0) Electron.Notification.isSupported();
  return Electron.app.setBadgeCount(count);
}

// Upstream's notification renderer still reports how many notifications it has pending.
const PendingNotifications = Schema.Struct({
  count: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  image: Schema.NullOr(Schema.String),
});

/**
 * The app icon's only owner on desktop, in place of upstream's notification badge. It keeps that
 * handler's other duty: renderers dismiss their pending notifications (`onNotificationBadgeClear`)
 * when a window gains focus, when one arrives while a window has focus, and on quit.
 */
export const installUnreadAnswerBadge = Effect.fn("scient.answerAttention.installBadge")(
  function* () {
    const ipc = yield* DesktopIpc.DesktopIpc;
    const app = yield* ElectronApp.ElectronApp;
    const windows = yield* ElectronWindow;
    const platform = yield* HostProcess.Platform;
    const dismissNotifications = () => {
      for (const window of Electron.BrowserWindow.getAllWindows()) {
        if (!window.isDestroyed()) window.webContents.send(SET_NOTIFICATION_BADGE_CHANNEL);
      }
    };
    yield* ipc.handle(
      DesktopIpc.makeIpcMethod({
        channel: SET_UNREAD_ANSWER_BADGE_CHANNEL,
        payload: UnreadAnswerBadge,
        result: Schema.Boolean,
        handler: Effect.fn("scient.answerAttention.setBadge")(function* (badge, event) {
          // Browser previews and other guest renderers cannot control the app badge.
          const sender = yield* appWindowForSender(windows, event?.sender.id);
          if (Option.isNone(sender)) return false;
          return applyUnreadAnswerBadge(platform, sender.value, badge);
        }),
      }),
    );
    yield* ipc.handle(
      DesktopIpc.makeIpcMethod({
        channel: SET_NOTIFICATION_BADGE_CHANNEL,
        payload: PendingNotifications,
        result: Schema.Void,
        handler: ({ count }) =>
          Effect.sync(() => {
            if (count > 0 && Electron.BrowserWindow.getFocusedWindow()) dismissNotifications();
          }),
      }),
    );
    const shutDown = () => {
      // A Windows overlay closes with its window; some Linux launchers keep a count after exit.
      applyUnreadAnswerBadge(platform, null, { count: 0, image: null });
      dismissNotifications();
    };
    yield* app.on("browser-window-focus", dismissNotifications);
    yield* app.on("before-quit", shutDown);
    // Signal quits and relaunches close this scope, and the listener with it, before quitting.
    yield* Effect.addFinalizer(() => Effect.sync(shutDown));
  },
);
