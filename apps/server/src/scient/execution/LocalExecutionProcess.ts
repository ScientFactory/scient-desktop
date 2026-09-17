import {
  ExecutionProcessError,
  type ExecutionProcessHandle,
  type ExecutionProcessPort,
} from "@scientfactory/execution";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import { ChildProcessSpawner } from "effect/unstable/process";

import {
  ensureLocalOwnedProcessTreeExit,
  LOCAL_OWNED_PROCESS_KILL_OPTIONS,
  makeLocalOwnedProcess,
} from "./LocalOwnedProcess.ts";

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
  const platform = yield* HostProcessPlatform;

  const start: ExecutionProcessPort["start"] = (request) =>
    Effect.gen(function* () {
      const child = yield* spawner
        .spawn(makeLocalOwnedProcess(request, platform))
        .pipe(
          Effect.mapError((cause) =>
            processError("spawn", "Unable to start the execution process.", cause),
          ),
        );
      const ensureOwnedTreeExit = ensureLocalOwnedProcessTreeExit(Number(child.pid), platform).pipe(
        Effect.mapError((cause) =>
          processError(
            "cancel",
            "The execution process tree remained alive after cancellation.",
            cause,
          ),
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
      // Effect's Node handle targets the detached process group on Unix and uses
      // taskkill /T /F on Windows. A tree that is already gone reports failure
      // differently on each platform, so the direct child's liveness decides
      // whether the failure matters. This is also run after ordinary success:
      // the direct parent may exit zero while a subprocess it created remains.
      const cancel = yield* Effect.cached(
        child.kill(LOCAL_OWNED_PROCESS_KILL_OPTIONS).pipe(
          Effect.catch((cause) =>
            child.isRunning.pipe(
              Effect.catchCause(() => Effect.succeed(true)),
              Effect.flatMap((isRunning) =>
                isRunning
                  ? Effect.fail(
                      processError("cancel", "Unable to stop the execution process tree.", cause),
                    )
                  : Effect.void,
              ),
            ),
          ),
          Effect.andThen(ensureOwnedTreeExit),
        ),
      );
      yield* Effect.addFinalizer(() => cancel.pipe(Effect.ignore));
      const exitCode = child.exitCode.pipe(
        Effect.map(Number),
        Effect.mapError((cause) =>
          processError("exit", "Unable to observe the execution process exit.", cause),
        ),
        Effect.tap(() => cancel),
      );
      return { output, exitCode, cancel } satisfies ExecutionProcessHandle;
    });

  return ExecutionProcess.of({ start });
});

export const layer = Layer.effect(ExecutionProcess, make);
