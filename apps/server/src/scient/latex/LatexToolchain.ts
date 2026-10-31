/**
 * Probe read-only, cached/single-flight, in the service scope so abandoned callers do not cancel
 * discovery. Preserve system precedence but try later latexmk paths when the first is broken
 * (MiKTeX may lack Perl). Windows requires directly spawnable exe; prepend its own bin for matching
 * engines.
 */
import {
  ScientLatexCompiler,
  type ScientLatexCompilerAvailability,
  type ScientLatexToolchainKind,
  type ScientLatexToolchainStatus,
  type ScientLatexUnusableToolchain,
} from "@t3tools/contracts";
import { isWindowsCommandNotFound } from "@t3tools/provider-core/server/snapshotProbe";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { SpawnExecutableResolution } from "@t3tools/shared/shell";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";

import * as ServerConfig from "../../config.ts";
import * as ProcessRunner from "../../processRunner.ts";
import { readManagedLatexInstall } from "./managedLatexInstall.ts";
import { latexEngineEnvironment } from "./latexCommand.ts";

/**
 * The folder a driver's engines must be found in first, or `null` for one PATH
 * already resolves by name. Only a driver found by absolute path has one: the
 * managed TinyTeX, or a system `latexmk` that is not the first on PATH.
 */
export function latexDriverBinDirectory(
  status: Pick<ScientLatexToolchainStatus, "executable">,
  path: Pick<Path.Path, "dirname" | "isAbsolute">,
): string | null {
  return status.executable !== null && path.isAbsolute(status.executable)
    ? path.dirname(status.executable)
    : null;
}

export type LatexToolchainProbe = ScientLatexToolchainStatus & {
  readonly compilers: ReadonlyArray<ScientLatexCompilerAvailability>;
};

export class LatexToolchain extends Context.Service<
  LatexToolchain,
  {
    /** Omitting a compiler reports the unchanged default and all verified capabilities. */
    readonly probe: (
      refresh: boolean,
      requiredCompiler?: ScientLatexCompiler | "tectonic",
    ) => Effect.Effect<LatexToolchainProbe>;
  }
>()("t3/scient/latex/LatexToolchain") {}

const PROBE_TIMEOUT_SECONDS = 10;
const PROBE_MAX_OUTPUT_BYTES = 64 * 1024;
const PROBE_CACHE_TTL_MS = 5 * 60 * 1_000;

interface ToolchainCandidate {
  readonly kind: ScientLatexToolchainKind;
  readonly executable: string;
  readonly args: ReadonlyArray<string>;
}

interface ToolchainObservation {
  readonly primary: LatexToolchainProbe;
  readonly additional: LatexToolchainProbe | null;
  readonly report: LatexToolchainProbe;
  /** When discovery finished; freshness counts from here, not from its first probe. */
  readonly completedAtEpochMs: number;
}

const SYSTEM_LATEXMK: ToolchainCandidate = {
  kind: "latexmk",
  executable: "latexmk",
  args: ["-v"],
};
const SYSTEM_TECTONIC: ToolchainCandidate = {
  kind: "tectonic",
  executable: "tectonic",
  args: ["--version"],
};

const LATEXMK_VERSION_PATTERN = /Version\s+([0-9][\w.-]*)/iu;
const TECTONIC_VERSION_PATTERN = /Tectonic\s+([0-9][\w.+-]*)/iu;
const LOOSE_VERSION_PATTERN = /([0-9]+(?:\.[0-9]+)+)/u;
const COMPILER_VERSION_PATTERNS = {
  pdflatex: /pdfTeX\s+[\d.]+-[\d.]+-([0-9][\w.+-]*)/iu,
  xelatex: /XeTeX\s+[\d.]+-[\d.]+-([0-9][\w.+-]*)/iu,
  lualatex: /Lua(?:HB)?TeX,?\s+(?:Version\s+)?([0-9][\w.+-]*)/iu,
};

/** Reads the engine's own `-v` banner; an unparsable banner still proves the engine exists. */
export function parseLatexToolchainVersion(
  kind: ScientLatexToolchainKind,
  output: string,
): string | null {
  const pattern = kind === "latexmk" ? LATEXMK_VERSION_PATTERN : TECTONIC_VERSION_PATTERN;
  const matched = pattern.exec(output) ?? LOOSE_VERSION_PATTERN.exec(output);
  return matched?.[1] ?? null;
}

const absent = (
  probedAtEpochMs: number,
  unusable: ReadonlyArray<ScientLatexUnusableToolchain> = [],
): ScientLatexToolchainStatus => ({
  kind: null,
  executable: null,
  version: null,
  probedAtEpochMs,
  ...(unusable.length > 0 ? { unusable } : {}),
});

const MAX_UNUSABLE_REASON_LENGTH = 240;

const fileNameOf = (file: string) => file.split(/[\\/]/u).at(-1) ?? file;

/**
 * A driver named without its folder, which on Windows carries the user's
 * name: "MiKTeX's latexmk.exe", "TeX Live's latexmk.exe", or the file alone.
 */
export function latexDriverLabel(executable: string): string {
  const folder = executable.toLowerCase();
  const distribution = folder.includes("miktex")
    ? "MiKTeX's "
    : folder.includes("texlive") || folder.includes("tinytex")
      ? "TeX Live's "
      : "";
  return `${distribution}${fileNameOf(executable)}`;
}

/**
 * A tool's complaint with the user's home folder written as `~`: the reason
 * reaches agents and logs, and that folder is named after the person.
 */
export function withoutHomeDirectory(text: string, environment: NodeJS.ProcessEnv): string {
  let redacted = text;
  for (const name of ["USERPROFILE", "HOME"]) {
    const home = environmentValue(environment, name)?.replace(/[\\/]+$/u, "");
    if (home === undefined || home.length < 3) continue;
    for (const spelling of new Set([
      home,
      home.replaceAll("\\", "/"),
      home.replaceAll("/", "\\"),
    ])) {
      const escaped = spelling.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
      redacted = redacted.replace(new RegExp(escaped, "giu"), "~");
    }
  }
  return redacted;
}

/**
 * The line a person would read first in a failed probe's output. Launchers
 * such as MiKTeX's lead with a sentence ending in a colon and put the cause on
 * the next line, so a line introducing another is skipped.
 */
export function latexProbeFailureReason(input: {
  readonly stdout: string;
  readonly stderr: string;
  readonly code: number | null;
  readonly timedOut: boolean;
  readonly timeoutSeconds: number;
}): string {
  if (input.timedOut) return `It did not answer within ${String(input.timeoutSeconds)} seconds.`;
  const lines = `${input.stderr}\n${input.stdout}`
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  const line = lines.find((candidate) => !candidate.endsWith(":")) ?? lines[0];
  if (line === undefined) return `It exited with code ${String(input.code)}.`;
  return line.length > MAX_UNUSABLE_REASON_LENGTH
    ? `${line.slice(0, MAX_UNUSABLE_REASON_LENGTH - 1)}…`
    : line;
}

function environmentValue(environment: NodeJS.ProcessEnv, name: string): string | null {
  const key = Object.keys(environment).find(
    (candidate) => candidate.toUpperCase() === name.toUpperCase(),
  );
  const found = key === undefined ? undefined : environment[key]?.trim();
  return found === undefined || found === "" ? null : found;
}

/** TeX Live's default `<drive>\texlive`; `null` without a system drive to put it on. */
function windowsTexliveRoot(
  environment: NodeJS.ProcessEnv,
  join: (...segments: ReadonlyArray<string>) => string,
): string | null {
  const drive = environmentValue(environment, "SystemDrive");
  return drive === null ? null : join(`${drive}\\`, "texlive");
}

/**
 * Where MiKTeX and TeX Live put `latexmk.exe` by default, newest TeX Live
 * first. `texliveYears` is the listing of `<drive>\texlive`.
 */
export function windowsLatexmkFolders(input: {
  readonly environment: NodeJS.ProcessEnv;
  readonly texliveYears: ReadonlyArray<string>;
  readonly join: (...segments: ReadonlyArray<string>) => string;
}): ReadonlyArray<string> {
  const value = (name: string) => environmentValue(input.environment, name);
  const folders: Array<string> = [];
  const localAppData = value("LOCALAPPDATA");
  if (localAppData !== null) {
    folders.push(input.join(localAppData, "Programs", "MiKTeX", "miktex", "bin", "x64"));
  }
  const programFiles = value("ProgramFiles");
  if (programFiles !== null) {
    folders.push(input.join(programFiles, "MiKTeX", "miktex", "bin", "x64"));
  }
  const texliveRoot = windowsTexliveRoot(input.environment, input.join);
  if (texliveRoot === null) return folders;
  const years = input.texliveYears
    .filter((year) => /^\d{4}$/u.test(year))
    .toSorted()
    .toReversed();
  for (const year of years) {
    // `windows` since TeX Live 2023; `win64`/`win32` before it.
    for (const platformFolder of ["windows", "win64", "win32"]) {
      folders.push(input.join(texliveRoot, year, "bin", platformFolder));
    }
  }
  return folders;
}

type CandidateProbe =
  | { readonly _tag: "found"; readonly status: ScientLatexToolchainStatus }
  | { readonly _tag: "unusable"; readonly unusable: ScientLatexUnusableToolchain }
  | { readonly _tag: "missing" };

export const make = Effect.gen(function* () {
  const processRunner = yield* ProcessRunner.ProcessRunner;
  const hostEnvironment = yield* HostProcess.Environment;
  const platform = yield* HostProcess.Platform;
  const path = yield* Path.Path;
  const resolveExecutable = yield* SpawnExecutableResolution;
  const pathDelimiter = platform === "win32" ? ";" : ":";
  // The managed lookup reads app state, but `probe` must stay dependency-free
  // for its callers, so its services are captured once here.
  const managedContext = yield* Effect.context<
    FileSystem.FileSystem | Path.Path | ServerConfig.ServerConfig
  >();
  const findManagedInstall = readManagedLatexInstall().pipe(Effect.provideContext(managedContext));
  const cacheRef = yield* Ref.make<ToolchainObservation | null>(null);
  const tectonicCacheRef = yield* Ref.make<{
    readonly status: LatexToolchainProbe;
    readonly completedAtEpochMs: number;
  } | null>(null);
  // Every build and every status poll asks for the toolchain, so a lapsed TTL
  // would otherwise let a burst of pollers each shell out. One discovery runs;
  // the rest join it and read the answer it leaves in the cache.
  const inflightRef = yield* Ref.make<Deferred.Deferred<ToolchainObservation> | null>(null);
  const discoveryScope = yield* Scope.make("sequential");
  yield* Effect.addFinalizer(() => Scope.close(discoveryScope, Exit.void));
  const tectonicGate = yield* Semaphore.make(1);

  const runCandidate = (
    candidate: ToolchainCandidate,
    probedAtEpochMs: number,
    source: NonNullable<ScientLatexToolchainStatus["source"]> = "system",
    env: NodeJS.ProcessEnv = {},
  ): Effect.Effect<CandidateProbe> =>
    processRunner
      .run({
        command: candidate.executable,
        args: candidate.args,
        env,
        timeout: Duration.seconds(PROBE_TIMEOUT_SECONDS),
        maxOutputBytes: PROBE_MAX_OUTPUT_BYTES,
        outputMode: "truncate",
        timeoutBehavior: "timedOutResult",
      })
      .pipe(
        Effect.flatMap((result) =>
          Effect.gen(function* (): Effect.fn.Return<CandidateProbe> {
            // A missing engine fails to spawn and is caught below. This is the
            // other Windows case: a `.cmd`/`.bat` shim that does resolve, runs
            // through cmd.exe, and cannot find what it wraps — which exits
            // 9009 with a diagnostic instead of failing to start.
            const notFound = yield* isWindowsCommandNotFound(result.code, result.stderr);
            if (notFound) return { _tag: "missing" };
            if (result.timedOut || result.code !== 0) {
              return {
                _tag: "unusable",
                unusable: {
                  executable: candidate.executable,
                  // Redacted before the line is chosen and cut, so a cut
                  // inside the home folder cannot leave half of it behind.
                  reason: latexProbeFailureReason({
                    stdout: withoutHomeDirectory(result.stdout, hostEnvironment),
                    stderr: withoutHomeDirectory(result.stderr, hostEnvironment),
                    code: result.code,
                    timedOut: result.timedOut,
                    timeoutSeconds: PROBE_TIMEOUT_SECONDS,
                  }),
                },
              };
            }
            const banner = `${result.stdout}\n${result.stderr}`;
            return {
              _tag: "found",
              status: {
                kind: candidate.kind,
                executable: candidate.executable,
                version: parseLatexToolchainVersion(candidate.kind, banner),
                probedAtEpochMs,
                source,
              },
            };
          }),
        ),
        // A spawn error means the engine is not installed on this machine.
        Effect.orElseSucceed((): CandidateProbe => ({ _tag: "missing" })),
      );

  const probeCandidate = (
    candidate: ToolchainCandidate,
    probedAtEpochMs: number,
    source: NonNullable<ScientLatexToolchainStatus["source"]> = "system",
    env: NodeJS.ProcessEnv = {},
  ) =>
    runCandidate(candidate, probedAtEpochMs, source, env).pipe(
      Effect.map((probed) => (probed._tag === "found" ? probed.status : null)),
    );

  const fileExists = (file: string) =>
    FileSystem.FileSystem.use((fileSystem) => fileSystem.exists(file)).pipe(
      Effect.provideContext(managedContext),
      Effect.orElseSucceed(() => false),
    );

  /**
   * Every `latexmk` this computer has, by absolute path, in the order a
   * person would expect it to be chosen: PATH, then the default install
   * folders. The bare name's probe cannot say which file it ran (the spawn
   * resolution is cached), so none is skipped as already tried.
   */
  const latexmkCandidates = Effect.gen(function* () {
    const fileName = platform === "win32" ? "latexmk.exe" : "latexmk";
    const pathKey =
      Object.keys(hostEnvironment).find((key) => key.toUpperCase() === "PATH") ?? "PATH";
    const pathFolders = (hostEnvironment[pathKey] ?? "")
      .split(pathDelimiter)
      .map((entry) => entry.trim().replace(/^"(.*)"$/u, "$1"))
      .filter((entry) => entry.length > 0)
      // A relative entry means what it means to the process spawning by name.
      .map((entry) => path.resolve(entry));
    let installFolders: ReadonlyArray<string> = [];
    if (platform === "win32") {
      const texliveRoot = windowsTexliveRoot(hostEnvironment, path.join);
      const texliveYears =
        texliveRoot === null
          ? []
          : yield* FileSystem.FileSystem.use((fileSystem) =>
              fileSystem.readDirectory(texliveRoot),
            ).pipe(
              Effect.provideContext(managedContext),
              Effect.orElseSucceed((): ReadonlyArray<string> => []),
            );
      installFolders = windowsLatexmkFolders({
        environment: hostEnvironment,
        texliveYears,
        join: path.join,
      });
    }
    const identity = (file: string) => (platform === "win32" ? file.toLowerCase() : file);
    const seen = new Set<string>();
    const found: Array<string> = [];
    for (const folder of [...pathFolders, ...installFolders]) {
      const executable = path.join(folder, fileName);
      if (seen.has(identity(executable))) continue;
      seen.add(identity(executable));
      if (yield* fileExists(executable)) found.push(executable);
    }
    return found;
  });

  /** The first `latexmk` that answers, with every one that did not. */
  const findLatexmk = Effect.fnUntraced(function* (probedAtEpochMs: number) {
    const unusable: Array<ScientLatexUnusableToolchain> = [];
    const first = yield* runCandidate(SYSTEM_LATEXMK, probedAtEpochMs);
    // A working bare name keeps its exact previous result: no path, no PATH change.
    if (first._tag === "found") return { status: first.status, unusable };
    for (const executable of yield* latexmkCandidates) {
      const probed = yield* runCandidate(
        { kind: "latexmk", executable, args: ["-v"] },
        probedAtEpochMs,
        "system",
        latexEngineEnvironment({
          base: {},
          hostEnvironment,
          binDirectory: path.dirname(executable),
          pathDelimiter,
        }),
      );
      if (probed._tag === "found") return { status: probed.status, unusable };
      if (probed._tag === "unusable") unusable.push(probed.unusable);
    }
    // Only when no file could be named does the bare name's failure stand for itself.
    if (first._tag === "unusable" && unusable.length === 0) {
      unusable.push({
        ...first.unusable,
        executable: resolveExecutable("latexmk", platform, hostEnvironment) ?? "latexmk",
      });
    }
    return { status: null, unusable };
  });

  const probeCompilers = Effect.fnUntraced(function* (status: ScientLatexToolchainStatus) {
    const environment = latexEngineEnvironment({
      base: {},
      hostEnvironment,
      binDirectory: latexDriverBinDirectory(status, path),
      pathDelimiter,
    });
    return yield* Effect.forEach(ScientLatexCompiler.literals, (compiler) =>
      Effect.gen(function* (): Effect.fn.Return<ScientLatexCompilerAvailability> {
        const missing = { compiler, available: false, executable: null, version: null };
        // Tectonic embeds XeTeX, but does not run any of these binaries.
        if (status.kind !== "latexmk") return missing;
        const executable =
          resolveExecutable(compiler, platform, { ...hostEnvironment, ...environment }) ?? compiler;
        return yield* processRunner
          .run({
            command: executable,
            args: ["--version"],
            env: environment,
            timeout: Duration.seconds(PROBE_TIMEOUT_SECONDS),
            maxOutputBytes: PROBE_MAX_OUTPUT_BYTES,
            outputMode: "truncate",
            timeoutBehavior: "timedOutResult",
          })
          .pipe(
            Effect.flatMap((result) =>
              Effect.gen(function* () {
                const notFound = yield* isWindowsCommandNotFound(result.code, result.stderr);
                if (result.timedOut || notFound || result.code !== 0) return missing;
                const banner = `${result.stdout}\n${result.stderr}`;
                return {
                  compiler,
                  available: true,
                  executable,
                  version:
                    (COMPILER_VERSION_PATTERNS[compiler].exec(banner) ??
                      LOOSE_VERSION_PATTERN.exec(banner))?.[1] ?? null,
                };
              }),
            ),
            Effect.orElseSucceed(() => missing),
          );
      }),
    );
  });
  const probeAll = Effect.gen(function* (): Effect.fn.Return<
    Omit<ToolchainObservation, "completedAtEpochMs">
  > {
    const probedAtEpochMs = yield* Clock.currentTimeMillis;
    const latexmk = yield* findLatexmk(probedAtEpochMs);
    let systemStatus: ScientLatexToolchainStatus;
    if (latexmk.status !== null) {
      systemStatus = latexmk.status;
    } else {
      const tectonic = yield* runCandidate(SYSTEM_TECTONIC, probedAtEpochMs);
      systemStatus =
        tectonic._tag === "found"
          ? tectonic.status
          : absent(probedAtEpochMs, [
              ...latexmk.unusable,
              ...(tectonic._tag === "unusable" ? [tectonic.unusable] : []),
            ]);
    }
    const primary = { ...systemStatus, compilers: yield* probeCompilers(systemStatus) };
    if (primary.compilers.every((compiler) => compiler.available)) {
      return { primary, additional: null, report: primary };
    }

    // Discovery only reads the recorded install and runs bounded version probes.
    // Optional compilers never replace the working default driver.
    const managed = yield* findManagedInstall;
    if (managed !== null) {
      const status = yield* probeCandidate(
        { kind: "latexmk", executable: managed.executable, args: ["-v"] },
        probedAtEpochMs,
        "scient-managed",
        latexEngineEnvironment({
          base: {},
          hostEnvironment,
          binDirectory: path.dirname(managed.executable),
          pathDelimiter,
        }),
      );
      if (status !== null) {
        const additional = { ...status, compilers: yield* probeCompilers(status) };
        if (primary.kind === null) {
          return { primary: additional, additional: null, report: additional };
        }
        const compilers = primary.compilers.map((compiler) =>
          compiler.available
            ? compiler
            : (additional.compilers.find(
                (candidate) => candidate.compiler === compiler.compiler && candidate.available,
              ) ?? compiler),
        );
        return { primary, additional, report: { ...primary, compilers } };
      }
    }
    return { primary, additional: null, report: primary };
  });

  const isFresh = Effect.fnUntraced(function* (
    cached: { readonly completedAtEpochMs: number } | null,
  ) {
    if (cached === null) return false;
    const now = yield* Clock.currentTimeMillis;
    return now - cached.completedAtEpochMs < PROBE_CACHE_TTL_MS;
  });

  /**
   * Recheck the cache before starting discovery because another run may just have finished. Refresh
   * requires a run begun after the request; join one follow-up after an older run without
   * recursively demanding another refresh.
   */
  const discover = (
    mode: "cached" | "refresh" | "follow-up",
  ): Effect.Effect<ToolchainObservation> =>
    // Claiming the slot and starting the worker are one uninterruptible step:
    // a caller cancelled between them would leave a claim nothing completes,
    // and every later caller would wait on it forever. Only the waits are
    // interruptible, and the worker itself stays interruptible by its scope.
    Effect.uninterruptibleMask((restore) =>
      Effect.gen(function* () {
        const next = yield* Deferred.make<ToolchainObservation>();
        // A finished claim nothing cleared (its worker was interrupted before
        // it ran) is replaced rather than joined.
        const joined = yield* Ref.modify(inflightRef, (current) =>
          current === null || Deferred.isDoneUnsafe(current) ? [null, next] : [current, current],
        );
        if (joined !== null) {
          const observation = yield* restore(Deferred.await(joined));
          return mode === "refresh" ? yield* restore(discover("follow-up")) : observation;
        }
        if (mode === "cached") {
          // A run clears its claim only after caching, so a claim taken after
          // it finished sees its result here.
          const settled = yield* Ref.get(cacheRef);
          if (settled !== null && (yield* isFresh(settled))) {
            yield* Ref.set(inflightRef, null);
            yield* Deferred.succeed(next, settled);
            return settled;
          }
        }
        const worker = yield* Effect.forkIn(
          restore(
            probeAll.pipe(
              Effect.flatMap((observed) =>
                Effect.gen(function* () {
                  const observation = {
                    ...observed,
                    completedAtEpochMs: yield* Clock.currentTimeMillis,
                  };
                  yield* Ref.set(cacheRef, observation);
                  return observation;
                }),
              ),
            ),
          ).pipe(
            // A finalizer, so it also runs when the service's scope interrupts
            // the worker: whoever is waiting is released, not left suspended.
            Effect.onExit((exit) =>
              Ref.set(inflightRef, null).pipe(Effect.andThen(Deferred.done(next, exit))),
            ),
          ),
          discoveryScope,
        );
        // The worker's own finalizer cannot run if the scope interrupts it
        // before its first step; its exit still reaches whoever waits here.
        worker.addObserver((exit) => {
          Deferred.doneUnsafe(next, exit);
        });
        return yield* restore(Deferred.await(next));
      }),
    );

  const select = (observation: ToolchainObservation, compiler?: ScientLatexCompiler) => {
    if (compiler === undefined) return observation.report;
    const { primary, additional } = observation;
    if (
      (primary.kind === "tectonic" && compiler === "xelatex") ||
      primary.compilers.some((candidate) => candidate.compiler === compiler && candidate.available)
    )
      return primary;
    return additional?.compilers.some(
      (candidate) => candidate.compiler === compiler && candidate.available,
    )
      ? additional
      : primary;
  };

  const probe = Effect.fnUntraced(function* (
    refresh: boolean,
    requiredCompiler?: ScientLatexCompiler | "tectonic",
  ) {
    if (requiredCompiler === "tectonic") {
      return yield* tectonicGate.withPermits(1)(
        Effect.gen(function* () {
          const primary = yield* Ref.get(cacheRef);
          const cached =
            primary?.primary.kind === "tectonic"
              ? { status: primary.primary, completedAtEpochMs: primary.completedAtEpochMs }
              : yield* Ref.get(tectonicCacheRef);
          if (!refresh && cached !== null && (yield* isFresh(cached))) return cached.status;
          const now = yield* Clock.currentTimeMillis;
          const probed = yield* runCandidate(SYSTEM_TECTONIC, now);
          const found =
            probed._tag === "found"
              ? probed.status
              : absent(now, probed._tag === "unusable" ? [probed.unusable] : []);
          const status = { ...found, compilers: yield* probeCompilers(found) };
          yield* Ref.set(tectonicCacheRef, {
            status,
            completedAtEpochMs: yield* Clock.currentTimeMillis,
          });
          return status;
        }),
      );
    }
    if (refresh) yield* Ref.set(tectonicCacheRef, null);
    const cached = yield* Ref.get(cacheRef);
    if (!refresh && cached !== null && (yield* isFresh(cached)))
      return select(cached, requiredCompiler);
    return select(yield* discover(refresh ? "refresh" : "cached"), requiredCompiler);
  });

  return LatexToolchain.of({ probe });
});

export const layer = Layer.effect(LatexToolchain, make).pipe(Layer.provide(ProcessRunner.layer));
