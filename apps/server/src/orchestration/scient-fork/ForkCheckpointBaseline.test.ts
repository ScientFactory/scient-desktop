// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { CheckpointRef } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { VcsProcess } from "../../vcs/VcsProcess.ts";
import * as VcsProcessLive from "../../vcs/VcsProcess.ts";
import {
  ScientForkCheckpointBaseline,
  ScientForkCheckpointBaselineLive,
} from "./ForkCheckpointBaseline.ts";

const layer = ScientForkCheckpointBaselineLive.pipe(
  Layer.provideMerge(VcsProcessLive.layer),
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
});
