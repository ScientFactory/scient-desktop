/**
 * Discovers this server's build driver and the standalone compiler binaries
 * it can run. Probes are bounded subprocesses; missing or broken executables
 * are normal on a fresh machine. Driver and compiler facts share a cached,
 * single-flight observation so status polling never launches a build.
 *
 * PATH wins. Someone who already runs TeX Live or MiKTeX keeps building with
 * it, exactly as before; the distribution Scient installs is only consulted
 * once PATH has turned up nothing, and says so through `source`.
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
    /** `refresh` forces a new probe; otherwise a result younger than the TTL is reused. */
    readonly probe: (refresh: boolean) => Effect.Effect<LatexToolchainProbe>;
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

// latexmk is tried first: it drives bibtex/biber and reruns to fixpoint, which
// tectonic only approximates. tectonic is the self-contained fallback.
const CANDIDATES: ReadonlyArray<ToolchainCandidate> = [
  { kind: "latexmk", executable: "latexmk", args: ["-v"] },
  { kind: "tectonic", executable: "tectonic", args: ["--version"] },
];

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
  const cacheRef = yield* Ref.make<LatexToolchainProbe | null>(null);
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
  const probeDriver = Effect.gen(function* () {
    const probedAtEpochMs = yield* Clock.currentTimeMillis;
    for (const candidate of CANDIDATES) {
      const found = yield* probeCandidate(candidate, probedAtEpochMs);
      if (found !== null) return found;
    }
    // Nothing on PATH. Scient may have installed a distribution of its own,
    // which is still probed rather than trusted: a tree that no longer runs is
    // the same as no engine at all.
    const managed = yield* findManagedInstall;
    if (managed !== null) {
      const found = yield* probeCandidate(
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
      if (found !== null) return found;
    }
    return absent(probedAtEpochMs);
  });

  const probeAll = Effect.gen(function* () {
    const status = yield* probeDriver;
    return { ...status, compilers: yield* probeCompilers(status) };
  });

  const isFresh = (cached: ScientLatexToolchainStatus | null) =>
    Effect.gen(function* () {
      if (cached === null) return false;
      const now = yield* Clock.currentTimeMillis;
      return now - cached.probedAtEpochMs < PROBE_CACHE_TTL_MS;
    });

  const probe = (refresh: boolean) =>
    Effect.gen(function* () {
      const cached = yield* Ref.get(cacheRef);
      if (!refresh && (yield* isFresh(cached)) && cached !== null) return cached;
      return yield* probeGate.withPermits(1)(
        Effect.gen(function* () {
          // Re-read behind the gate: whoever held it just refreshed the cache,
          // and the fibers that queued behind it want that answer, not a
          // second round of subprocesses.
          const settled = yield* Ref.get(cacheRef);
          if (!refresh && (yield* isFresh(settled)) && settled !== null) return settled;
          const status = yield* probeAll;
          yield* Ref.set(cacheRef, status);
          return status;
        }),
      );
    });

  return LatexToolchain.of({ probe });
});

export const layer = Layer.effect(LatexToolchain, make).pipe(Layer.provide(ProcessRunner.layer));
