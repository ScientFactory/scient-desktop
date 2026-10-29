import { assert, it } from "@effect/vitest";
import { VcsProcessTimeoutError } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { ChildProcessSpawner } from "effect/process";

import { makeCheckpointSizeCheck } from "./ScientCheckpointCapture.ts";

it.effect("treats a size scan that runs out of time as too large and skips it on later turns", () =>
  Effect.gen(function* () {
    const scans: number[] = [];
    const checkSize = makeCheckpointSizeCheck({
      execute: (input) =>
        input.args[0] === "rev-parse"
          ? Effect.succeed({
              exitCode: ChildProcessSpawner.ExitCode(0),
              stdout: "/workspace\n",
              stderr: "",
              stdoutTruncated: false,
              stderrTruncated: false,
            })
          : Effect.sync(() => scans.push(input.timeoutMs ?? 0)).pipe(
              Effect.andThen(
                Effect.fail(
                  new VcsProcessTimeoutError({
                    operation: input.operation,
                    command: "git",
                    cwd: input.cwd,
                    timeoutMs: input.timeoutMs ?? 0,
                  }),
                ),
              ),
            ),
    });

    const first = yield* Effect.flip(checkSize("/workspace", {}));
    const second = yield* Effect.flip(checkSize("/workspace", {}));

    assert.deepStrictEqual(scans, [2_000]);
    for (const error of [first, second]) {
      assert.strictEqual(error._tag, "VcsCheckpointUnavailableError");
      if (error._tag === "VcsCheckpointUnavailableError")
        assert.strictEqual(error.reason, "size-limit");
    }
  }),
);
