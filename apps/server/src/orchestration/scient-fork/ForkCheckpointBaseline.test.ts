// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { CheckpointRef } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as CheckpointStore from "../../checkpointing/CheckpointStore.ts";
import * as ServerConfig from "../../config.ts";
import * as VcsDriverRegistry from "../../vcs/VcsDriverRegistry.ts";
import { VcsProcess } from "../../vcs/VcsProcess.ts";
import * as VcsProcessLive from "../../vcs/VcsProcess.ts";
import {
  ScientForkCheckpointBaseline,
  ScientForkCheckpointBaselineLive,
} from "./ForkCheckpointBaseline.ts";

const vcsProcessLayer = VcsProcessLive.layer.pipe(Layer.provide(NodeServices.layer));
const layer = ScientForkCheckpointBaselineLive.pipe(
  Layer.provideMerge(
    CheckpointStore.layer.pipe(
      Layer.provideMerge(VcsDriverRegistry.layer.pipe(Layer.provide(vcsProcessLayer))),
    ),
  ),
  Layer.provideMerge(vcsProcessLayer),
  Layer.provideMerge(
    ServerConfig.ServerConfig.layerTest(process.cwd(), { prefix: "scient-fork-baseline-test-" }),
  ),
  Layer.provideMerge(NodeServices.layer),
);

it.layer(layer)("ScientForkCheckpointBaseline", (it) => {
  const withRepository = <A, E>(
    use: (cwd: string) => Effect.Effect<A, E, ScientForkCheckpointBaseline | VcsProcess>,
  ) =>
    Effect.scoped(
      Effect.acquireUseRelease(
        Effect.sync(() => NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "scient-fork-ref-"))),
        (cwd) =>
          Effect.gen(function* () {
            const process = yield* VcsProcess;
            yield* process.run({
              operation: "ForkCheckpointBaseline.test.init",
              command: "git",
              args: ["init"],
              cwd,
            });
            yield* process.run({
              operation: "ForkCheckpointBaseline.test.configName",
              command: "git",
              args: ["config", "user.name", "Scient Test"],
              cwd,
            });
            yield* process.run({
              operation: "ForkCheckpointBaseline.test.configEmail",
              command: "git",
              args: ["config", "user.email", "test@scient.dev"],
              cwd,
            });
            NodeFS.writeFileSync(NodePath.join(cwd, "evidence.txt"), "baseline\n");
            yield* process.run({
              operation: "ForkCheckpointBaseline.test.add",
              command: "git",
              args: ["add", "evidence.txt"],
              cwd,
            });
            yield* process.run({
              operation: "ForkCheckpointBaseline.test.commit",
              command: "git",
              args: ["commit", "-m", "baseline"],
              cwd,
            });
            return yield* use(cwd);
          }),
        (cwd) => Effect.sync(() => NodeFS.rmSync(cwd, { recursive: true, force: true })),
      ),
    );

  it.effect("copies an existing checkpoint commit to the fork baseline ref", () =>
    withRepository((cwd) =>
      Effect.gen(function* () {
        const process = yield* VcsProcess;
        const baseline = yield* ScientForkCheckpointBaseline;
        const source = CheckpointRef.make("refs/t3/checkpoints/source/turn/2");
        const target = CheckpointRef.make("refs/t3/checkpoints/fork/turn/0");
        yield* process.run({
          operation: "ForkCheckpointBaseline.test.sourceRef",
          command: "git",
          args: ["update-ref", source, "HEAD"],
          cwd,
        });

        assert.isTrue(yield* baseline.isGitRepository(cwd));
        assert.isTrue(
          yield* baseline.copy({ cwd, fromCheckpointRef: source, toCheckpointRef: target }),
        );
        const sourceOid = yield* process.run({
          operation: "ForkCheckpointBaseline.test.sourceOid",
          command: "git",
          args: ["rev-parse", source],
          cwd,
        });
        const targetOid = yield* process.run({
          operation: "ForkCheckpointBaseline.test.targetOid",
          command: "git",
          args: ["rev-parse", target],
          cwd,
        });
        assert.strictEqual(targetOid.stdout.trim(), sourceOid.stdout.trim());
      }),
    ),
  );

  it.effect("snapshots the working tree, uncommitted changes included, into the fork ref", () =>
    withRepository((cwd) =>
      Effect.gen(function* () {
        const process = yield* VcsProcess;
        const baseline = yield* ScientForkCheckpointBaseline;
        const target = CheckpointRef.make("refs/t3/checkpoints/live-fork/turn/0");
        // The running agent has edited a tracked file and created a new one.
        NodeFS.writeFileSync(NodePath.join(cwd, "evidence.txt"), "edited mid-turn\n");
        NodeFS.writeFileSync(NodePath.join(cwd, "new.txt"), "created mid-turn\n");

        assert.isTrue(yield* baseline.capture({ cwd, toCheckpointRef: target }));
        const edited = yield* process.run({
          operation: "ForkCheckpointBaseline.test.showEdited",
          command: "git",
          args: ["show", `${target}:evidence.txt`],
          cwd,
        });
        const created = yield* process.run({
          operation: "ForkCheckpointBaseline.test.showCreated",
          command: "git",
          args: ["show", `${target}:new.txt`],
          cwd,
        });
        assert.strictEqual(edited.stdout, "edited mid-turn\n");
        assert.strictEqual(created.stdout, "created mid-turn\n");
        // The user's own index is untouched.
        const status = yield* process.run({
          operation: "ForkCheckpointBaseline.test.status",
          command: "git",
          args: ["status", "--porcelain"],
          cwd,
        });
        assert.include(status.stdout, " M evidence.txt");
        assert.include(status.stdout, "?? new.txt");
      }),
    ),
  );

  it.effect("returns false without writing a target when the source is missing", () =>
    withRepository((cwd) =>
      Effect.gen(function* () {
        const baseline = yield* ScientForkCheckpointBaseline;
        const copied = yield* baseline.copy({
          cwd,
          fromCheckpointRef: CheckpointRef.make("refs/t3/checkpoints/missing/turn/2"),
          toCheckpointRef: CheckpointRef.make("refs/t3/checkpoints/fork/turn/0"),
        });
        assert.isFalse(copied);
      }),
    ),
  );
  it.effect("keeps the same frozen commit when the source advances before a retry", () =>
    withRepository((cwd) =>
      Effect.gen(function* () {
        const baseline = yield* ScientForkCheckpointBaseline;
        const process = yield* VcsProcess;
        const from = CheckpointRef.make("HEAD");
        const to = CheckpointRef.make("refs/t3/checkpoints/frozen/turn/0");
        assert.isTrue(yield* baseline.copy({ cwd, fromCheckpointRef: from, toCheckpointRef: to }));
        const frozen = yield* baseline.resolveCheckpoint(cwd, to);
        NodeFS.writeFileSync(NodePath.join(cwd, "evidence.txt"), "later revision\n");
        yield* process.run({
          operation: "test.advance",
          command: "git",
          args: ["commit", "-am", "advance"],
          cwd,
        });
        assert.notStrictEqual(yield* baseline.resolveCheckpoint(cwd, from), frozen);
        assert.isTrue(yield* baseline.copy({ cwd, fromCheckpointRef: from, toCheckpointRef: to }));
        assert.strictEqual(yield* baseline.resolveCheckpoint(cwd, to), frozen);
      }),
    ),
  );
  it.effect("accepts only a complete clean checkout at the frozen commit and expected branch", () =>
    withRepository((cwd) =>
      Effect.gen(function* () {
        const process = yield* VcsProcess;
        const baseline = yield* ScientForkCheckpointBaseline;
        const path = NodePath.join(cwd, "fork-worktree");
        const checkpointRef = "refs/t3/checkpoints/frozen/turn/0";
        const branch = "scient/fork/verification-test";
        const git = (directory: string, args: string[]) =>
          process.run({ operation: "test.verify", command: "git", args, cwd: directory });
        yield* git(cwd, ["update-ref", checkpointRef, "HEAD"]);
        yield* git(cwd, ["worktree", "add", "-b", branch, path, checkpointRef]);
        const input = { cwd, path, branch, checkpointRef };
        assert.isTrue(yield* baseline.verifyWorktree(input));
        assert.isFalse(yield* baseline.verifyWorktree({ ...input, branch: "another-branch" }));
        NodeFS.unlinkSync(NodePath.join(path, "evidence.txt"));
        assert.isFalse(yield* baseline.verifyWorktree(input));
        yield* git(path, ["checkout", "--", "evidence.txt"]);
        NodeFS.writeFileSync(NodePath.join(path, "unexpected.txt"), "user work");
        assert.isFalse(yield* baseline.verifyWorktree(input));
        NodeFS.unlinkSync(NodePath.join(path, "unexpected.txt"));
        const lock = yield* git(path, [
          "rev-parse",
          "--path-format=absolute",
          "--git-path",
          "index.lock",
        ]);
        NodeFS.writeFileSync(lock.stdout.trim(), "");
        assert.isFalse(yield* baseline.verifyWorktree(input));
        NodeFS.unlinkSync(lock.stdout.trim());
        NodeFS.writeFileSync(NodePath.join(path, "evidence.txt"), "different commit\n");
        yield* git(path, ["commit", "-am", "different commit"]);
        assert.isFalse(yield* baseline.verifyWorktree(input));
        // Even a matching branch and commit in another repository is not ours.
        const foreign = NodePath.join(cwd, "foreign");
        yield* git(cwd, ["clone", "--no-hardlinks", path, foreign]);
        yield* git(foreign, ["checkout", "-b", "foreign-check"]);
        assert.isFalse(
          yield* baseline.verifyWorktree({
            cwd: path,
            path: foreign,
            branch: "foreign-check",
            checkpointRef: "HEAD",
          }),
        );
      }),
    ),
  );
});
