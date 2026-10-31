import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import type * as Electron from "electron";
import { expect, vi } from "vite-plus/test";

import * as DesktopConnectionCatalogStore from "../../app/DesktopConnectionCatalogStore.ts";
import * as ElectronWindow from "../../electron/ElectronWindow.ts";
import { CONNECTION_CATALOG_CHANGED_CHANNEL } from "../../ipc/channels.ts";
import { setConnectionCatalog } from "../../ipc/methods/connectionCatalog.ts";
import { notifyOtherWindows } from "./notifyOtherWindows.ts";

const makeWindows = () => {
  const windows = [1, 2, 3].map((id) => ({ webContents: { id, send: vi.fn() } }));
  const service = {
    appWindows: Effect.succeed(windows as unknown as ReadonlyArray<Electron.BrowserWindow>),
  } as unknown as ElectronWindow.ElectronWindow["Service"];
  return {
    windows,
    provide: Effect.provideService(ElectronWindow.ElectronWindow, service),
    sends: () =>
      windows.map((window) => [window.webContents.id, window.webContents.send.mock.calls]),
  };
};

const sender = { sender: { id: 1 } };

it.effect("tells every other app window, with the payload, and survives a failed send", () => {
  const { windows, provide, sends } = makeWindows();
  windows[1]!.webContents.send.mockImplementationOnce(() => {
    throw new Error("render process gone");
  });
  return Effect.gen(function* () {
    yield* notifyOtherWindows(sender, "channel", { wordWrap: false });
    expect(sends()).toEqual([
      [1, []],
      [2, [["channel", { wordWrap: false }]]],
      [3, [["channel", { wordWrap: false }]]],
    ]);
  }).pipe(provide);
});

it.effect("announces a connection catalog only once it is stored, and without its contents", () => {
  const { windows, provide } = makeWindows();
  let stored = false;
  const store = { set: () => Effect.succeed(stored) } as never;
  const save = setConnectionCatalog
    .handler("{}", sender)
    .pipe(
      Effect.provideService(DesktopConnectionCatalogStore.DesktopConnectionCatalogStore, store),
      provide,
    );
  return Effect.gen(function* () {
    expect(yield* save).toBe(false);
    expect(windows[1]!.webContents.send).not.toHaveBeenCalled();

    stored = true;
    expect(yield* save).toBe(true);
    expect(windows[1]!.webContents.send.mock.calls).toEqual([[CONNECTION_CATALOG_CHANGED_CHANNEL]]);
    expect(windows[0]!.webContents.send).not.toHaveBeenCalled();
  });
});
