import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import type { DesktopUpdateStatusReport } from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import * as ServerConfig from "../config.ts";
import * as DesktopTelemetryReceiver from "../resourceTelemetry/DesktopTelemetryReceiver.ts";
import * as DesktopAppUpdate from "./DesktopAppUpdate.ts";

it.layer(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))(
  "desktop native preparation",
  (it) => {
    it.effect("keeps a consented native preparation alive beyond the former install deadline", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "scient-native-prepare-" });
        const config = yield* ServerConfig.ServerConfig.pipe(
          Effect.provide(ServerConfig.layerTest(process.cwd(), baseDir)),
        );
        const requested = yield* Deferred.make<void>();
        const failed = yield* Deferred.make<DesktopUpdateStatusReport>();
        const updater = yield* DesktopAppUpdate.make().pipe(
          Effect.provide(
            Layer.mergeAll(
              ServerConfig.layer({ ...config, mode: "desktop", desktopTelemetryControlFd: 5 }),
              DesktopTelemetryReceiver.layerTest({
                commitDesktopUpdate: () =>
                  Deferred.succeed(requested, undefined).pipe(Effect.asVoid),
                desktopUpdates: Effect.succeed({
                  latest: Option.none(),
                  changes: Stream.fromEffect(Deferred.await(failed)),
                }),
              }),
            ),
          ),
        );
        const result = yield* updater
          .commit("consented-update")
          .pipe(Effect.flip, Effect.forkChild);
        yield* Deferred.await(requested);
        yield* TestClock.adjust("450 seconds");
        yield* Deferred.succeed(failed, {
          version: 1,
          type: "desktopUpdateStatus",
          requestId: "consented-update",
          outcome: "failed",
          reason: "Native signature validation refused the prepared app",
          state: {
            enabled: true,
            status: "error",
            channel: "latest",
            currentVersion: "1.2.3",
            hostArch: "arm64",
            appArch: "arm64",
            runningUnderArm64Translation: false,
            availableVersion: "1.2.4",
            downloadedVersion: "1.2.4",
            releaseNotes: [],
            downloadPercent: null,
            checkedAt: null,
            message: null,
            errorContext: "install",
            canRetry: true,
            omittedReleaseCount: 0,
          },
        });
        expect((yield* Fiber.join(result)).reason).toBe(
          "Native signature validation refused the prepared app",
        );
      }),
    );
  },
);
