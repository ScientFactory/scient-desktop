// @effect-diagnostics nodeBuiltinImport:off - Stands in for an Electron webContents.
import * as NodeEvents from "node:events";
import {
  DESKTOP_APP_ACTIVATION_PROTOCOL_VERSION,
  type DesktopAppActivationRequest,
  type DesktopAppActivationResponse,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import type * as Electron from "electron";
import { describe, expect, it } from "vite-plus/test";

import { DesktopAppActivationBroker } from "../../app/DesktopAppActivationBroker.ts";
import { makeActivationRenderers } from "./activationRenderers.ts";

function fakeWindow() {
  let destroyed = false;
  const webContents = Object.assign(new NodeEvents.EventEmitter(), {
    isDestroyed: () => destroyed,
  });
  const window = { isDestroyed: () => destroyed, webContents } as unknown as Electron.BrowserWindow;
  return {
    window,
    close: () => {
      destroyed = true;
      webContents.emit("destroyed");
    },
  };
}

const request = (requestId: string) =>
  ({
    version: DESKTOP_APP_ACTIVATION_PROTOCOL_VERSION,
    requestId,
    type: "open-workspace",
    workspaceRoot: "/work",
    platform: "darwin",
  }) as DesktopAppActivationRequest;

describe("makeActivationRenderers", () => {
  it("fails only the request a closing window handled and sends the queued one to another", async () => {
    const [first, second, third] = [fakeWindow(), fakeWindow(), fakeWindow()];
    const focusOrder = [third.window, second.window, first.window];
    const broker = new DesktopAppActivationBroker({ requestTimeoutMs: 60_000, activate: () => {} });
    const sent: Array<[Electron.BrowserWindow, string]> = [];
    const setReady = makeActivationRenderers(
      broker,
      { appWindows: Effect.sync(() => focusOrder.filter((window) => !window.isDestroyed())) },
      (window, { requestId }) => void sent.push([window, requestId]),
    );
    try {
      setReady(first.window, true);
      setReady(second.window, true);
      const handled = broker.request(request("handled"));
      const queued = broker.request(request("queued"));
      expect(sent).toEqual([[second.window, "handled"]]);

      first.close();
      setReady(third.window, true);
      expect(sent).toEqual([[second.window, "handled"]]);

      second.close();
      expect(await handled).toMatchObject({ ok: false, code: "renderer-unavailable" });
      expect(sent).toEqual([
        [second.window, "handled"],
        [third.window, "queued"],
      ]);
      const failure = {
        version: DESKTOP_APP_ACTIVATION_PROTOCOL_VERSION,
        requestId: "queued",
        ok: false,
        code: "thread-open-failed",
        message: "No thread.",
      } as DesktopAppActivationResponse;
      broker.complete(failure);
      expect(await queued).toEqual(failure);
    } finally {
      broker.close();
    }
  });
});
