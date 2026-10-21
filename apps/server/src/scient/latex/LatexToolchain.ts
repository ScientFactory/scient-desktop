/**
 * Discovers this server's build driver and the standalone compiler binaries
 * it can run. Probes are bounded subprocesses; missing or broken executables
 * are normal on a fresh machine. Driver and compiler facts share a cached,
 * single-flight observation so status polling never launches a build.
 *
 * PATH keeps its original precedence: latexmk, then Tectonic. Managed TinyTeX
 * is an optional addition for a compiler that the document needs but PATH
 * cannot provide, or the fallback when no system driver is available.
 *
 * The first `latexmk` on PATH is not always one that runs: MiKTeX's needs a
 * Perl it does not ship, and a computer with MiKTeX ahead of TeX Live on PATH
 * would otherwise report no LaTeX at all. When the first one fails, every
 * other `latexmk` on PATH is tried, then (on Windows) the folders MiKTeX and
 * TeX Live install into, which also covers a PATH this process inherited
 * before the distribution was installed. One found that way is run with its
 * own folder leading PATH, so it drives its own distribution's engines.
 */
import {
  ScientLatexCompiler,
  type ScientLatexCompilerAvailability,
  type ScientLatexToolchainKind,
  type ScientLatexToolchainStatus,
  type ScientLatexUnusableToolchain,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { SpawnExecutableResolution } from "@t3tools/shared/shell";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
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
/** MiKTeX's first run refreshes its file database, and a scanner may hold a fresh binary. */
const WINDOWS_DRIVER_PROBE_TIMEOUT_SECONDS = 30;
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
  const tectonicCacheRef = yield* Ref.make<LatexToolchainProbe | null>(null);
  // Every build and every status poll asks for the toolchain, so a lapsed TTL
  // would otherwise let a burst of pollers each shell out. One probe runs; the
  // rest queue here and read the answer it leaves in the cache.
  const probeGate = yield* Semaphore.make(1);

  const driverProbeTimeoutSeconds =
    platform === "win32" ? WINDOWS_DRIVER_PROBE_TIMEOUT_SECONDS : PROBE_TIMEOUT_SECONDS;

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
        timeout: Duration.seconds(driverProbeTimeoutSeconds),
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
            const notFound = yield* ProcessRunner.isWindowsCommandNotFound(
              result.code,
              result.stderr,
            );
            if (notFound) return { _tag: "missing" };
            if (result.timedOut || result.code !== 0) {
              return {
                _tag: "unusable",
                unusable: {
                  executable:
                    resolveExecutable(candidate.executable, platform, {
                      ...hostEnvironment,
                      ...env,
                    }) ?? candidate.executable,
                  reason: latexProbeFailureReason({
                    stdout: result.stdout,
                    stderr: result.stderr,
                    code: result.code,
                    timedOut: result.timedOut,
                    timeoutSeconds: driverProbeTimeoutSeconds,
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
   * Every other `latexmk` this computer has, in the order a person would
   * expect it to be chosen: the rest of PATH, then the default install
   * folders. The one the bare name resolves to has already been tried.
   */
  const alternativeLatexmks = Effect.gen(function* () {
    const fileName = platform === "win32" ? "latexmk.exe" : "latexmk";
    const pathKey =
      Object.keys(hostEnvironment).find((key) => key.toUpperCase() === "PATH") ?? "PATH";
    const pathFolders = (hostEnvironment[pathKey] ?? "")
      .split(pathDelimiter)
      .map((entry) => entry.trim().replace(/^"(.*)"$/u, "$1"))
      .filter((entry) => entry.length > 0 && path.isAbsolute(entry));
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
    const alreadyTried = resolveExecutable("latexmk", platform, hostEnvironment);
    const seen = new Set<string>(alreadyTried === undefined ? [] : [identity(alreadyTried)]);
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
    if (first._tag === "found") return { status: first.status, unusable };
    if (first._tag === "unusable") unusable.push(first.unusable);
    for (const executable of yield* alternativeLatexmks) {
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
                const notFound = yield* ProcessRunner.isWindowsCommandNotFound(
                  result.code,
                  result.stderr,
                );
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
  const probeAll = Effect.gen(function* (): Effect.fn.Return<ToolchainObservation> {
    const probedAtEpochMs = yield* Clock.currentTimeMillis;
    const latexmk = yield* findLatexmk(probedAtEpochMs);
    const systemStatus =
      latexmk.status ??
      (yield* probeCandidate(SYSTEM_TECTONIC, probedAtEpochMs)) ??
      absent(probedAtEpochMs, latexmk.unusable);
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

  const isFresh = Effect.fnUntraced(function* (cached: ToolchainObservation | null) {
    if (cached === null) return false;
    const now = yield* Clock.currentTimeMillis;
    return now - cached.primary.probedAtEpochMs < PROBE_CACHE_TTL_MS;
  });

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
      return yield* probeGate.withPermits(1)(
        Effect.gen(function* () {
          const primary = (yield* Ref.get(cacheRef))?.primary;
          const cached = primary?.kind === "tectonic" ? primary : yield* Ref.get(tectonicCacheRef);
          const now = yield* Clock.currentTimeMillis;
          if (!refresh && cached !== null && now - cached.probedAtEpochMs < PROBE_CACHE_TTL_MS)
            return cached;
          const found = (yield* probeCandidate(SYSTEM_TECTONIC, now)) ?? absent(now);
          const status = { ...found, compilers: yield* probeCompilers(found) };
          yield* Ref.set(tectonicCacheRef, status);
          return status;
        }),
      );
    }
    if (refresh) yield* Ref.set(tectonicCacheRef, null);
    const cached = yield* Ref.get(cacheRef);
    if (!refresh && (yield* isFresh(cached)) && cached !== null)
      return select(cached, requiredCompiler);
    return yield* probeGate.withPermits(1)(
      Effect.gen(function* () {
        // Re-read behind the gate: queued pollers reuse the observation.
        const settled = yield* Ref.get(cacheRef);
        if (!refresh && (yield* isFresh(settled)) && settled !== null)
          return select(settled, requiredCompiler);
        const status = yield* probeAll;
        yield* Ref.set(cacheRef, status);
        return select(status, requiredCompiler);
      }),
    );
  });

  return LatexToolchain.of({ probe });
});

export const layer = Layer.effect(LatexToolchain, make).pipe(Layer.provide(ProcessRunner.layer));
