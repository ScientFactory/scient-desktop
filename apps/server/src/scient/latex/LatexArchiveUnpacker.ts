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
 * Not every Windows bsdtar can decode it, though. The 7-Zip payload is LZMA,
 * and Windows 10's bsdtar is built without liblzma, so it opens the archive
 * and then fails on every entry. The bundle carries its own decoder: the stub
 * is 7-Zip's console self-extractor, which unpacks itself with `x -y -o<dir>`
 * and shows no window. When the system tar cannot expand the bundle, the
 * half-written destination is cleared and the bundle unpacks itself. Its
 * digest has been checked against the pin before this port is ever called,
 * and it is the same reviewed release whose `latexmk.exe` the install runs
 * next, so running it trusts nothing more than the install already does.
 * The system tar stays first so that every computer where it works today
 * keeps exactly the path it has.
 *
 * The extraction runs behind this port so the installer can be tested without
 * a real archive.
 */
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import * as ProcessRunner from "../../processRunner.ts";
import type { TinyTexArchiveKind } from "./tinytexManifest.ts";

export class LatexArchiveUnpackError extends Schema.TaggedError<LatexArchiveUnpackError>()(
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

/** How the 7-Zip console self-extractor is told to unpack into `destination` without asking. */
export function sevenZipSelfExtractArguments(
  input: LatexArchiveUnpackInput,
): ReadonlyArray<string> {
  return ["x", "-y", `-o${input.destination}`];
}

export const make = Effect.gen(function* () {
  const processRunner = yield* ProcessRunner.ProcessRunner;
  const fileSystem = yield* FileSystem.FileSystem;
  const platform = yield* HostProcess.Platform;
  const environment = yield* HostProcess.Environment;
  // Everywhere but Windows the PATH `tar` is the right one: macOS ships
  // bsdtar as `tar`, and Linux only ever reads the `.tar.xz` asset.
  const command = platform === "win32" ? windowsSystemTarPath(environment) : "tar";

  const runTar = (input: LatexArchiveUnpackInput) =>
    Effect.gen(function* () {
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

  /** The Windows bundle unpacking itself, into a destination cleared of tar's partial output. */
  const runSelfExtractor = (input: LatexArchiveUnpackInput, tarFailure: LatexArchiveUnpackError) =>
    Effect.gen(function* () {
      const failed = (detail: string) =>
        new LatexArchiveUnpackError({
          reason: "unpack-failed",
          detail: `${tarFailure.detail} The download's own extractor also failed: ${detail}`,
        });
      yield* fileSystem.remove(input.destination, { recursive: true, force: true }).pipe(
        Effect.andThen(fileSystem.makeDirectory(input.destination, { recursive: true })),
        Effect.mapError((cause) =>
          failed(`Scient could not clear ${input.destination}: ${cause.message}`),
        ),
      );
      const result = yield* processRunner
        .run({
          command: input.archivePath,
          args: sevenZipSelfExtractArguments(input),
          timeout: UNPACK_TIMEOUT,
          maxOutputBytes: UNPACK_MAX_OUTPUT_BYTES,
          outputMode: "truncate",
          timeoutBehavior: "timedOutResult",
        })
        .pipe(Effect.mapError((cause) => failed(cause.message)));
      if (result.timedOut) return yield* failed("it took too long and was stopped.");
      if (result.code !== 0) {
        // 7-Zip prints its banner first; the reason is at the end.
        const lines = `${result.stderr}\n${result.stdout}`
          .split(/\r?\n/u)
          .map((line) => line.trim())
          .filter((line) => line.length > 0);
        return yield* failed(lines.at(-1) ?? `it exited with ${String(result.code)}`);
      }
      yield* Effect.logInfo("scient latex bundle unpacked itself after the system tar failed", {
        tarFailure: tarFailure.detail,
      });
    });

  const unpack: LatexArchiveUnpacker["Service"]["unpack"] = (input) =>
    Effect.gen(function* () {
      if (input.archive !== "seven-zip-sfx" && input.archive !== "tar-xz") {
        return yield* new LatexArchiveUnpackError({
          reason: "unsupported-archive",
          detail: `Scient cannot expand a ${String(input.archive)} bundle.`,
        });
      }
      if (platform !== "win32" || input.archive !== "seven-zip-sfx") return yield* runTar(input);
      return yield* runTar(input).pipe(
        Effect.catch((tarFailure) => runSelfExtractor(input, tarFailure)),
      );
    });

  return LatexArchiveUnpacker.of({ unpack });
});

export const layer = Layer.effect(LatexArchiveUnpacker, make).pipe(
  Layer.provide(ProcessRunner.layer),
);
