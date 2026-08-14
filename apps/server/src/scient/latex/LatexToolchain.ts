/**
 * Discovers which TeX engine this machine can run. Probing is a short bounded
 * subprocess per candidate, so it uses `ProcessRunner` rather than the
 * streaming execution port. A candidate that cannot be spawned is simply
 * absent — a missing engine is the normal state on a fresh machine, never a
 * defect — and the answer is cached so every build and every status poll does
 * not re-shell out.
 */
import type { ScientLatexToolchainKind, ScientLatexToolchainStatus } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Semaphore from "effect/Semaphore";

import * as ProcessRunner from "../../processRunner.ts";

export class LatexToolchain extends Context.Service<
  LatexToolchain,
  {
    /** `refresh` forces a new probe; otherwise a result younger than the TTL is reused. */
    readonly probe: (refresh: boolean) => Effect.Effect<ScientLatexToolchainStatus>;
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
  const cacheRef = yield* Ref.make<ScientLatexToolchainStatus | null>(null);
  // Every build and every status poll asks for the toolchain, so a lapsed TTL
  // would otherwise let a burst of pollers each shell out. One probe runs; the
  // rest queue here and read the answer it leaves in the cache.
  const probeGate = yield* Semaphore.make(1);

  const probeCandidate = (candidate: ToolchainCandidate, probedAtEpochMs: number) =>
    processRunner
      .run({
        command: candidate.executable,
        args: candidate.args,
        timeout: PROBE_TIMEOUT,
        maxOutputBytes: PROBE_MAX_OUTPUT_BYTES,
        outputMode: "truncate",
        timeoutBehavior: "timedOutResult",
      })
      .pipe(
        Effect.flatMap((result) =>
          Effect.gen(function* () {
            // Windows resolves `latexmk` through a shell, so a missing engine
            // surfaces as a shell diagnostic rather than a spawn failure.
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
            } satisfies ScientLatexToolchainStatus;
          }),
        ),
        // A spawn error means the engine is not installed on this machine.
        Effect.orElseSucceed(() => null),
      );

  const probeAll = Effect.gen(function* () {
    const probedAtEpochMs = yield* Clock.currentTimeMillis;
    for (const candidate of CANDIDATES) {
      const found = yield* probeCandidate(candidate, probedAtEpochMs);
      if (found !== null) return found;
    }
    return absent(probedAtEpochMs);
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
