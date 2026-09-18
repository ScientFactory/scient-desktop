import { ChildProcess } from "effect/unstable/process";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";

export interface LocalOwnedProcessRequest {
  readonly executable: string;
  readonly args: ReadonlyArray<string>;
  readonly cwd: string;
  readonly environment: Readonly<Record<string, string>>;
  /**
   * Whether to merge the host environment into `environment`. Defaults to
   * `true` for backward compatibility. Compute launches pass a complete
   * sanitized environment with `extendEnv: false`; passing a sanitized record
   * while the process layer silently re-adds the host environment is not
   * sanitization.
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

/**
 * Ensure the detached Unix process group owned by a Scient launch is gone.
 *
 * Effect's process layer waits for the direct child after signalling the owned
 * tree. That is not enough on Unix: once the direct child exits, a descendant
 * can ignore SIGTERM indefinitely and the process layer no longer reaches its
 * force-kill deadline. Give cooperative descendants a short grace period,
 * then escalate the still-owned process group to SIGKILL and prove it is gone.
 *
 * Windows uses the process layer's synchronous `taskkill /T /F` contract. It
 * does not expose an equivalent stable process-group identity that can be
 * probed safely here, so Windows remains qualified by that process-layer
 * boundary rather than by the Unix proof below.
 */
export function ensureLocalOwnedProcessTreeExit(
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
    const awaitGroupExit = (attempts: number) =>
      Effect.gen(function* () {
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
