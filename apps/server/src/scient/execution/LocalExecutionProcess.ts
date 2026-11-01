import {
  ExecutionProcessError,
  type ExecutionProcessHandle,
  type ExecutionProcessPort,
} from "@scientfactory/execution";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import { ChildProcessSpawner } from "effect/process";

import { makeLocalOwnedProcessCleanup, makeLocalOwnedProcess } from "./LocalOwnedProcess.ts";

export class ExecutionProcess extends Context.Service<ExecutionProcess, ExecutionProcessPort>()(
  "t3/scient/execution/LocalExecutionProcess/ExecutionProcess",
) {}

function processError(
  operation: ExecutionProcessError["operation"],
  message: string,
  cause: unknown,
): ExecutionProcessError {
  return new ExecutionProcessError({ operation, message, cause });
}

const make = Effect.gen(function* () {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const platform = yield* HostProcess.Platform;

  const start: ExecutionProcessPort["start"] = Effect.fn("LocalExecutionProcess.start")(
    function* (request) {
      const child = yield* spawner
        .spawn(makeLocalOwnedProcess(request, platform))
        .pipe(
          Effect.mapError((cause) =>
            processError("spawn", "Unable to start the execution process.", cause),
          ),
        );
      const output = Stream.merge(
        child.stdout.pipe(
          Stream.decodeText(),
          Stream.map((text) => ({ stream: "stdout" as const, text })),
        ),
        child.stderr.pipe(
          Stream.decodeText(),
          Stream.map((text) => ({ stream: "stderr" as const, text })),
        ),
      ).pipe(
        Stream.mapError((cause) =>
          processError("output", "Unable to read execution process output.", cause),
        ),
      );
      // Run tree cleanup even after zero exit because descendants may survive. Missing-tree errors
      // vary by platform; decide whether cancellation failed from the direct child's liveness, not
      // signal failure alone.
      const closeOwnedProcess = yield* makeLocalOwnedProcessCleanup(child, platform);
      const cancel = closeOwnedProcess.pipe(
        Effect.mapError((cause) =>
          processError("cancel", "Unable to stop the execution process tree.", cause),
        ),
      );
      const exitCode = child.exitCode.pipe(
        Effect.map(Number),
        Effect.mapError((cause) =>
          processError("exit", "Unable to observe the execution process exit.", cause),
        ),
        Effect.tap(() => cancel),
      );
      return { output, exitCode, cancel } satisfies ExecutionProcessHandle;
    },
  );

  return ExecutionProcess.of({ start });
});

export const layer = Layer.effect(ExecutionProcess, make);
