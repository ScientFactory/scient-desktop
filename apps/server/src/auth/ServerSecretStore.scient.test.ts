import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { TestClock } from "effect/testing";

import * as ServerConfig from "../config.ts";
import * as ServerSecretStore from "./ServerSecretStore.ts";

const layerServerConfig = () =>
  ServerConfig.layerTest(process.cwd(), { prefix: "t3-secret-store-test-" });

it.layer(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))(
  "ServerSecretStore temporary files",
  (it) => {
    it.effect("reclaims a write's temporary file a crash left, never one still in flight", () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        // A fixed now: the stale file was last written an hour before it, the fresh one at it.
        const now = 1_800_000_000_000;
        yield* TestClock.setTime(now);
        const directory = (yield* ServerSecretStore.make).directory!;
        const uuid = "0f0f0f0f-1111-4222-8333-444455556666";
        const stale = `${directory}/accounts-value-${uuid}.bin.${uuid}.tmp`;
        const fresh = `${directory}/accounts-value-${uuid}.bin.${uuid.replace("0f", "1e")}.tmp`;
        yield* fileSystem.writeFileString(stale, "ciphertext");
        yield* fileSystem.writeFileString(fresh, "ciphertext");
        yield* fileSystem.utimes(stale, (now - 60 * 60_000) / 1000, (now - 60 * 60_000) / 1000);
        yield* fileSystem.utimes(fresh, now / 1000, now / 1000);
        // The server starts again.
        const restarted = yield* ServerSecretStore.make;
        assert.isFalse(yield* fileSystem.exists(stale));
        assert.isTrue(yield* fileSystem.exists(fresh));
        // Once the fresh one ages out, the writer's next look reclaims it too.
        yield* TestClock.adjust("11 minutes");
        yield* restarted.reclaimTemporary!;
        assert.isFalse(yield* fileSystem.exists(fresh));
      }).pipe(Effect.provide(layerServerConfig())),
    );

    it.effect("never reclaims the temporary file of a write still running, however old", () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const entered = yield* Deferred.make<string>();
        const release = yield* Deferred.make<void>();
        // A write whose rename stalls (a slow disk) past the age a crash's leftover is reclaimed at.
        const stalling: FileSystem.FileSystem = {
          ...fileSystem,
          rename: (from, to) =>
            Deferred.succeed(entered, String(from)).pipe(
              Effect.andThen(Deferred.await(release)),
              Effect.andThen(fileSystem.rename(from, to)),
            ),
        };
        const store = yield* ServerSecretStore.make.pipe(
          Effect.provideService(FileSystem.FileSystem, stalling),
        );
        const write = yield* store
          .set("session-signing-key", Uint8Array.from([1, 2, 3]))
          .pipe(Effect.forkChild);
        const temporary = yield* Deferred.await(entered);
        const modified = Option.getOrThrow((yield* fileSystem.stat(temporary)).mtime).getTime();
        yield* TestClock.setTime(modified + 11 * 60_000);
        yield* store.reclaimTemporary!;
        assert.isTrue(yield* fileSystem.exists(temporary));
        yield* Deferred.succeed(release, undefined);
        yield* Fiber.join(write);
        const stored = yield* store.get("session-signing-key");
        assert.deepEqual(Array.from(Option.getOrThrow(stored)), [1, 2, 3]);
      }).pipe(Effect.provide(layerServerConfig())),
    );
  },
);
