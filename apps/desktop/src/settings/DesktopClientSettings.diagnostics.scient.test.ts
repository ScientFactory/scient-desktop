import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Option from "effect/Option";
import * as References from "effect/References";

import * as DesktopConfig from "../app/DesktopConfig.ts";
import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import * as DesktopClientSettings from "./DesktopClientSettings.ts";

interface LogRecord {
  readonly message: unknown;
  readonly annotations: Readonly<Record<string, unknown>>;
}

const baseDir = "/virtual-home";

function layer(fileSystemLayer: Layer.Layer<FileSystem.FileSystem>) {
  const layerEnvironment = DesktopEnvironment.layer({
    dirname: "/repo/apps/desktop/src",
    homeDirectory: baseDir,
    platform: "darwin",
    processArch: "x64",
    appVersion: "1.2.3",
    appPath: "/repo",
    isPackaged: true,
    resourcesPath: "/missing/resources",
    runningUnderArm64Translation: false,
  }).pipe(
    Layer.provide(
      Layer.mergeAll(NodeServices.layer, DesktopConfig.layerTest({ SCIENT_NEXT_HOME: baseDir })),
    ),
  );

  return DesktopClientSettings.layer.pipe(
    Layer.provideMerge(Layer.mergeAll(layerEnvironment, NodeServices.layer, fileSystemLayer)),
  );
}

const readWithLogs = (fileSystemLayer: Layer.Layer<FileSystem.FileSystem>) => {
  const records: Array<LogRecord> = [];
  const logger = Logger.make(({ fiber, message }) => {
    records.push({
      message,
      annotations: { ...fiber.getRef(References.CurrentLogAnnotations) },
    });
  });

  return Effect.gen(function* () {
    const environment = yield* DesktopEnvironment.DesktopEnvironment;
    const settings = yield* DesktopClientSettings.DesktopClientSettings;
    return {
      result: yield* Effect.result(settings.get),
      settingsPath: environment.clientSettingsPath,
      records,
    };
  }).pipe(
    Effect.provide(
      Layer.mergeAll(layer(fileSystemLayer), Logger.layer([logger], { mergeWithExisting: false })),
    ),
  );
};

describe("DesktopClientSettings diagnostics", () => {
  // regression: ad2cb1dd57 [codex] Diagnose desktop client settings read failures (#3432) - sole guard: treating a missing file as a read failure passed every other desktop test
  it.effect("treats a missing settings file as expected without warning", () =>
    Effect.gen(function* () {
      const result = yield* readWithLogs(FileSystem.layerNoop({}));

      if (result.result._tag !== "Success") return assert.fail("expected a successful read");
      assert.isTrue(Option.isNone(result.result.success));
      assert.deepEqual(result.records, []);
    }),
  );
});
