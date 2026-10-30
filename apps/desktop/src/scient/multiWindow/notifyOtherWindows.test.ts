import * as Effect from "effect/Effect";
import { beforeEach, expect, vi } from "vite-plus/test";
import { it } from "@effect/vitest";

const native = vi.hoisted(() => {
  const window = (id: number, destroyed = false) => ({
    isDestroyed: () => destroyed,
    webContents: { id, send: vi.fn() },
  });
  return { windows: [window(1), window(2), window(3, true), window(4)] };
});
vi.mock("electron", () => ({
  BrowserWindow: { getAllWindows: () => native.windows },
}));

import * as DesktopConnectionCatalogStore from "../../app/DesktopConnectionCatalogStore.ts";
import { CONNECTION_CATALOG_CHANGED_CHANNEL } from "../../ipc/channels.ts";
import { setConnectionCatalog } from "../../ipc/methods/connectionCatalog.ts";
import { notifyOtherWindows } from "./notifyOtherWindows.ts";

const sender = { sender: { id: 1 } };
const sends = () =>
  native.windows.map((window) => [window.webContents.id, window.webContents.send.mock.calls]);

beforeEach(() => {
  vi.clearAllMocks();
});

it.effect("tells every other live window, with the payload, and survives a failed send", () =>
  Effect.gen(function* () {
    native.windows[1]!.webContents.send.mockImplementationOnce(() => {
      throw new Error("render process gone");
    });
    yield* notifyOtherWindows(sender, "channel", { wordWrap: false });
    expect(sends()).toEqual([
      [1, []],
      [2, [["channel", { wordWrap: false }]]],
      [3, []],
      [4, [["channel", { wordWrap: false }]]],
    ]);
  }),
);

it.effect("announces a connection catalog only once it is stored, and without its contents", () =>
  Effect.gen(function* () {
    let stored = false;
    const store = { set: () => Effect.succeed(stored) } as never;
    const save = setConnectionCatalog
      .handler("{}", sender)
      .pipe(
        Effect.provideService(DesktopConnectionCatalogStore.DesktopConnectionCatalogStore, store),
      );

    expect(yield* save).toBe(false);
    expect(native.windows[1]!.webContents.send).not.toHaveBeenCalled();

    stored = true;
    expect(yield* save).toBe(true);
    expect(native.windows[1]!.webContents.send.mock.calls).toEqual([
      [CONNECTION_CATALOG_CHANGED_CHANNEL],
    ]);
    expect(native.windows[0]!.webContents.send).not.toHaveBeenCalled();
  }),
);
