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
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/unstable/process/ChildProcess";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";

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
export const PANDOC_EXIT_PARSE_ERROR = 64;
export const PANDOC_EXIT_HTTP_ERROR = 61;
/** GHC's exit code when the heap limit given with `+RTS -M` is exhausted. */
export const GHC_EXIT_HEAP_EXHAUSTED = 251;

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
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const fileSystem = yield* FileSystem.FileSystem;
  const args = [
    ...input.pandoc.leadingArgs,
    ...input.args,
    "+RTS",
    `-M${Math.max(16, Math.floor(input.limits.maxHeapMb))}m`,
    "-RTS",
  ];
  const fail = (reason: PandocRunFailureReason, detail: string, exitCode: number | null = null) =>
    new PandocRunError({ reason, detail, exitCode });

  const run = Effect.gen(function* () {
    const child = yield* spawner
      .spawn(
        ChildProcess.make(input.pandoc.command, args, {
          cwd: input.scratch.work,
          env: pandocEnvironment(input),
          extendEnv: false,
          killSignal: "SIGKILL",
          stdin: "pipe",
          stdout: "pipe",
          stderr: "pipe",
        }),
      )
      .pipe(Effect.mapError((cause) => fail("spawn-failed", String(cause.message))));

    const stdoutBytes = yield* Ref.make(0);
    const capped = child.stdout.pipe(
      Stream.mapError((cause) =>
        fail("failed", `Reading Pandoc's output failed: ${cause.message}`),
      ),
      Stream.tap((chunk) =>
        Ref.updateAndGet(stdoutBytes, (total) => total + chunk.byteLength).pipe(
          Effect.flatMap((total) =>
            total > input.limits.maxStdoutBytes
              ? Effect.fail(
                  fail(
                    "output-limit",
                    `Pandoc produced more than ${String(input.limits.maxStdoutBytes)} bytes.`,
                  ),
                )
              : Effect.void,
          ),
        ),
      ),
    );
    const collectStdout =
      input.stdoutPath === undefined
        ? capped.pipe(
            Stream.runCollect,
            Effect.flatMap((chunks) =>
              Ref.get(stdoutBytes).pipe(Effect.map((total) => concatChunks(chunks, total))),
            ),
          )
        : capped.pipe(
            Stream.run(fileSystem.sink(input.stdoutPath, { flag: "w" })),
            Effect.mapError((cause) =>
              cause._tag === "PandocRunError"
                ? cause
                : fail("failed", `Writing Pandoc's output failed: ${cause.message}`),
            ),
            Effect.as(new Uint8Array(0)),
          );
    const collectStderr = child.stderr.pipe(
      Stream.runFold(
        () => ({ chunks: [] as Array<Uint8Array>, bytes: 0 }),
        (state, chunk: Uint8Array) => {
          if (state.bytes < STDERR_MAX_BYTES) {
            state.chunks.push(chunk);
            state.bytes += chunk.byteLength;
          }
          return state;
        },
      ),
      Effect.map((state) => new TextDecoder().decode(concatChunks(state.chunks, state.bytes))),
      Effect.orElseSucceed(() => ""),
    );
    // Pandoc may stop reading early when it fails; the exit code says why.
    const writeStdin = Stream.run(Stream.make(input.stdin), child.stdin).pipe(Effect.exit);

    const [stdout, stderr, stdinExit] = yield* Effect.all(
      [collectStdout, collectStderr, writeStdin],
      { concurrency: "unbounded" },
    );
    const code = yield* child.exitCode.pipe(
      Effect.mapError(() => fail("failed", stderr.trim() || "Pandoc was stopped by a signal.")),
    );
    if (code !== 0) return yield* fail(classifyExit(code, stderr), stderr.trim(), code);
    if (Exit.isFailure(stdinExit)) {
      return yield* fail("failed", "Pandoc exited before it read its whole input.");
    }
    return {
      stdout,
      stdoutBytes: yield* Ref.get(stdoutBytes),
      stderr,
      warnings: parsePandocWarnings(stderr),
    } satisfies PandocRunOutput;
  });

  const timeout = Duration.fromInputUnsafe(input.limits.timeout);
  return yield* Effect.scoped(run).pipe(
    Effect.timeoutOption(timeout),
    Effect.flatMap((result) =>
      Effect.fromOption(result, () =>
        fail(
          "timeout",
          `Pandoc did not finish within ${Duration.format(timeout)} and was stopped.`,
        ),
      ),
    ),
  );
});
