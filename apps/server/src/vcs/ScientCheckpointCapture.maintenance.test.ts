import * as NodePlatformCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { CheckpointRef } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import * as ServerConfig from "../config.ts";
import * as GitVcsDriver from "./GitVcsDriver.ts";
import * as VcsProcess from "./VcsProcess.ts";

const layer = Layer.mergeAll(GitVcsDriver.layerVcs, GitVcsDriver.layer).pipe(
  Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "t3-checkpoint-maintenance-" })),
  Layer.provideMerge(VcsProcess.layer),
  Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodePlatformCrypto.layer)),
);

const MAINTENANCE_COMMANDS = new Set(["maintenance", "gc", "repack"]);

// Detached automatic maintenance outlives a quit. This repository would repack on its next
// porcelain fetch (two packs, limit one); maintenance runs in the foreground so the trace shows it.
it.effect.each(["loose", "pack"] as const)(
  "checkpoint publication starts no Git maintenance (transfer=%s)",
  (transfer) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const driver = yield* GitVcsDriver.makeVcsDriverShape();
      const cwd = yield* fs.makeTempDirectoryScoped({ prefix: "t3-checkpoint-maintenance-" });
      const git = (args: ReadonlyArray<string>) =>
        driver.execute({ operation: "checkpoint-maintenance-test", cwd, args });
      yield* git(["init", "--quiet"]);
      yield* git(["config", "user.name", "Test"]);
      yield* git(["config", "user.email", "test@test.com"]);
      for (const name of ["first", "second"]) {
        yield* fs.writeFileString(path.join(cwd, name), `${name}\n`);
        yield* git(["add", name]);
        yield* git(["-c", "maintenance.auto=false", "commit", "--quiet", "-m", name]);
        yield* git(["-c", "maintenance.auto=false", "repack", "-d", "-q"]);
      }
      yield* git(["config", "gc.autoPackLimit", "1"]);
      yield* git(["config", "maintenance.autoDetach", "false"]);
      yield* git(["config", "gc.autoDetach", "false"]);
      // Over the unpack limit, the staged pack arrives through a bundle fetch.
      if (transfer === "pack") yield* git(["config", "transfer.unpackLimit", "1"]);
      yield* fs.writeFileString(path.join(cwd, "untracked"), "untracked\n");
      const packDir = path.join(cwd, ".git", "objects", "pack");
      const countPacks = fs
        .readDirectory(packDir)
        .pipe(Effect.map((names) => names.filter((name) => name.endsWith(".pack")).length));
      const packsBefore = yield* countPacks;

      // trace2 settings are only read from global config or the environment.
      const trace = path.join(path.dirname(cwd), `${path.basename(cwd)}-trace2.jsonl`);
      const env = yield* HostProcess.Environment;
      yield* Effect.acquireRelease(
        Effect.sync(() => {
          const previous = env.GIT_TRACE2_EVENT;
          env.GIT_TRACE2_EVENT = trace;
          return previous;
        }),
        (previous) =>
          Effect.sync(() => {
            if (previous === undefined) delete env.GIT_TRACE2_EVENT;
            else env.GIT_TRACE2_EVENT = previous;
          }).pipe(Effect.andThen(fs.remove(trace, { force: true }).pipe(Effect.ignore))),
      );

      const checkpointRef = CheckpointRef.make("refs/t3/checkpoints/maintenance");
      yield* driver.checkpoints.captureCheckpoint({ cwd, checkpointRef });

      const events = (yield* fs.readFileString(trace))
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as { event?: string; argv?: ReadonlyArray<string> });
      const fetches = events.filter(
        (event) => event.event === "start" && event.argv?.includes("fetch"),
      );
      const maintenance = events.filter(
        (event) =>
          (event.event === "start" || event.event === "child_start") &&
          event.argv?.some((arg) => MAINTENANCE_COMMANDS.has(arg)),
      );
      assert.strictEqual(fetches.length, 1, "the checkpoint was published through one fetch");
      assert.deepStrictEqual(
        maintenance.map((event) => event.argv),
        [],
      );
      assert.isTrue(yield* driver.checkpoints.hasCheckpointRef({ cwd, checkpointRef }));
      // Without maintenance the existing packs stay as they were.
      assert.strictEqual((yield* countPacks) - packsBefore, transfer === "pack" ? 1 : 0);
    }).pipe(Effect.scoped, Effect.provide(layer)),
);
