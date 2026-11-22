import * as Electron from "electron";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import * as DesktopIpc from "../../ipc/DesktopIpc.ts";
import { SET_RUNNING_WORK_CHANNEL } from "../../ipc/channels.ts";

/** How many runs quitting would stop, as the app last reported. */
let runningWork = 0;

export const installRunningWorkReport = Effect.gen(function* () {
  const ipc = yield* DesktopIpc.DesktopIpc;
  yield* ipc.handle(
    DesktopIpc.makeIpcMethod({
      channel: SET_RUNNING_WORK_CHANNEL,
      payload: Schema.Int,
      result: Schema.Void,
      handler: (count) =>
        Effect.sync(() => {
          runningWork = count;
        }),
    }),
  );
});

/** Whether to go on quitting. Nothing keeps a run alive past Quit yet, so it asks first. */
export function confirmQuitStopsRunningWork(): boolean {
  if (runningWork === 0) return true;
  const choice = Electron.dialog.showMessageBoxSync({
    type: "warning",
    message: runningWork === 1 ? "Stop the running job and quit?" : "Stop running jobs and quit?",
    detail:
      runningWork === 1
        ? "One run is still going. Quitting stops it."
        : `${runningWork} runs are still going or waiting. Quitting stops them.`,
    buttons: ["Stop and quit", "Keep running"],
    defaultId: 1,
    cancelId: 1,
  });
  return choice === 0;
}
