import { ChildProcess } from "effect/process";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import type * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

export interface LocalOwnedProcessRequest {
  readonly executable: string;
  readonly args: ReadonlyArray<string>;
  readonly cwd: string;
  readonly environment: Readonly<Record<string, string>>;
  /**
   * Compute supplies a complete sanitized environment with extendEnv false; merging host variables
   * back would undo sanitization. The default remains true for compatibility.
   */
  readonly extendEnv?: boolean;
}

export const LOCAL_OWNED_PROCESS_KILL_OPTIONS = {
  killSignal: "SIGTERM",
  forceKillAfter: "5 seconds",
} as const;

const PROCESS_TREE_GRACE_ATTEMPTS = 50;
const PROCESS_TREE_FORCE_EXIT_ATTEMPTS = 100;
const PROCESS_TREE_EXIT_POLL = "20 millis";

export class LocalOwnedProcessTreeExitError extends Data.TaggedError(
  "LocalOwnedProcessTreeExitError",
)<{
  readonly pid: number;
  readonly message: string;
}> {}

/** Cached cancellation shared by owned execution and account-command adapters. */
export const makeLocalOwnedProcessCleanup = Effect.fnUntraced(function* (
  child: Pick<ChildProcessSpawner.ChildProcessHandle, "pid" | "kill" | "isRunning">,
  platform: NodeJS.Platform,
) {
  const close = yield* Effect.cached(
    child.kill(LOCAL_OWNED_PROCESS_KILL_OPTIONS).pipe(
      Effect.catch((cause) =>
        child.isRunning.pipe(
          Effect.catchCause(() => Effect.succeed(true)),
          Effect.flatMap((running) => (running ? Effect.fail(cause) : Effect.void)),
        ),
      ),
      Effect.andThen(ensureLocalOwnedProcessTreeExit(Number(child.pid), platform)),
    ),
  );
  yield* Effect.addFinalizer(() => close.pipe(Effect.ignore));
  return close;
});

/**
 * A direct child can exit while descendants ignore SIGTERM, bypassing Effect's force-kill deadline.
 * After a grace period, SIGKILL the owned Unix group and prove it is gone. Windows relies on
 * synchronous taskkill /T /F because no equivalent stable group identity is exposed.
 */
function ensureLocalOwnedProcessTreeExit(
  pid: number,
  platform: NodeJS.Platform,
): Effect.Effect<void, LocalOwnedProcessTreeExitError> {
  if (platform === "win32") return Effect.void;

  return Effect.gen(function* () {
    const processGroupId = -pid;
    const groupExists = Effect.sync(() => {
      try {
        globalThis.process.kill(processGroupId, 0);
        return true;
      } catch (cause) {
        return !(
          cause instanceof Error &&
          "code" in cause &&
          (cause as NodeJS.ErrnoException).code === "ESRCH"
        );
      }
    });
    const awaitGroupExit = Effect.fn("LocalOwnedProcess.awaitGroupExit")(function* (
      attempts: number,
    ) {
      for (let attempt = 0; attempt < attempts; attempt += 1) {
        if (!(yield* groupExists)) return true;
        yield* Effect.sleep(PROCESS_TREE_EXIT_POLL);
      }
      return !(yield* groupExists);
    });

    if (yield* awaitGroupExit(PROCESS_TREE_GRACE_ATTEMPTS)) return;

    yield* Effect.try({
      try: () => globalThis.process.kill(processGroupId, "SIGKILL"),
      catch: () =>
        new LocalOwnedProcessTreeExitError({
          pid,
          message: `Unable to force-stop owned process group ${pid}.`,
        }),
    }).pipe(
      Effect.catch((error) =>
        groupExists.pipe(Effect.flatMap((exists) => (exists ? Effect.fail(error) : Effect.void))),
      ),
    );

    if (yield* awaitGroupExit(PROCESS_TREE_FORCE_EXIT_ATTEMPTS)) return;

    return yield* new LocalOwnedProcessTreeExitError({
      pid,
      message: `Timed out waiting for owned process group ${pid} to exit after SIGKILL.`,
    });
  });
}

/**
 * One no-shell spawn policy for every Scient-owned local process tree.
 *
 * Keeping the policy here prevents the one-shot and duplex adapters from
 * drifting on environment inheritance, process groups, or kill deadlines.
 */
export function makeLocalOwnedProcess(
  request: LocalOwnedProcessRequest,
  platform: NodeJS.Platform,
  options?: { readonly keepInputOpen?: boolean },
): ChildProcess.Command {
  return ChildProcess.make(request.executable, request.args, {
    cwd: request.cwd,
    env: request.environment,
    extendEnv: request.extendEnv ?? true,
    shell: false,
    detached: platform !== "win32",
    ...LOCAL_OWNED_PROCESS_KILL_OPTIONS,
    ...(options?.keepInputOpen === true
      ? { stdin: { stream: "pipe" as const, endOnDone: false } }
      : {}),
  });
}
