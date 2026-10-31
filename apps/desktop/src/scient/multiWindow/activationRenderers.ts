import type { DesktopAppActivationRequest } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import type * as Electron from "electron";

import type { DesktopAppActivationBroker } from "../../app/DesktopAppActivationBroker.ts";
import type * as ElectronWindow from "../../electron/ElectronWindow.ts";
import { ReadyRenderers } from "./appWindows.ts";

/**
 * Hands app activation requests to the most recently focused ready app window. When the window
 * handling a request goes away, only that request fails; queued requests go to another ready
 * window. Returns the function each window's readiness reports go to.
 */
export function makeActivationRenderers(
  broker: Pick<DesktopAppActivationBroker, "registerRenderer" | "clearRenderer">,
  electronWindow: Pick<ElectronWindow.ElectronWindow["Service"], "appWindows">,
  send: (window: Electron.BrowserWindow, request: DesktopAppActivationRequest) => void,
): (window: Electron.BrowserWindow, ready: boolean) => void {
  let handling: Electron.BrowserWindow | null = null;
  const dispatch = (request: DesktopAppActivationRequest) => {
    const target = readyRenderers.pick(Effect.runSync(electronWindow.appWindows));
    if (Option.isNone(target)) throw new Error("No Scient window is ready.");
    handling = target.value;
    send(target.value, request);
  };
  const readyRenderers = new ReadyRenderers((window) => {
    if (window === handling || readyRenderers.size === 0) {
      handling = null;
      broker.clearRenderer();
    }
    if (readyRenderers.size > 0) broker.registerRenderer(dispatch);
  });
  return (window, ready) => {
    if (!ready) {
      readyRenderers.delete(window);
      return;
    }
    readyRenderers.add(window);
    broker.registerRenderer(dispatch);
  };
}
