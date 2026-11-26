import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as Electron from "electron";
import { vi } from "vite-plus/test";

vi.mock("electron", () => ({}));

import { DesktopRestartTiming } from "../../app/DesktopRestartTiming.ts";
import { ElectronWindow } from "../../electron/ElectronWindow.ts";
import { DesktopStartupTiming } from "../../scient/startupTiming/DesktopStartupTiming.ts";
import { getToken, reportReady } from "./restartReadiness.ts";

function fixture(destroyed = false) {
  const mainFrame = {};
  const token = { attemptId: "attempt-1", launchId: "launch-1" };
  const acknowledgements: unknown[] = [];
  const startupReports: unknown[] = [];
  const window = {
    isDestroyed: () => destroyed,
    webContents: { id: 41, mainFrame },
  } as unknown as Electron.BrowserWindow;
  const layer = Layer.mergeAll(
    Layer.mock(ElectronWindow, { appWindows: Effect.succeed([window]) }),
    Layer.mock(DesktopRestartTiming, {
      readinessToken: Effect.succeed(token),
      workspaceReady: (ack) =>
        Effect.sync(() => {
          acknowledgements.push(ack);
          return true;
        }),
    }),
    Layer.mock(DesktopStartupTiming, {
      workspaceReady: (input) => Effect.sync(() => void startupReports.push(input)),
    }),
  );
  return { layer, mainFrame, token, acknowledgements, startupReports };
}

it.effect("accepts only a registered app top frame and forwards no renderer timestamps", () =>
  Effect.gen(function* () {
    const f = fixture();
    const event = { sender: { id: 41 }, senderFrame: f.mainFrame };
    assert.deepEqual(
      yield* getToken.handler(undefined, event).pipe(Effect.provide(f.layer)),
      f.token,
    );
    assert.isTrue(
      yield* reportReady
        .handler(
          {
            ...f.token,
            projectRestored: true,
            rendererTimestamp: -50,
          },
          event,
        )
        .pipe(Effect.provide(f.layer)),
    );
    assert.deepEqual(f.acknowledgements, [{ ...f.token, projectRestored: true }]);
  }),
);

it.effect.each(["preview", "subframe", "destroyed", "missing-event"] as const)(
  "rejects readiness from %s without releasing an attempt token",
  (kind) =>
    Effect.gen(function* () {
      const f = fixture(kind === "destroyed");
      const event =
        kind === "missing-event"
          ? undefined
          : {
              sender: { id: kind === "preview" ? 99 : 41 },
              senderFrame: kind === "subframe" ? {} : f.mainFrame,
            };
      assert.isNull(yield* getToken.handler(undefined, event).pipe(Effect.provide(f.layer)));
      assert.isFalse(
        yield* reportReady
          .handler({ ...f.token, projectRestored: true }, event)
          .pipe(Effect.provide(f.layer)),
      );
      assert.deepEqual(f.acknowledgements, []);
      assert.deepEqual(f.startupReports, []);
    }),
);

it.effect("ends startup timing on every launch, and a restart measurement only with a token", () =>
  Effect.gen(function* () {
    const f = fixture();
    const event = { sender: { id: 41 }, senderFrame: f.mainFrame };
    assert.isFalse(
      yield* reportReady.handler({ projectRestored: false }, event).pipe(Effect.provide(f.layer)),
    );
    assert.deepEqual(f.startupReports, [{ projectRestored: false }]);
    assert.deepEqual(f.acknowledgements, []);
  }),
);
