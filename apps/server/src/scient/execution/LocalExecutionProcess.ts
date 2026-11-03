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

/** Enough to drain what an exited program wrote, short enough that nobody waits on it. */
const OUTPUT_AFTER_EXIT = "2 seconds";
/** How far reading runs ahead of a slow consumer, in chunks of up to 64 KiB. */
const READ_AHEAD = 256;

/**
 * A helper a program leaves behind, such as .NET's build server, can hold its output open for
 * good, so output ends once the program has exited and a short drain has passed. Reading runs
 * ahead of the consumer, so what the program wrote is read before the drain ends and still
 * reaches a consumer that was busy saving earlier output.
 */
export const untilExited = <A, E, R, X, F>(
  output: Stream.Stream<A, E, R>,
  exited: Effect.Effect<X, F>,
): Stream.Stream<A, E, R> =>
  output.pipe(
    Stream.interruptWhen(
      exited.pipe(Effect.ignore, Effect.andThen(Effect.sleep(OUTPUT_AFTER_EXIT))),
    ),
    Stream.buffer({ capacity: READ_AHEAD }),
  );

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
        (stream) => untilExited(stream, child.exitCode),
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
