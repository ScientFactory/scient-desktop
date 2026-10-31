import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import type * as Electron from "electron";
import { vi } from "vite-plus/test";

import * as ElectronWindow from "../../electron/ElectronWindow.ts";
import * as DesktopWindow from "../../window/DesktopWindow.ts";
import { openNewWindow } from "./ipc.ts";

it.effect("opens a window only for an app window's own renderer", () => {
  const appWindow = { isDestroyed: () => false, webContents: { id: 1, isDestroyed: () => false } };
  const open = vi.fn(() => Effect.succeed(true));
  const provide = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(
      Effect.provideService(ElectronWindow.ElectronWindow, {
        appWindows: Effect.succeed([appWindow as unknown as Electron.BrowserWindow]),
      } as unknown as ElectronWindow.ElectronWindow["Service"]),
      Effect.provideService(DesktopWindow.DesktopWindow, {
        openNewWindow: open,
      } as unknown as DesktopWindow.DesktopWindow["Service"]),
    );
  return Effect.gen(function* () {
    const guest = { sender: { id: 2 } };
    assert.isFalse(yield* provide(openNewWindow.handler({ route: "/thread" }, guest)));
    assert.equal(open.mock.calls.length, 0);

    const own = { sender: { id: 1 } };
    assert.isTrue(yield* provide(openNewWindow.handler({ route: "/thread" }, own)));
    assert.equal(open.mock.calls.length, 1);
  });
});
