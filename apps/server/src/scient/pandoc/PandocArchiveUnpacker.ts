/**
 * Expands a downloaded Pandoc archive into a directory with the system `tar`.
 *
 * The macOS and Windows releases are zip files and the Linux release is a
 * gzipped tarball. bsdtar (macOS `/usr/bin/tar`, and
 * `%SystemRoot%\System32\tar.exe` on Windows 10+) reads zip files, and GNU tar
 * reads the Linux tarball, so no archive dependency is needed. Where the
 * archive is a zip the unpacker is pinned to the system bsdtar by absolute
 * path, as the LaTeX installer is on Windows, because a GNU tar earlier on PATH
 * (Homebrew's on macOS, Git for Windows' or MSYS2's on Windows) cannot read zip
 * files.
 *
 * The archive has already passed its pinned digest check when this runs.
 */
import { HostProcessEnvironment, HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import * as ProcessRunner from "../../processRunner.ts";
import { windowsSystemTarPath } from "../latex/LatexArchiveUnpacker.ts";
import type { PandocArchiveKind } from "./pandocManifest.ts";

export class PandocArchiveUnpackError extends Schema.TaggedError<PandocArchiveUnpackError>()(
  "PandocArchiveUnpackError",
  {
    reason: Schema.Literals(["unpacker-unavailable", "unpack-failed"]),
    detail: Schema.String,
  },
) {
  override get message(): string {
    return this.detail;
  }
}

export interface PandocArchiveUnpackInput {
  readonly archivePath: string;
  /** Must already exist; the archive's top-level directory lands inside it. */
  readonly destination: string;
  readonly archive: PandocArchiveKind;
}

export class PandocArchiveUnpacker extends Context.Service<
  PandocArchiveUnpacker,
  {
    readonly unpack: (
      input: PandocArchiveUnpackInput,
    ) => Effect.Effect<void, PandocArchiveUnpackError>;
  }
>()("t3/scient/pandoc/PandocArchiveUnpacker") {}

const UNPACK_TIMEOUT = "5 minutes";
const UNPACK_MAX_OUTPUT_BYTES = 64 * 1024;

function pandocUnpackArguments(input: PandocArchiveUnpackInput): ReadonlyArray<string> {
  return ["-x", "-f", input.archivePath, "-C", input.destination];
}

/** The `tar` that reads this platform's Pandoc release; see the module comment. */
export function pandocTarCommand(
  platform: NodeJS.Platform,
  environment: NodeJS.ProcessEnv,
): string {
  if (platform === "win32") return windowsSystemTarPath(environment);
  if (platform === "darwin") return "/usr/bin/tar";
  return "tar";
}

export const make = Effect.gen(function* () {
  const processRunner = yield* ProcessRunner.ProcessRunner;
  const fileSystem = yield* FileSystem.FileSystem;
  const platform = yield* HostProcessPlatform;
  const environment = yield* HostProcessEnvironment;
  const command = pandocTarCommand(platform, environment);
  const pinned = command !== "tar";
  const unavailable = () =>
    new PandocArchiveUnpackError({
      reason: "unpacker-unavailable",
      detail: `This computer has no ${command}, which Scient needs to expand the Pandoc download.`,
    });

  const unpack: PandocArchiveUnpacker["Service"]["unpack"] = (input) =>
    Effect.gen(function* () {
      if (pinned) {
        const present = yield* fileSystem.exists(command).pipe(Effect.orElseSucceed(() => false));
        if (!present) return yield* unavailable();
      }
      const result = yield* processRunner
        .run({
          command,
          args: pandocUnpackArguments(input),
          timeout: UNPACK_TIMEOUT,
          maxOutputBytes: UNPACK_MAX_OUTPUT_BYTES,
          outputMode: "truncate",
          timeoutBehavior: "timedOutResult",
        })
        .pipe(
          Effect.mapError(
            (cause) =>
              new PandocArchiveUnpackError({
                reason: "unpack-failed",
                detail: `Scient could not run tar to expand the Pandoc download: ${cause.message}`,
              }),
          ),
        );
      if (result.timedOut) {
        return yield* new PandocArchiveUnpackError({
          reason: "unpack-failed",
          detail: "Expanding the Pandoc download took too long and was stopped.",
        });
      }
      if (yield* ProcessRunner.isWindowsCommandNotFound(result.code, result.stderr)) {
        return yield* unavailable();
      }
      if (result.code !== 0) {
        return yield* new PandocArchiveUnpackError({
          reason: "unpack-failed",
          detail: `Expanding the Pandoc download failed: ${
            result.stderr.trim() || result.stdout.trim() || `tar exited with ${String(result.code)}`
          }`,
        });
      }
    });

  return PandocArchiveUnpacker.of({ unpack });
});

export const layer = Layer.effect(PandocArchiveUnpacker, make).pipe(
  Layer.provide(ProcessRunner.layer),
);
