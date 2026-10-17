import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";

import { ServerConfig } from "../../config.ts";
import { makeReplayServerConfig as makeCodexConfig } from "../Adapters/CodexAdapterV2.testkit.ts";
import { makeReplayServerConfig as makeHarnessConfig } from "./ProviderReplayHarness.ts";
import { makeReplayServerConfig } from "./ScientReplayServerConfig.testkit.ts";

it("shares one lightweight factory through both existing entry points", () => {
  assert.strictEqual(makeCodexConfig, makeReplayServerConfig);
  assert.strictEqual(makeHarnessConfig, makeReplayServerConfig);
});

it.effect("cleans the complete profile after direct allocation", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const config = yield* Effect.scoped(
      Effect.gen(function* () {
        const config = yield* makeReplayServerConfig("direct-profile");
        assert.equal(config.cwd, config.baseDir);
        assert.isTrue(yield* fs.exists(config.providerStatusCacheDir));
        assert.isTrue(yield* fs.exists(config.worktreesDir));
        return config;
      }),
    );
    assert.isFalse(yield* fs.exists(config.baseDir));
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("cleans a layer-owned profile when its layer scope closes", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const config = yield* Effect.scoped(
      Layer.build(Layer.effect(ServerConfig, makeReplayServerConfig("layer-profile"))).pipe(
        Effect.map((context) => Context.get(context, ServerConfig)),
      ),
    );
    assert.isFalse(yield* fs.exists(config.baseDir));
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("tolerates callers that already explicitly release their profile", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const config = yield* Effect.scoped(
      Effect.acquireRelease(makeReplayServerConfig("explicit-release"), (config) =>
        fs.remove(config.baseDir, { recursive: true }).pipe(Effect.orDie),
      ),
    );
    assert.isFalse(yield* fs.exists(config.baseDir));
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("keeps a caller-owned profile alive across borrowed layer scopes", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const config = yield* Effect.scoped(
      Effect.gen(function* () {
        const config = yield* makeReplayServerConfig("restart-profile");
        for (let restart = 0; restart < 2; restart++) {
          yield* Effect.scoped(Layer.build(Layer.succeed(ServerConfig, config)));
          assert.isTrue(yield* fs.exists(config.baseDir));
        }
        return config;
      }),
    );
    assert.isFalse(yield* fs.exists(config.baseDir));
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("cleans an allocated profile even if initialization fails", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    let baseDir: string | undefined;
    const failingFs = FileSystem.FileSystem.of({
      ...fs,
      makeTempDirectory: (options) =>
        fs.makeTempDirectory(options).pipe(
          Effect.tap((directory) =>
            Effect.sync(() => {
              baseDir = directory;
            }),
          ),
        ),
      makeDirectory: () => Effect.die("Profile initialization failed"),
    });
    const exit = yield* Effect.scoped(
      makeReplayServerConfig("failed-profile").pipe(
        Effect.provideService(FileSystem.FileSystem, failingFs),
      ),
    ).pipe(Effect.exit);
    assert.equal(exit._tag, "Failure");
    assert.isDefined(baseDir);
    assert.isFalse(yield* fs.exists(baseDir!));
  }).pipe(Effect.provide(NodeServices.layer)),
);
