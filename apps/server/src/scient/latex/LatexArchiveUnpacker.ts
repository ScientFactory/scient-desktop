/**
 * Windows system bsdtar, not PATH GNU tar, can read the SFX archive; Windows 10 may still lack
 * LZMA. After failed extraction, clear partial output and run only the digest-verified
 * self-extractor. Prefer system tar where it works; this trusts the same pinned release as latexmk.
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

const MAX_TAR_DETAIL_LENGTH = 120;

const boundedDetail = (detail: string): string => {
  const line = detail.replace(/\s+/gu, " ").trim();
  return line.length > MAX_TAR_DETAIL_LENGTH
    ? `${line.slice(0, MAX_TAR_DETAIL_LENGTH - 1)}…`
    : line;
};

/**
 * What a failed 7-Zip extraction said, led by its exit code (2 fatal, 7 bad
 * command line, 8 out of memory). 7-Zip reports errors on stderr and keeps
 * its banner and progress on stdout, so stderr's last line is preferred.
 */
export function selfExtractorComplaint(result: {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
}): string {
  const lastLine = (text: string) =>
    text
      .split(/\r?\n/u)
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .at(-1);
  const said = lastLine(result.stderr) ?? lastLine(result.stdout);
  return `exit ${String(result.code)}${said === undefined ? "" : `, ${said}`}`;
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

  const runTar = Effect.fn("LatexArchiveUnpacker.runTar")(function* (
    input: LatexArchiveUnpackInput,
  ) {
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
  const runSelfExtractor = Effect.fn("LatexArchiveUnpacker.runSelfExtractor")(function* (
    input: LatexArchiveUnpackInput,
    tarFailure: LatexArchiveUnpackError,
  ) {
    // The extractor's failure is the final one, so it leads; tar's, which
    // may repeat per entry, follows in brief and stays complete in the log.
    const failed = (detail: string) =>
      new LatexArchiveUnpackError({
        reason: "unpack-failed",
        detail: `The download's own extractor failed: ${/[.!?:]$/u.test(detail) ? detail : `${detail}.`} Before that, ${boundedDetail(tarFailure.detail)}`,
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
      yield* Effect.logWarning("scient latex bundle could not unpack itself", {
        code: result.code,
        stderr: result.stderr,
        stdout: result.stdout,
        tarFailure: tarFailure.detail,
      });
      return yield* failed(selfExtractorComplaint(result));
    }
    yield* Effect.logInfo("scient latex bundle unpacked itself after the system tar failed", {
      tarFailure: tarFailure.detail,
    });
  });

  const unpack: LatexArchiveUnpacker["Service"]["unpack"] = Effect.fn(
    "LatexArchiveUnpacker.unpack",
  )(function* (input) {
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
