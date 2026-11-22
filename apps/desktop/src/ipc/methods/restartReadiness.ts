import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as DesktopRestartTiming from "../../app/DesktopRestartTiming.ts";
import * as ElectronWindow from "../../electron/ElectronWindow.ts";
import * as DesktopIpc from "../DesktopIpc.ts";
import * as IpcChannels from "../channels.ts";

const Token = Schema.Struct({
  attemptId: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(128)),
  launchId: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(128)),
});

const isAppFrame = Effect.fn("desktop.restartReadiness.isAppFrame")(function* (
  event: DesktopIpc.DesktopIpcInvokeEvent | undefined,
) {
  if (event === undefined) return false;
  const windows = yield* (yield* ElectronWindow.ElectronWindow).appWindows;
  return windows.some(
    (window) =>
      !window.isDestroyed() &&
      window.webContents.id === event.sender.id &&
      window.webContents.mainFrame === event.senderFrame,
  );
});

export const getToken = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.GET_RESTART_READINESS_TOKEN_CHANNEL,
  payload: Schema.Void,
  result: Schema.NullOr(Token),
  handler: Effect.fn("desktop.restartReadiness.getToken")(function* (_, event) {
    if (!(yield* isAppFrame(event))) return null;
    const timing = yield* Effect.serviceOption(DesktopRestartTiming.DesktopRestartTiming);
    return Option.isSome(timing) ? yield* timing.value.readinessToken : null;
  }),
});

export const reportReady = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.REPORT_WORKSPACE_READY_CHANNEL,
  payload: Schema.Struct({ ...Token.fields, projectRestored: Schema.Boolean }),
  result: Schema.Boolean,
  handler: Effect.fn("desktop.restartReadiness.reportReady")(function* (ack, event) {
    if (!(yield* isAppFrame(event))) return false;
    const timing = yield* Effect.serviceOption(DesktopRestartTiming.DesktopRestartTiming);
    return Option.isSome(timing) ? yield* timing.value.workspaceReady(ack) : false;
  }),
});
