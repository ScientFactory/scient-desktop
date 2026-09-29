/**
 * Runs the managed Pandoc as a separate program under the isolation rules of
 * the Word export design: every run gets a fresh private scratch directory as
 * its working directory, an environment built from scratch (no inherited home,
 * configuration, data directory, or PATH; proxies pointed at a closed port),
 * a GHC heap limit, a wall-clock limit, a stdout byte limit, and is killed
 * with SIGKILL (the process group; `taskkill` on Windows) when it is
 * interrupted, times out, or overruns its output. Input goes in on stdin, so
 * Pandoc never needs to read a file of Scient's.
 *
 * A process boundary is not a sandbox; `--sandbox` and the tree pass in
 * `pandocResources.ts` are what keep Pandoc from reading or fetching anything.
 */
// @effect-diagnostics nodeBuiltinImport:off -- Native child streams need an error listener before stdin writes.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";

import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

/** How to start Pandoc: the managed executable, with no leading arguments in production. */
export interface PandocCommand {
  readonly command: string;
  readonly leadingArgs: ReadonlyArray<string>;
}

/** A conversion's private directories; removed as a whole when its scope closes. */
export interface PandocScratch {
  readonly root: string;
  readonly home: string;
  readonly data: string;
  /** Pandoc's working directory; the only files it can read are copied here. */
  readonly work: string;
  readonly tmp: string;
}

export interface PandocLimits {
  readonly timeout: Duration.Input;
  /** GHC heap limit (`+RTS -M`); resident memory runs roughly 2.5× this. */
  readonly maxHeapMb: number;
  readonly maxStdoutBytes: number;
}

export const PandocRunFailureReason = Schema.Literals([
  "spawn-failed",
  "timeout",
  "output-limit",
  "heap-limit",
  "parse-error",
  "fetch-refused",
  "failed",
]);
export type PandocRunFailureReason = typeof PandocRunFailureReason.Type;

export class PandocRunError extends Schema.TaggedError<PandocRunError>()("PandocRunError", {
  reason: PandocRunFailureReason,
  exitCode: Schema.NullOr(Schema.Number),
  /** Pandoc's own error text, truncated; may name scratch paths, never shown verbatim to users. */
  detail: Schema.String,
}) {
  override get message(): string {
    return `Pandoc ${this.reason}${this.exitCode === null ? "" : ` (exit ${this.exitCode})`}: ${this.detail}`;
  }
}

/** Pandoc's documented exit codes that Scient reports distinctly. */
const PANDOC_EXIT_PARSE_ERROR = 64;
const PANDOC_EXIT_HTTP_ERROR = 61;
/** GHC's exit code when the heap limit given with `+RTS -M` is exhausted. */
const GHC_EXIT_HEAP_EXHAUSTED = 251;

const STDERR_MAX_BYTES = 256 * 1024;
/** Discard port: a fetch Pandoc attempts in spite of everything fails at once. */
const DEAD_PROXY = "http://127.0.0.1:9";

/**
 * The only environment Pandoc gets. Nothing is inherited from Scient's
 * process; Windows additionally needs `SYSTEMROOT` for the C runtime to start.
 */
export function pandocEnvironment(input: {
  readonly scratch: PandocScratch;
  readonly platform: NodeJS.Platform;
  readonly hostEnvironment: NodeJS.ProcessEnv;
}): Record<string, string> {
  const { scratch } = input;
  const env: Record<string, string> = {
    HOME: scratch.home,
    TMPDIR: scratch.tmp,
    TMP: scratch.tmp,
    TEMP: scratch.tmp,
    LANG: "C.UTF-8",
    LC_ALL: "C.UTF-8",
    PATH: "",
    http_proxy: DEAD_PROXY,
    https_proxy: DEAD_PROXY,
    HTTP_PROXY: DEAD_PROXY,
    HTTPS_PROXY: DEAD_PROXY,
    ALL_PROXY: DEAD_PROXY,
    NO_PROXY: "",
    XDG_DATA_HOME: scratch.data,
    XDG_CONFIG_HOME: scratch.data,
    XDG_CACHE_HOME: scratch.data,
  };
  if (input.platform === "win32") {
    env.SYSTEMROOT =
      input.hostEnvironment.SYSTEMROOT ?? input.hostEnvironment.SystemRoot ?? "C:\\Windows";
    env.USERPROFILE = scratch.home;
    env.APPDATA = scratch.data;
    env.LOCALAPPDATA = scratch.data;
  }
  return env;
}

/**
 * A fresh private scratch directory under `scratchRoot`, removed with
 * everything in it when the surrounding scope closes — after a success, a
 * failure, or an interruption alike.
 */
export const makePandocScratch = (scratchRoot: string) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    yield* fileSystem.makeDirectory(scratchRoot, { recursive: true });
    const root = yield* Effect.acquireRelease(
      fileSystem.makeTempDirectory({ directory: scratchRoot, prefix: "run-" }),
      (directory) =>
        fileSystem.remove(directory, { recursive: true, force: true }).pipe(Effect.ignoreCause()),
    );
    const scratch: PandocScratch = {
      root,
      home: path.join(root, "home"),
      data: path.join(root, "data"),
      work: path.join(root, "work"),
      tmp: path.join(root, "tmp"),
    };
    yield* Effect.forEach(
      [scratch.home, scratch.data, scratch.work, scratch.tmp],
      (directory) => fileSystem.makeDirectory(directory, { recursive: true }),
      { discard: true },
    );
    return scratch;
  });

/** Pandoc's `[WARNING] …` lines, one entry per warning with continuation lines joined. */
export function parsePandocWarnings(stderr: string): ReadonlyArray<string> {
  const warnings: string[] = [];
  let current: string | null = null;
  for (const line of stderr.split(/\r?\n/u)) {
    const match = /^\[(?:WARNING|INFO)\]\s*(.*)$/u.exec(line);
    if (match) {
      if (current !== null) warnings.push(current);
      current = match[1] ?? "";
    } else if (current !== null && line.trim().length > 0 && /^\s/u.test(line)) {
      current = `${current} ${line.trim()}`;
    } else if (current !== null) {
      warnings.push(current);
      current = null;
    }
  }
  if (current !== null) warnings.push(current);
  return warnings;
}

function classifyExit(code: number, stderr: string): PandocRunFailureReason {
  if (code === GHC_EXIT_HEAP_EXHAUSTED || /heap exhausted/iu.test(stderr)) return "heap-limit";
  if (code === PANDOC_EXIT_PARSE_ERROR) return "parse-error";
  if (code === PANDOC_EXIT_HTTP_ERROR) return "fetch-refused";
  return "failed";
}

export interface PandocRunInput {
  readonly pandoc: PandocCommand;
  /** Scient's own fixed arguments; never user supplied. */
  readonly args: ReadonlyArray<string>;
  readonly stdin: Uint8Array;
  readonly scratch: PandocScratch;
  readonly limits: PandocLimits;
  readonly platform: NodeJS.Platform;
  readonly hostEnvironment: NodeJS.ProcessEnv;
  /** Stream stdout into this file instead of collecting it; the byte limit still applies. */
  readonly stdoutPath?: string;
}

export interface PandocRunOutput {
  /** Collected stdout; empty when it was streamed to `stdoutPath`. */
  readonly stdout: Uint8Array;
  readonly stdoutBytes: number;
  readonly stderr: string;
  readonly warnings: ReadonlyArray<string>;
}

function concatChunks(chunks: ReadonlyArray<Uint8Array>, total: number): Uint8Array {
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

/**
 * One Pandoc run. Fails with a typed {@link PandocRunError}; interruption
 * kills the process before this effect completes, so no Pandoc outlives the
 * fiber that started it.
 */
export const runPandoc = Effect.fn("scient.pandoc.runPandoc")(function* (input: PandocRunInput) {
  const args = [
    ...input.pandoc.leadingArgs,
    ...input.args,
    "+RTS",
    `-M${Math.max(16, Math.floor(input.limits.maxHeapMb))}m`,
    "-RTS",
  ];
  const fail = (reason: PandocRunFailureReason, detail: string, exitCode: number | null = null) =>
    new PandocRunError({ reason, detail, exitCode });
  const isRunError = Schema.is(PandocRunError);
  let stopAndWait: (() => Promise<void>) | undefined;
  const run = Effect.tryPromise({
    try: (signal) =>
      new Promise<PandocRunOutput>((resolve, reject) => {
        // Effect's generic writable sink can lose its error listener when the
        // child exits while a large stdin write is pending. Own the Node stream
        // here so EPIPE is always observed, including on timeout/cancellation.
        const child = NodeChildProcess.spawn(input.pandoc.command, args, {
          cwd: input.scratch.work,
          env: pandocEnvironment(input),
          stdio: ["pipe", "pipe", "pipe"],
          detached: input.platform !== "win32",
          windowsHide: true,
        });
        const stdoutChunks: Uint8Array[] = [];
        const stderrChunks: Uint8Array[] = [];
        const outputFile =
          input.stdoutPath === undefined
            ? null
            : NodeFS.createWriteStream(input.stdoutPath, { flags: "wx" });
        let stdoutBytes = 0;
        let stderrBytes = 0;
        let stopError: PandocRunError | null = null;
        let spawnError: Error | null = null;
        let stdinError: Error | null = null;
        let settled = false;
        let closed = false;
        let finished = false;
        let killed = false;
        let resolveClosed: () => void = () => {};
        const closedPromise = new Promise<void>((resolveClosedPromise) => {
          resolveClosed = resolveClosedPromise;
        });
        const outputClosedPromise =
          outputFile === null
            ? Promise.resolve()
            : new Promise<void>((resolveOutputClosed) => {
                outputFile.once("close", resolveOutputClosed);
              });
        const kill = () => {
          if (killed) return;
          killed = true;
          if (child.pid !== undefined && input.platform !== "win32") {
            try {
              process.kill(-child.pid, "SIGKILL");
            } catch {
              child.kill("SIGKILL");
            }
          } else if (child.pid !== undefined) {
            NodeChildProcess.spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], {
              windowsHide: true,
              timeout: 5_000,
            });
            child.kill("SIGKILL");
          }
          // A paused stdout pipe can otherwise keep ChildProcess.close pending
          // after the process itself has exited.
          child.stdin.destroy();
          child.stdout.destroy();
          child.stderr.destroy();
        };
        const stop = (error: PandocRunError) => {
          if (stopError !== null) return;
          stopError = error;
          kill();
        };
        stopAndWait = async () => {
          outputFile?.destroy();
          if (!closed) {
            kill();
          }
          await Promise.all([closedPromise, outputClosedPromise]);
        };
        const aborted = () => kill();
        signal.addEventListener("abort", aborted, { once: true });
        if (signal.aborted) aborted();

        child.stdin.on("error", (error: Error) => {
          stdinError = error;
        });
        child.stdout.on("data", (chunk: Buffer) => {
          stdoutBytes += chunk.byteLength;
          if (stdoutBytes > input.limits.maxStdoutBytes) {
            stop(
              fail(
                "output-limit",
                `Pandoc produced more than ${String(input.limits.maxStdoutBytes)} bytes.`,
              ),
            );
          } else if (outputFile !== null) {
            if (!outputFile.write(chunk)) {
              child.stdout.pause();
              outputFile.once("drain", () => child.stdout.resume());
            }
          } else {
            stdoutChunks.push(Uint8Array.from(chunk));
          }
        });
        child.stdout.on("error", (error: Error) =>
          stop(fail("failed", `Reading Pandoc's output failed: ${error.message}`)),
        );
        child.stderr.on("data", (chunk: Buffer) => {
          if (stderrBytes < STDERR_MAX_BYTES) {
            const kept = chunk.subarray(0, STDERR_MAX_BYTES - stderrBytes);
            stderrChunks.push(Uint8Array.from(kept));
            stderrBytes += kept.byteLength;
          }
        });
        child.stderr.on("error", () => {});
        const finish = (code: number | null) => {
          if (finished) return;
          finished = true;
          const stderr = new TextDecoder().decode(concatChunks(stderrChunks, stderrBytes));
          if (stopError !== null) return reject(stopError);
          if (spawnError !== null) return reject(fail("spawn-failed", spawnError.message));
          if (code === null) return reject(fail("failed", stderr.trim() || "Pandoc was stopped."));
          if (code !== 0) return reject(fail(classifyExit(code, stderr), stderr.trim(), code));
          if (stdinError !== null)
            return reject(fail("failed", "Pandoc exited before it read its whole input."));
          resolve({
            stdout:
              outputFile === null ? concatChunks(stdoutChunks, stdoutBytes) : new Uint8Array(0),
            stdoutBytes,
            stderr,
            warnings: parsePandocWarnings(stderr),
          });
        };
        let closeCode: number | null = null;
        outputFile?.on("error", (error: Error) => {
          stop(fail("failed", `Writing Pandoc's output failed: ${error.message}`));
          if (closed) finish(closeCode);
        });
        child.on("error", (error: Error) => {
          spawnError = error;
        });
        child.on("close", (code) => {
          if (settled) return;
          settled = true;
          closed = true;
          closeCode = code;
          resolveClosed();
          signal.removeEventListener("abort", aborted);
          if (outputFile === null || outputFile.destroyed) finish(code);
          else outputFile.end(() => finish(code));
        });
        child.stdin.end(input.stdin);
      }),
    catch: (cause) =>
      isRunError(cause)
        ? cause
        : fail("spawn-failed", cause instanceof Error ? cause.message : String(cause)),
  });

  const timeout = Duration.fromInputUnsafe(input.limits.timeout);
  return yield* Effect.acquireUseRelease(
    Effect.void,
    () =>
      run.pipe(
        Effect.timeoutOption(timeout),
        Effect.flatMap((result) =>
          Effect.fromOption(result, () =>
            fail(
              "timeout",
              `Pandoc did not finish within ${Duration.format(timeout)} and was stopped.`,
            ),
          ),
        ),
      ),
    () => Effect.promise(() => stopAndWait?.() ?? Promise.resolve()),
  );
});
