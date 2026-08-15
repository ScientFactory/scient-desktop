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
 * Which `tar` is not a detail on Windows: only the OS bsdtar reads the 7-Zip
 * stub, and a bare `tar` resolves through PATH, where Git for Windows and
 * MSYS2 both place a GNU tar that rejects the bundle outright. So on Windows
 * the unpacker is pinned to `%SystemRoot%\System32\tar.exe` and refuses if
 * that is absent, which also keeps PATH — the one thing on this path a user's
 * other software can rewrite — out of the install entirely.
 *
 * The extraction runs behind this port so the installer can be tested without
 * a real archive.
 */
import { HostProcessEnvironment, HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import * as ProcessRunner from "../../processRunner.ts";
import type { TinyTexArchiveKind } from "./tinytexManifest.ts";

export class LatexArchiveUnpackError extends Schema.TaggedErrorClass<LatexArchiveUnpackError>()(
  "LatexArchiveUnpackError",
  {
    reason: Schema.Literals(["unsupported-archive", "unpacker-unavailable", "unpack-failed"]),
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

/**
 * The bsdtar Windows ships with, by absolute path. `SystemRoot` is what names
 * the Windows directory on a machine that does not use `C:\Windows`; its
 * absence is not a case worth failing over, so the default stands in.
 */
export function windowsSystemTarPath(env: NodeJS.ProcessEnv): string {
  return `${env.SystemRoot ?? "C:\\Windows"}\\System32\\tar.exe`;
}

export const make = Effect.gen(function* () {
  const processRunner = yield* ProcessRunner.ProcessRunner;
  const fileSystem = yield* FileSystem.FileSystem;
  const platform = yield* HostProcessPlatform;
  const environment = yield* HostProcessEnvironment;
  // Everywhere but Windows the PATH `tar` is the right one: macOS ships
  // bsdtar as `tar`, and Linux only ever reads the `.tar.xz` asset.
  const command = platform === "win32" ? windowsSystemTarPath(environment) : "tar";

  const unpack: LatexArchiveUnpacker["Service"]["unpack"] = (input) =>
    Effect.gen(function* () {
      if (input.archive !== "seven-zip-sfx" && input.archive !== "tar-xz") {
        return yield* new LatexArchiveUnpackError({
          reason: "unsupported-archive",
          detail: `Scient cannot expand a ${String(input.archive)} bundle.`,
        });
      }
      if (platform === "win32") {
        const present = yield* fileSystem.exists(command).pipe(Effect.orElseSucceed(() => false));
        if (!present) {
          return yield* new LatexArchiveUnpackError({
            reason: "unpacker-unavailable",
            detail: `This computer has no ${command}, which Scient needs to expand the download.`,
          });
        }
      }
      const result = yield* processRunner
        .run({
          command,
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
          reason: "unpacker-unavailable",
          detail: `This computer has no ${command}, which Scient needs to expand the download.`,
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
