import { assert, describe, it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";

import * as Effect from "effect/Effect";

import * as Layer from "effect/Layer";
import type * as Electron from "electron";
import { beforeEach, vi } from "vite-plus/test";

const {
  activateWindowsForegroundMock,
  appFocusMock,
  browserWindowMock,
  foregroundWindowMock,
  getAllWindowsMock,
  getFocusedWindowMock,
  loadWindowsForegroundApiMock,
  shellHostedForegroundMock,
  startWindowsForegroundFocusThreadMock,
  windowsForegroundFocusMock,
  windowsForegroundPrepareMock,
  windowsForegroundCloseMock,
} = vi.hoisted(() => ({
  activateWindowsForegroundMock: vi.fn(),
  appFocusMock: vi.fn(),
  browserWindowMock: vi.fn(function BrowserWindowMock() {}),
  foregroundWindowMock: vi.fn<() => bigint>(),
  getAllWindowsMock: vi.fn(),
  getFocusedWindowMock: vi.fn(),
  loadWindowsForegroundApiMock: vi.fn<() => Promise<{ getForegroundWindow: () => bigint }>>(),
  shellHostedForegroundMock: vi.fn(),
  startWindowsForegroundFocusThreadMock: vi.fn(),
  windowsForegroundFocusMock: vi.fn(),
  windowsForegroundPrepareMock: vi.fn(),
  windowsForegroundCloseMock: vi.fn(),
}));

vi.mock("./WindowsForeground.ts", () => ({
  activateWindowsForeground: activateWindowsForegroundMock,
  isWindowsShellHostedForeground: shellHostedForegroundMock,
  loadWindowsForegroundApi: loadWindowsForegroundApiMock,
}));

vi.mock("./WindowsForegroundFocusThread.ts", () => ({
  startWindowsForegroundFocusThread: startWindowsForegroundFocusThreadMock,
}));

vi.mock("electron", () => ({
  app: {
    focus: appFocusMock,
  },
  BrowserWindow: Object.assign(browserWindowMock, {
    getAllWindows: getAllWindowsMock,
    getFocusedWindow: getFocusedWindowMock,
  }),
}));

import * as ElectronWindow from "./ElectronWindow.ts";

const layerTestFor = (platform: NodeJS.Platform) =>
  ElectronWindow.layer.pipe(Layer.provide(Layer.succeed(HostProcess.Platform, platform)));

const layerTest = layerTestFor("linux");

describe("ElectronWindow", () => {
  beforeEach(() => {
    activateWindowsForegroundMock.mockReset().mockResolvedValue(undefined);
    appFocusMock.mockReset();
    browserWindowMock.mockReset();
    foregroundWindowMock.mockReset().mockReturnValue(0n);
    getAllWindowsMock.mockReset();
    getFocusedWindowMock.mockReset();
    loadWindowsForegroundApiMock
      .mockReset()
      .mockImplementation(() => Promise.resolve({ getForegroundWindow: foregroundWindowMock }));
    shellHostedForegroundMock.mockReset().mockResolvedValue(false);
    startWindowsForegroundFocusThreadMock.mockReset().mockReturnValue({
      prepare: windowsForegroundPrepareMock,
      focus: windowsForegroundFocusMock,
      close: windowsForegroundCloseMock,
    });
    windowsForegroundFocusMock.mockReset().mockResolvedValue(false);
    windowsForegroundPrepareMock.mockReset().mockResolvedValue(false);
    windowsForegroundCloseMock.mockReset();
  });

  // regression: c7b375e9b0 [codex] Structure Electron window failures (#3276)
  it.effect("preserves schema-safe creation context and the Electron cause", () =>
    Effect.gen(function* () {
      const cause = new Error("native BrowserWindow construction failed");
      browserWindowMock.mockImplementationOnce(function BrowserWindowFailure() {
        throw cause;
      });
      const options = {
        title: "Scient",
        width: 1100,
        height: 780,
        minWidth: 840,
        minHeight: 620,
        show: false,
        modal: false,
        frame: true,
        transparent: false,
        backgroundColor: "#101010",
        icon: {} as Electron.NativeImage,
        webPreferences: {
          preload: "/tmp/preload.js",
          partition: "persist:scient-next-preview-test",
          sandbox: true,
          contextIsolation: true,
          nodeIntegration: false,
          webviewTag: true,
          spellcheck: true,
        },
      } satisfies Electron.BrowserWindowConstructorOptions;
      const electronWindow = yield* ElectronWindow.ElectronWindow;

      const error = yield* electronWindow.create(options).pipe(Effect.flip);

      assert.instanceOf(error, ElectronWindow.ElectronWindowCreateError);
      assert.deepEqual(error.options, {
        title: "Scient",
        width: 1100,
        height: 780,
        minWidth: 840,
        minHeight: 620,
        show: false,
        modal: false,
        frame: true,
        transparent: false,
        backgroundColor: "#101010",
        webPreferences: {
          preload: "/tmp/preload.js",
          partition: "persist:scient-next-preview-test",
          backgroundThrottling: null,
          sandbox: true,
          contextIsolation: true,
          nodeIntegration: false,
          webviewTag: true,
        },
      });
      assert.isFalse("icon" in error.options);
      assert.isFalse("spellcheck" in error.options.webPreferences);
      assert.strictEqual(error.cause, cause);
      assert.equal(error.message, 'Failed to create Electron BrowserWindow "Scient" (1100x780).');
      assert.notInclude(error.message, cause.message);
      assert.deepEqual(browserWindowMock.mock.calls, [[options]]);
    }).pipe(Effect.provide(layerTest)),
  );
});
