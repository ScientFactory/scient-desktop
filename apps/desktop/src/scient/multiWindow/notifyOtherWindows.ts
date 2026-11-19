import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import * as ElectronWindow from "../../electron/ElectronWindow.ts";
import type { DesktopIpcInvokeEvent } from "../../ipc/DesktopIpc.ts";

class WindowNotifyError extends Schema.TaggedError<WindowNotifyError>()("WindowNotifyError", {
  cause: Schema.Defect(),
}) {}

/**
 * Tells every app window except the one that made a change that shared state changed. All
 * windows share one origin but keep their own renderer state; windows without a listener ignore it.
 */
export const notifyOtherWindows = Effect.fn("scient.multiWindow.notifyOtherWindows")(function* (
  sender: DesktopIpcInvokeEvent | undefined,
  channel: string,
  ...args: ReadonlyArray<unknown>
) {
  const electronWindow = yield* ElectronWindow.ElectronWindow;
  for (const window of yield* electronWindow.appWindows) {
    yield* Effect.try({
      try: () => {
        if (window.webContents.id !== sender?.sender.id) window.webContents.send(channel, ...args);
      },
      catch: (cause) => new WindowNotifyError({ cause }),
    }).pipe(
      Effect.catch((error) =>
        Effect.logWarning("Could not notify an app window of a shared change", error.cause).pipe(
          Effect.annotateLogs({ channel }),
        ),
      ),
    );
  }
});
