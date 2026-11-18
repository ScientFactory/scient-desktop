import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { DesktopUpdateSave } from "../../app/DesktopUpdateSave.ts";
import { ElectronWindow } from "../../electron/ElectronWindow.ts";
import * as DesktopIpc from "../DesktopIpc.ts";
import { COMPLETE_UPDATE_SAVE_CHANNEL } from "../channels.ts";

export const complete = DesktopIpc.makeIpcMethod({
  channel: COMPLETE_UPDATE_SAVE_CHANNEL,
  payload: Schema.Struct({
    requestId: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(128)),
    saved: Schema.Boolean,
  }),
  result: Schema.Boolean,
  handler: Effect.fn("desktop.updateSave.complete")(function* (input, event) {
    if (event === undefined) return false;
    const windows = yield* (yield* ElectronWindow).appWindows;
    if (
      !windows.some(
        (window) =>
          !window.isDestroyed() &&
          window.webContents.id === event.sender.id &&
          window.webContents.mainFrame === event.senderFrame,
      )
    )
      return false;
    const service = yield* Effect.serviceOption(DesktopUpdateSave);
    return Option.isSome(service)
      ? yield* service.value.acknowledge({
          ...input,
          senderId: event.sender.id,
          senderFrame: event.senderFrame,
        })
      : false;
  }),
});
