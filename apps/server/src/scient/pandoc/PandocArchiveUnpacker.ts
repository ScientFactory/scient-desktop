/**
 * Use absolute system bsdtar for macOS/Windows ZIPs; GNU tar earlier on PATH cannot read them.
 * Linux's archive is tar.gz. Digest verification must precede extraction.
 */
import * as HostProcess from "@t3tools/shared/HostProcess";
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
  const platform = yield* HostProcess.Platform;
  const environment = yield* HostProcess.Environment;
  const command = pandocTarCommand(platform, environment);
  const pinned = command !== "tar";
  const unavailable = () =>
    new PandocArchiveUnpackError({
      reason: "unpacker-unavailable",
      detail: `This computer has no ${command}, which Scient needs to expand the Pandoc download.`,
    });

  const unpack: PandocArchiveUnpacker["Service"]["unpack"] = Effect.fn(
    "PandocArchiveUnpacker.unpack",
  )(function* (input) {
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
