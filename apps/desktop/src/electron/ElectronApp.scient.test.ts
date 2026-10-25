import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { vi } from "vite-plus/test";

const { getVersionMock, whenReadyMock } = vi.hoisted(() => ({
  getVersionMock: vi.fn(() => "1.2.3"),
  whenReadyMock: vi.fn(() => Promise.resolve()),
}));

vi.mock("electron", () => ({
  app: {
    getAppPath: () => "/app",
    getVersion: getVersionMock,
    isPackaged: true,
    whenReady: whenReadyMock,
  },
}));
import * as ElectronApp from "./ElectronApp.ts";

describe("ElectronApp", () => {
  // regression: 5a2c92e86d [codex] Structure Electron app boundary failures (#3301) - sole guard (upstream deleted the file; mislabeling the property or turning a readiness rejection into a defect passed every other desktop test)
  it.effect("reports which app metadata property failed", () =>
    Effect.gen(function* () {
      const cause = new Error("version unavailable");
      getVersionMock.mockImplementationOnce(() => {
        throw cause;
      });

      const electronApp = yield* ElectronApp.ElectronApp;
      const error = yield* electronApp.metadata.pipe(Effect.flip);

      assert.instanceOf(error, ElectronApp.ElectronAppMetadataReadError);
      assert.strictEqual(error.property, "app-version");
      assert.strictEqual(error.cause, cause);
      assert.strictEqual(
        error.message,
        'Failed to read Electron app metadata property "app-version".',
      );
    }).pipe(Effect.provide(ElectronApp.layer)),
  );

  it.effect("preserves Electron readiness failures", () =>
    Effect.gen(function* () {
      const cause = new Error("ready failed");
      whenReadyMock.mockRejectedValueOnce(cause);

      const electronApp = yield* ElectronApp.ElectronApp;
      const error = yield* electronApp.whenReady.pipe(Effect.flip);

      assert.instanceOf(error, ElectronApp.ElectronAppWhenReadyError);
      assert.strictEqual(error.isPackaged, true);
      assert.strictEqual(error.cause, cause);
      assert.strictEqual(
        error.message,
        "Failed to wait for the Electron app to become ready (packaged: true).",
      );
    }).pipe(Effect.provide(ElectronApp.layer)),
  );
});
