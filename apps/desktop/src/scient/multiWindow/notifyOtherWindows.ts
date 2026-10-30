import * as Electron from "electron";
import * as Effect from "effect/Effect";

import type { DesktopIpcInvokeEvent } from "../../ipc/DesktopIpc.ts";

/**
 * Tells every app window except the one that made a change that shared state changed. All
 * windows share one origin but keep their own renderer state; windows without a listener ignore it.
 */
export const notifyOtherWindows = Effect.fn("scient.multiWindow.notifyOtherWindows")(function* (
  sender: DesktopIpcInvokeEvent | undefined,
  channel: string,
  ...args: ReadonlyArray<unknown>
) {
  const windows = yield* Effect.sync(() => Electron.BrowserWindow.getAllWindows());
  for (const window of windows) {
    const failure = yield* Effect.sync(() => {
      try {
        if (!window.isDestroyed() && window.webContents.id !== sender?.sender.id) {
          window.webContents.send(channel, ...args);
        }
        return null;
      } catch (cause) {
        return { cause };
      }
    });
    if (failure !== null) {
      yield* Effect.logWarning(
        "Could not notify an app window of a shared change",
        failure.cause,
      ).pipe(Effect.annotateLogs({ channel }));
    }
  }
});
