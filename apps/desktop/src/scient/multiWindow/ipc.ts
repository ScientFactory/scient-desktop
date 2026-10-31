import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { ElectronWindow } from "../../electron/ElectronWindow.ts";
import { OPEN_NEW_WINDOW_CHANNEL } from "../../ipc/channels.ts";
import { makeIpcMethod } from "../../ipc/DesktopIpc.ts";
import { DesktopWindow } from "../../window/DesktopWindow.ts";
import { appWindowForSender } from "./appWindows.ts";

export const openNewWindow = makeIpcMethod({
  channel: OPEN_NEW_WINDOW_CHANNEL,
  payload: Schema.UndefinedOr(
    Schema.Struct({
      route: Schema.optional(Schema.String),
      atCursor: Schema.optional(Schema.Boolean),
    }),
  ),
  result: Schema.Boolean,
  handler: Effect.fn("desktop.ipc.window.openNewWindow")(function* (input, event) {
    // Guest webviews and other windows cannot open app windows.
    if (Option.isNone(yield* appWindowForSender(yield* ElectronWindow, event?.sender.id))) {
      return false;
    }
    const desktopWindow = yield* DesktopWindow;
    return yield* desktopWindow.openNewWindow(input?.route, { atCursor: input?.atCursor });
  }),
});
