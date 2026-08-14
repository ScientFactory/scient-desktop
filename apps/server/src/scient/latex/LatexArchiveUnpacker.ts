/**
 * Expands a downloaded TinyTeX bundle into a directory.
 *
 * A LaTeX distribution is ten thousand small files in a format Node cannot
 * read on its own, and adding an archive dependency for one feature is a poor
 * trade. `tar` is already on every platform Scient supports — bsdtar/libarchive
 * on Windows 10+ and macOS, GNU tar on Linux — and libarchive reads upstream's
 * Windows bundle (a 7-Zip archive behind an executable stub) as an archive, so
 * Scient extracts the payload instead of running the downloaded installer.
 *
 * The extraction runs behind this port so the installer can be tested without
 * a real archive.
 */
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import * as ProcessRunner from "../../processRunner.ts";
import type { TinyTexArchiveKind } from "./tinytexManifest.ts";

export class LatexArchiveUnpackError extends Schema.TaggedErrorClass<LatexArchiveUnpackError>()(
  "LatexArchiveUnpackError",
  {
    reason: Schema.Literals(["unsupported-archive", "unpack-failed"]),
    detail: Schema.String,
  },
) {
  override get message(): string {
    return this.detail;
  }
}

export interface LatexArchiveUnpackInput {
  readonly archivePath: string;
  /** Must already exist; the archive's own top-level entries land inside it. */
  readonly destination: string;
  readonly archive: TinyTexArchiveKind;
}

export class LatexArchiveUnpacker extends Context.Service<
  LatexArchiveUnpacker,
  {
    readonly unpack: (
      input: LatexArchiveUnpackInput,
    ) => Effect.Effect<void, LatexArchiveUnpackError>;
  }
>()("t3/scient/latex/LatexArchiveUnpacker") {}

/** Ten thousand files land in seconds on a warm disk; this is the wedged case. */
const UNPACK_TIMEOUT = "10 minutes";
const UNPACK_MAX_OUTPUT_BYTES = 64 * 1024;

/**
 * `tar` sniffs the container, so both pinned formats take the same flags.
 * Extraction is refused for anything the manifest has not declared.
 */
export function tinyTexUnpackArguments(input: LatexArchiveUnpackInput): ReadonlyArray<string> {
  return ["-x", "-f", input.archivePath, "-C", input.destination];
}

export const make = Effect.gen(function* () {
  const processRunner = yield* ProcessRunner.ProcessRunner;

  const unpack: LatexArchiveUnpacker["Service"]["unpack"] = (input) =>
    Effect.gen(function* () {
      if (input.archive !== "seven-zip-sfx" && input.archive !== "tar-xz") {
        return yield* new LatexArchiveUnpackError({
          reason: "unsupported-archive",
          detail: `Scient cannot expand a ${String(input.archive)} bundle.`,
        });
      }
      const result = yield* processRunner
        .run({
          command: "tar",
          args: tinyTexUnpackArguments(input),
          timeout: UNPACK_TIMEOUT,
          maxOutputBytes: UNPACK_MAX_OUTPUT_BYTES,
          outputMode: "truncate",
          timeoutBehavior: "timedOutResult",
        })
        .pipe(
          Effect.mapError(
            (cause) =>
              new LatexArchiveUnpackError({
                reason: "unpack-failed",
                detail: `Scient could not run tar to expand the LaTeX distribution: ${cause.message}`,
              }),
          ),
        );
      if (result.timedOut) {
        return yield* new LatexArchiveUnpackError({
          reason: "unpack-failed",
          detail: "Expanding the LaTeX distribution took too long and was stopped.",
        });
      }
      const missingTar = yield* ProcessRunner.isWindowsCommandNotFound(result.code, result.stderr);
      if (missingTar) {
        return yield* new LatexArchiveUnpackError({
          reason: "unpack-failed",
          detail: "This computer has no tar command, which Scient needs to expand the download.",
        });
      }
      if (result.code !== 0) {
        return yield* new LatexArchiveUnpackError({
          reason: "unpack-failed",
          detail: `Expanding the LaTeX distribution failed: ${
            result.stderr.trim() || result.stdout.trim() || `tar exited with ${String(result.code)}`
          }`,
        });
      }
    });

  return LatexArchiveUnpacker.of({ unpack });
});

export const layer = Layer.effect(LatexArchiveUnpacker, make).pipe(
  Layer.provide(ProcessRunner.layer),
);
