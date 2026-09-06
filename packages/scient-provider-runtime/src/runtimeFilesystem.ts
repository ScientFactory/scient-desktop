// @effect-diagnostics nodeBuiltinImport:off globalDate:off -- App-private runtime filesystem boundary.
import * as NodeFSP from "node:fs/promises";
import * as NodeTimersPromises from "node:timers/promises";
import * as NodePerfHooks from "node:perf_hooks";

export type RuntimeFilesystemOperation = "rename" | "remove";

/** Shared by the Node runtime installer and the Effect-based ACP installer. */
export function windowsRuntimeFilesystemRetryDelay(
  code: unknown,
  operation: RuntimeFilesystemOperation,
  elapsedMs: number,
  attempt: number,
): number | undefined {
  if (
    elapsedMs >= 15_000 ||
    !["EPERM", "EACCES", "EBUSY", ...(operation === "remove" ? ["ENOTEMPTY"] : [])].includes(
      String(code),
    )
  )
    return undefined;
  return Math.min(100 * 2 ** Math.min(attempt, 4), 1_000, 15_000 - elapsedMs);
}

interface RuntimeFilesystemOptions {
  readonly signal?: AbortSignal | undefined;
}

interface RuntimeFilesystemDependencies {
  readonly platform: NodeJS.Platform;
  readonly now: () => number;
  readonly sleep: (delay: number, signal?: AbortSignal) => Promise<void>;
  readonly rename: (from: string, to: string) => Promise<void>;
  readonly lstat: (path: string) => Promise<unknown>;
  readonly rm: (path: string, options: { recursive: true; force: true }) => Promise<void>;
}

export function makeRuntimeFilesystem(overrides: Partial<RuntimeFilesystemDependencies> = {}) {
  const dependencies: RuntimeFilesystemDependencies = {
    // oxlint-disable-next-line t3code/no-global-process-runtime -- Non-Effect filesystem boundary; native host platform is injectable in tests.
    platform: process.platform,
    now: () => NodePerfHooks.performance.now(),
    sleep: (delay, signal) => NodeTimersPromises.setTimeout(delay, undefined, { signal }),
    rename: NodeFSP.rename,
    lstat: NodeFSP.lstat,
    rm: NodeFSP.rm,
    ...overrides,
  };
  async function retry(
    operation: RuntimeFilesystemOperation,
    run: () => Promise<void>,
    options: RuntimeFilesystemOptions,
    destination?: string,
  ): Promise<void> {
    const started = dependencies.now();
    let attempt = 0;
    for (;;) {
      options.signal?.throwIfAborted();
      try {
        await run();
        return;
      } catch (cause) {
        const delay =
          dependencies.platform === "win32"
            ? windowsRuntimeFilesystemRetryDelay(
                (cause as NodeJS.ErrnoException)?.code,
                operation,
                dependencies.now() - started,
                attempt++,
              )
            : undefined;
        if (delay === undefined) throw cause;
        await dependencies.sleep(delay, options.signal);
        options.signal?.throwIfAborted();
        if (destination !== undefined) {
          // Never turn a failed publish into an overwrite of another destination.
          const missing = await dependencies.lstat(destination).then(
            () => false,
            (error: NodeJS.ErrnoException) => error.code === "ENOENT",
          );
          if (!missing) throw cause;
        }
      }
    }
  }

  return {
    rename: (from: string, to: string, options: RuntimeFilesystemOptions = {}) =>
      retry("rename", () => dependencies.rename(from, to), options, to),
    remove: (path: string, options: RuntimeFilesystemOptions = {}) =>
      retry("remove", () => dependencies.rm(path, { recursive: true, force: true }), options),
  };
}

export const runtimeFilesystem = makeRuntimeFilesystem();
