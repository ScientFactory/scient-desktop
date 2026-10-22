import * as Effect from "effect/Effect";
import { beforeEach, expect, vi } from "vite-plus/test";
import { it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";

const native = vi.hoisted(() => ({
  setBadgeCount: vi.fn(() => true),
  isSupported: vi.fn(() => true),
  createFromDataURL: vi.fn(),
  image: { isEmpty: vi.fn(() => false) },
  listeners: new Map<string, () => void>(),
  getFocusedWindow: vi.fn(() => null as object | null),
  window: {
    webContents: { id: 7, send: vi.fn() },
    isDestroyed: vi.fn(() => false),
    setOverlayIcon: vi.fn(),
  },
}));
vi.mock("electron", () => ({
  app: {
    setBadgeCount: native.setBadgeCount,
    on: (event: string, listener: () => void) => native.listeners.set(event, listener),
    removeListener: (event: string) => native.listeners.delete(event),
  },
  BrowserWindow: {
    getAllWindows: () => [native.window],
    getFocusedWindow: native.getFocusedWindow,
  },
  Notification: { isSupported: native.isSupported },
  nativeImage: { createFromDataURL: native.createFromDataURL },
}));

import * as ElectronApp from "../../electron/ElectronApp.ts";
import { ElectronWindow } from "../../electron/ElectronWindow.ts";
import * as DesktopIpc from "../../ipc/DesktopIpc.ts";
import { applyUnreadAnswerBadge, installUnreadAnswerBadge } from "./ipc.ts";

const window = native.window as unknown as Electron.BrowserWindow;
const image = "data:image/png;base64,aGVsbG8=";

beforeEach(() => {
  vi.clearAllMocks();
  native.setBadgeCount.mockReturnValue(true);
  native.window.isDestroyed.mockReturnValue(false);
  native.getFocusedWindow.mockReturnValue(null);
  native.image.isEmpty.mockReturnValue(false);
  native.createFromDataURL.mockReturnValue(native.image);
  native.listeners.clear();
});

it("asks macOS for badge permission once there is a count to show", () => {
  expect(applyUnreadAnswerBadge("darwin", window, { count: 0, image: null })).toBe(true);
  expect(native.isSupported).not.toHaveBeenCalled();
  applyUnreadAnswerBadge("darwin", window, { count: 3, image: null });
  expect(native.isSupported).toHaveBeenCalledOnce();
  expect(native.setBadgeCount.mock.calls).toEqual([[0], [3]]);
});

it("reports a Linux launcher without badge support", () => {
  native.setBadgeCount.mockReturnValue(false);
  expect(applyUnreadAnswerBadge("linux", null, { count: 2, image: null })).toBe(false);
  expect(native.isSupported).not.toHaveBeenCalled();
});

it("shows and clears the Windows taskbar overlay on the main window", () => {
  applyUnreadAnswerBadge("win32", window, { count: 2, image });
  expect(native.window.setOverlayIcon).toHaveBeenLastCalledWith(
    native.image,
    "2 threads with unread answers",
  );
  applyUnreadAnswerBadge("win32", window, { count: 1, image });
  expect(native.window.setOverlayIcon).toHaveBeenLastCalledWith(
    native.image,
    "1 thread with an unread answer",
  );
  applyUnreadAnswerBadge("win32", window, { count: 0, image: null });
  expect(native.window.setOverlayIcon).toHaveBeenLastCalledWith(null, "");
  expect(native.setBadgeCount).not.toHaveBeenCalled();
});

it("skips a missing or destroyed Windows window and an unreadable image", () => {
  expect(applyUnreadAnswerBadge("win32", null, { count: 2, image })).toBe(false);
  native.window.isDestroyed.mockReturnValue(true);
  expect(applyUnreadAnswerBadge("win32", window, { count: 2, image })).toBe(false);
  expect(native.window.setOverlayIcon).not.toHaveBeenCalled();
  native.window.isDestroyed.mockReturnValue(false);
  native.image.isEmpty.mockReturnValue(true);
  applyUnreadAnswerBadge("win32", window, { count: 2, image });
  expect(native.window.setOverlayIcon.mock.calls[0]?.[0]).toBeNull();
});

/** Runs `test` with the badge installed on macOS, then checks everything is removed. */
const installed = (
  test: (
    handler: (channel: string, payload: unknown, sender?: number) => Promise<unknown>,
  ) => Effect.Effect<void>,
) =>
  Effect.gen(function* () {
    const handlers = new Map<string, DesktopIpc.DesktopIpcHandleListener>();
    yield* Effect.scoped(
      Effect.gen(function* () {
        yield* installUnreadAnswerBadge();
        yield* test((channel, payload, sender = 7) =>
          Promise.resolve(handlers.get(channel)!({ sender: { id: sender } }, payload)),
        );
      }),
    ).pipe(
      Effect.provideService(HostProcess.Platform, "darwin"),
      Effect.provideService(ElectronWindow, {
        main: Effect.succeedSome(window),
      } as unknown as ElectronWindow["Service"]),
      Effect.provide([
        ElectronApp.layer,
        DesktopIpc.layer({
          handle: (channel, handler) => {
            handlers.set(channel, handler);
          },
          removeHandler: (channel) => {
            handlers.delete(channel);
          },
          on: vi.fn(),
          removeAllListeners: vi.fn(),
        }),
      ]),
    );
    expect(native.listeners.size).toBe(0);
    expect(handlers.size).toBe(0);
  });

it.effect("accepts only valid badges from the main renderer", () =>
  installed((invoke) =>
    Effect.gen(function* () {
      const set = (badge: unknown, sender?: number) =>
        Effect.promise(() => invoke("scient:answer-attention:set-badge", badge, sender));
      for (const invalid of [
        { count: -1, image: null },
        { count: 1.5, image: null },
        { count: Infinity, image: null },
        { count: "3", image: null },
        { count: 1_000_001, image: null },
        { count: 1, image: "https://example.com/icon.png" },
        { count: 1, image: `data:image/png;base64,${"a".repeat(16_384)}` },
      ]) {
        yield* Effect.promise(() =>
          expect(invoke("scient:answer-attention:set-badge", invalid)).rejects.toBeDefined(),
        );
      }
      expect(yield* set({ count: 5, image: null }, 99)).toBe(false);
      expect(native.setBadgeCount).not.toHaveBeenCalled();
      expect(yield* set({ count: 2, image: null })).toBe(true);
      expect(native.setBadgeCount).toHaveBeenLastCalledWith(2);
    }),
  ),
);

it.effect("keeps upstream's notification dismissal without touching the app icon", () =>
  installed((invoke) =>
    Effect.gen(function* () {
      const report = (count: number) =>
        Effect.promise(() =>
          invoke("desktop:set-notification-badge", {
            count,
            image: "data:image/png;base64,aGVsbG8=",
          }),
        );
      const dismissals = () => native.window.webContents.send.mock.calls.length;
      // A notification arriving while no app window has focus stays.
      yield* report(1);
      expect(dismissals()).toBe(0);
      // Any window gaining focus dismisses it.
      native.listeners.get("browser-window-focus")!();
      expect(native.window.webContents.send).toHaveBeenLastCalledWith(
        "desktop:set-notification-badge",
      );
      // One arriving while another app window has focus is dismissed at once.
      native.getFocusedWindow.mockReturnValue({});
      yield* report(1);
      expect(dismissals()).toBe(2);
      yield* report(0);
      expect(dismissals()).toBe(2);
      expect(native.setBadgeCount).not.toHaveBeenCalled();
      expect(native.window.setOverlayIcon).not.toHaveBeenCalled();
      // Quitting clears the badge and dismisses the rest.
      native.listeners.get("before-quit")!();
      expect(native.setBadgeCount).toHaveBeenLastCalledWith(0);
      expect(dismissals()).toBe(3);
    }),
  ),
);

it.effect("clears the badge and dismisses notifications when shut down without a quit event", () =>
  installed((invoke) =>
    Effect.gen(function* () {
      yield* Effect.promise(() =>
        invoke("scient:answer-attention:set-badge", { count: 2, image: null }),
      );
      expect(native.setBadgeCount).toHaveBeenLastCalledWith(2);
    }),
  ).pipe(
    Effect.tap(() =>
      Effect.sync(() => {
        expect(native.setBadgeCount).toHaveBeenLastCalledWith(0);
        expect(native.window.webContents.send).toHaveBeenCalledWith(
          "desktop:set-notification-badge",
        );
      }),
    ),
  ),
);
