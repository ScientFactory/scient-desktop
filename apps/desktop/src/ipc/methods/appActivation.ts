import { DesktopAppActivationResponse } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import * as DesktopAppActivation from "../../app/DesktopAppActivation.ts";
// SCIENT-FORK:START — standing dev app controller channel
import { noteDevLaunchRendererReady } from "../../scient/devLaunch/DevLaunchControl.ts";
// SCIENT-FORK:END
import * as IpcChannels from "../channels.ts";
import * as DesktopIpc from "../DesktopIpc.ts";

export const setReady = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.DESKTOP_APP_ACTIVATION_READY_CHANNEL,
  payload: Schema.Boolean,
  result: Schema.Void,
  // SCIENT-FORK:START — each app window reports its own readiness.
  handler: Effect.fn("desktop.ipc.appActivation.setReady")(function* (ready, event) {
    const activation = yield* DesktopAppActivation.DesktopAppActivation;
    yield* activation.setRendererReady(ready, event?.sender.id);
    // SCIENT-FORK:END
    // SCIENT-FORK:START — readiness for the standing dev app's controller.
    noteDevLaunchRendererReady(ready, event?.sender.id);
    // SCIENT-FORK:END
  }),
});

export const complete = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.DESKTOP_APP_ACTIVATION_COMPLETE_CHANNEL,
  payload: DesktopAppActivationResponse,
  result: Schema.Void,
  handler: Effect.fn("desktop.ipc.appActivation.complete")(function* (response) {
    const activation = yield* DesktopAppActivation.DesktopAppActivation;
    yield* activation.complete(response);
  }),
});
