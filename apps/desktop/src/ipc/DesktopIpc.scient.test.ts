import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { assert, it } from "@effect/vitest";
import { vi } from "vite-plus/test";

vi.mock("electron", () => ({}));

import * as ElectronWindow from "../electron/ElectronWindow.ts";
import * as DesktopIpc from "./DesktopIpc.ts";

it.effect("answers every open app window's top frame, not only the focused one", () =>
  Effect.gen(function* () {
    const focusedFrame = {};
    const otherFrame = {};
    const focused = { webContents: { id: 1, mainFrame: focusedFrame } };
    const other = { webContents: { id: 3, mainFrame: otherFrame } };
    const invoke = new Map<string, DesktopIpc.DesktopIpcHandleListener>();
    const sync = new Map<string, DesktopIpc.DesktopIpcSyncListener>();
    const ipc = yield* DesktopIpc.DesktopIpc.pipe(
      Effect.provide(
        DesktopIpc.layer({
          removeHandler: (channel) => void invoke.delete(channel),
          handle: (channel, listener) => void invoke.set(channel, listener),
          removeAllListeners: (channel) => void sync.delete(channel),
          on: (channel, listener) => void sync.set(channel, listener),
        }).pipe(
          Layer.provide(
            Layer.mock(ElectronWindow.ElectronWindow, {
              main: Effect.succeedSome(focused as unknown as Electron.BrowserWindow),
              appWindows: Effect.succeed([focused, other] as unknown as Electron.BrowserWindow[]),
            }),
          ),
        ),
      ),
    );
    yield* ipc.handle(
      DesktopIpc.makeIpcMethod({
        channel: "window-id",
        payload: Schema.Void,
        result: Schema.Number,
        handler: (_input, event) => Effect.succeed(event?.sender.id ?? -1),
      }),
    );
    yield* ipc.handleSync({
      channel: "window-id-sync",
      handler: (event) => Effect.succeed(event?.sender.id ?? -1),
    });

    const senders = {
      otherWindow: { sender: { id: 3 }, senderFrame: otherFrame },
      otherWindowSubframe: { sender: { id: 3 }, senderFrame: {} },
      previewGuest: { sender: { id: 2 }, senderFrame: {} },
    };
    const results: Record<string, unknown> = {};
    for (const [name, sender] of Object.entries(senders)) {
      const event = { ...sender, returnValue: "unset" as unknown };
      sync.get("window-id-sync")!(event);
      results[name] = [
        yield* Effect.promise(() =>
          Promise.resolve(invoke.get("window-id")!(sender, undefined)).catch(() => "rejected"),
        ),
        event.returnValue,
      ];
    }
    assert.deepEqual(results, {
      otherWindow: [3, 3],
      otherWindowSubframe: ["rejected", undefined],
      previewGuest: ["rejected", undefined],
    });
  }).pipe(Effect.scoped),
);
