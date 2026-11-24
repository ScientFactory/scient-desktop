import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as DesktopEnvironment from "../../app/DesktopEnvironment.ts";
import * as DesktopAppSettings from "../../settings/DesktopAppSettings.ts";
import * as DesktopConfig from "../../app/DesktopConfig.ts";
import { assert, describe, it } from "@effect/vitest";
import { vi } from "vite-plus/test";

import {
  requestMicrophoneAccessForPlatform,
  hadLegacySelection,
  hasLegacyModels,
  removeLegacyModels,
} from "./voice.ts";

describe("requestMicrophoneAccessForPlatform", () => {
  it("requests a fresh macOS grant exactly once", async () => {
    const askForMediaAccess = vi.fn().mockResolvedValue(true);
    const result = await requestMicrophoneAccessForPlatform("darwin", {
      getMediaAccessStatus: () => "not-determined",
      askForMediaAccess,
    });

    assert.equal(result, "granted");
    assert.equal(askForMediaAccess.mock.calls.length, 1);
    assert.deepEqual(askForMediaAccess.mock.calls[0], ["microphone"]);
  });

  it("does not prompt again after macOS has recorded a decision", async () => {
    for (const status of ["granted", "denied", "restricted"] as const) {
      const askForMediaAccess = vi.fn().mockResolvedValue(true);
      const result = await requestMicrophoneAccessForPlatform("darwin", {
        getMediaAccessStatus: () => status,
        askForMediaAccess,
      });

      assert.equal(result, status);
      assert.equal(askForMediaAccess.mock.calls.length, 0);
    }
  });

  it("reports a rejected first prompt as denied", async () => {
    const statuses = ["not-determined", "denied"] as const;
    let read = 0;
    const result = await requestMicrophoneAccessForPlatform("darwin", {
      getMediaAccessStatus: () => statuses[Math.min(read++, statuses.length - 1)]!,
      askForMediaAccess: () => Promise.resolve(false),
    });

    assert.equal(result, "denied");
  });

  it("reports the Windows privacy switch without prompting", async () => {
    for (const [status, expected] of [
      ["granted", "granted"],
      ["denied", "denied"],
      ["not-determined", "unavailable"],
      ["unknown", "unavailable"],
    ] as const) {
      const askForMediaAccess = vi.fn().mockResolvedValue(true);
      const result = await requestMicrophoneAccessForPlatform("win32", {
        getMediaAccessStatus: () => status,
        askForMediaAccess,
      });

      assert.equal(result, expected);
      assert.equal(askForMediaAccess.mock.calls.length, 0);
    }
  });

  it("leaves other hosts on the existing browser permission path", async () => {
    const askForMediaAccess = vi.fn().mockResolvedValue(true);
    const result = await requestMicrophoneAccessForPlatform("linux", {
      getMediaAccessStatus: () => "denied",
      askForMediaAccess,
    });

    assert.equal(result, "unavailable");
    assert.equal(askForMediaAccess.mock.calls.length, 0);
  });

  it("falls back to renderer capture when native permission APIs are unavailable", async () => {
    for (const preferences of [
      {
        getMediaAccessStatus: () => {
          throw new Error("unavailable");
        },
        askForMediaAccess: () => Promise.resolve(true),
      },
      {
        getMediaAccessStatus: () => "unknown" as const,
        askForMediaAccess: () => Promise.resolve(true),
      },
      {
        getMediaAccessStatus: () => "not-determined" as const,
        askForMediaAccess: () => Promise.reject(new Error("unavailable")),
      },
    ]) {
      assert.equal(await requestMicrophoneAccessForPlatform("darwin", preferences), "unavailable");
    }
  });
});

it.effect("reads the previous selection and removes files only on the removal request", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const profile = yield* fs.makeTempDirectoryScoped();
    const environmentLayer = DesktopEnvironment.layer({
      dirname: "/repo/apps/desktop/src",
      homeDirectory: profile,
      platform: "darwin",
      processArch: "arm64",
      appVersion: "0.0.17",
      appPath: "/repo",
      isPackaged: true,
      resourcesPath: "/missing/resources",
      runningUnderArm64Translation: false,
    }).pipe(Layer.provide(DesktopConfig.layerTest({ SCIENT_NEXT_HOME: profile })));
    const settings = Layer.mock(DesktopAppSettings.DesktopAppSettings, {
      load: Effect.succeed({
        ...DesktopAppSettings.DEFAULT_DESKTOP_SETTINGS,
        voiceSelectedModelId: "whisper-small-multilingual-q5_1" as const,
      }),
    });
    yield* Effect.gen(function* () {
      const { stateDir } = yield* DesktopEnvironment.DesktopEnvironment;
      const models = path.join(stateDir, "voice", "models");
      yield* fs.makeDirectory(models, { recursive: true });
      yield* fs.writeFileString(path.join(models, "ggml-small-q5_1-ae85e4a9.bin.partial"), "clip");
      assert.isTrue(yield* hadLegacySelection.handler(undefined));
      assert.isTrue(yield* hasLegacyModels.handler(undefined));
      yield* removeLegacyModels.handler(undefined);
      assert.isFalse(yield* hasLegacyModels.handler(undefined));
    }).pipe(Effect.provide(Layer.mergeAll(environmentLayer, settings)));
  }).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
);
