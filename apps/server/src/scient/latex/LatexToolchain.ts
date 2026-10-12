/**
 * Discovers this server's build driver and the standalone compiler binaries
 * it can run. Probes are bounded subprocesses; missing or broken executables
 * are normal on a fresh machine. Driver and compiler facts share a cached,
 * single-flight observation so status polling never launches a build.
 *
 * PATH keeps its original precedence: latexmk, then Tectonic. Managed TinyTeX
 * is an optional addition for a compiler that the document needs but PATH
 * cannot provide, or the fallback when no system driver is available.
 */
import {
  ScientLatexCompiler,
  type ScientLatexCompilerAvailability,
  type ScientLatexToolchainKind,
  type ScientLatexToolchainStatus,
} from "@t3tools/contracts";
import { HostProcessEnvironment, HostProcessPlatform } from "@t3tools/shared/hostProcess";
import { SpawnExecutableResolution } from "@t3tools/shared/shell";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
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

const PROBE_TIMEOUT = "10 seconds";
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

const absent = (probedAtEpochMs: number): ScientLatexToolchainStatus => ({
  kind: null,
  executable: null,
  version: null,
  probedAtEpochMs,
});

export const make = Effect.gen(function* () {
  const processRunner = yield* ProcessRunner.ProcessRunner;
  const hostEnvironment = yield* HostProcessEnvironment;
  const platform = yield* HostProcessPlatform;
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

  const probeCandidate = (
    candidate: ToolchainCandidate,
    probedAtEpochMs: number,
    source: NonNullable<ScientLatexToolchainStatus["source"]> = "system",
    env: NodeJS.ProcessEnv = {},
  ) =>
    processRunner
      .run({
        command: candidate.executable,
        args: candidate.args,
        env,
        timeout: PROBE_TIMEOUT,
        maxOutputBytes: PROBE_MAX_OUTPUT_BYTES,
        outputMode: "truncate",
        timeoutBehavior: "timedOutResult",
      })
      .pipe(
        Effect.flatMap((result) =>
          Effect.gen(function* () {
            // A missing engine fails to spawn and is caught below. This is the
            // other Windows case: a `.cmd`/`.bat` shim that does resolve, runs
            // through cmd.exe, and cannot find what it wraps — which exits
            // 9009 with a diagnostic instead of failing to start.
            const notFound = yield* ProcessRunner.isWindowsCommandNotFound(
              result.code,
              result.stderr,
            );
            if (result.timedOut || notFound || result.code !== 0) return null;
            const banner = `${result.stdout}\n${result.stderr}`;
            return {
              kind: candidate.kind,
              executable: candidate.executable,
              version: parseLatexToolchainVersion(candidate.kind, banner),
              probedAtEpochMs,
              source,
            } satisfies ScientLatexToolchainStatus;
          }),
        ),
        // A spawn error means the engine is not installed on this machine.
        Effect.orElseSucceed(() => null),
      );

  const probeCompilers = Effect.fnUntraced(function* (status: ScientLatexToolchainStatus) {
    const environment = latexEngineEnvironment({
      base: {},
      hostEnvironment,
      binDirectory:
        status.source === "scient-managed" && status.executable !== null
          ? path.dirname(status.executable)
          : null,
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
            timeout: PROBE_TIMEOUT,
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
    const systemStatus =
      (yield* probeCandidate(SYSTEM_LATEXMK, probedAtEpochMs)) ??
      (yield* probeCandidate(SYSTEM_TECTONIC, probedAtEpochMs)) ??
      absent(probedAtEpochMs);
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
