import { app } from "electron";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { ElectronWindow } from "../../electron/ElectronWindow.ts";
import { makeIpcMethod } from "../../ipc/DesktopIpc.ts";
import { SET_UNREAD_ANSWER_COUNT_CHANNEL } from "../../ipc/channels.ts";

export const UnreadAnswerCount = Schema.Finite.check(
  Schema.isInt(),
  Schema.isGreaterThanOrEqualTo(0),
  Schema.isLessThanOrEqualTo(1_000_000),
);

export const setUnreadAnswerCount = makeIpcMethod({
  channel: SET_UNREAD_ANSWER_COUNT_CHANNEL,
  payload: UnreadAnswerCount,
  result: Schema.Boolean,
  handler: Effect.fn("scient.answerAttention.setCount")(function* (count, event) {
    const windows = yield* ElectronWindow;
    const main = yield* windows.main;
    // Browser previews and other guest renderers cannot control the app badge.
    if (Option.isNone(main) || main.value.webContents.id !== event?.sender.id) return false;
    return yield* Effect.sync(() => (app.dock ? app.setBadgeCount(count) : false));
  }),
});
