// @effect-diagnostics nodeBuiltinImport:off - isolated child-run witness for the global safety hook.
import * as NodeChildProcess from "node:child_process";
import * as NodeURL from "node:url";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as NodeServices from "@effect/platform-node/NodeServices";

import { prepareCheckpointStagingRepo } from "../vcs/ScientCheckpointCapture.ts";

// The parent regression expects this child run to fail specifically in the safety hook.
it.effect.skipIf(process.env.SCIENT_CHECKPOINT_ISOLATION_VIOLATION !== "1")(
  "records a source capture even when its defect is recovered",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const cwd = NodeURL.fileURLToPath(new URL("../../", import.meta.url));
        const gitCommonDir = NodeChildProcess.execFileSync(
          "git",
          ["rev-parse", "--path-format=absolute", "--git-common-dir"],
          { cwd, encoding: "utf8" },
        ).trim();
        const result = yield* prepareCheckpointStagingRepo({
          cwd,
          gitCommonDir,
          operation: "checkpoint-isolation-regression",
          path: yield* Path.Path,
          fileSystem: FileSystem.makeNoop({
            makeTempDirectoryScoped: () => Effect.die("Forbidden staging was reached"),
          }),
          execute: () => Effect.die("Forbidden Git execution was reached"),
          commitEnv: {},
          cleanGitEnv: {},
        }).pipe(Effect.catchCause(() => Effect.succeed("completed")));
        assert.equal(result, "completed");
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
);
