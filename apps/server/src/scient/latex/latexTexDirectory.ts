// @effect-diagnostics nodeBuiltinImport:off -- The private folder's name is a host random value.
/**
 * Windows TeX cannot handle non-ASCII profile paths, even via short names. Move a pre-locked
 * private folder on the same volume into ProgramData and persist its NTFS identity; never adopt a
 * replacement/link. Keep Node-only state in profile, and fall back there if bounded setup fails.
 */
import * as NodeCrypto from "node:crypto";

import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import * as ServerConfig from "../../config.ts";
import * as ProcessRunner from "../../processRunner.ts";

/**
 * The folder TeX's own files live in when it is not `latexDir`. `null`, the
 * default, means `latexDir`; read it through {@link latexTexDirectory}.
 */
export const LatexTexDirectory = Context.Reference<string | null>(
  "t3/scient/latex/LatexTexDirectory",
  { defaultValue: () => null },
);

/** The folder for TeX's own files: the distribution, build work, previews. */
export const latexTexDirectory = Effect.gen(function* () {
  return (yield* LatexTexDirectory) ?? (yield* ServerConfig.ServerConfig).latexDir;
});

/** Written into `latexDir`; names the folder in use and how to recognise it. */
export const LATEX_TEX_LOCATION_FILE = "tex-location.json";

const PRIVATE_FOLDER_PATTERN = /^scient-latex-[0-9a-f]{16}$/u;
const TOOL_TIMEOUT = "10 seconds";
const TOOL_MAX_OUTPUT_BYTES = 64 * 1024;
/** Server start waits this long for the answer; past it, `latexDir` is used. */
const DECISION_TIMEOUT = "30 seconds";

const LatexTexLocationRecord = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  directory: Schema.String,
  /** `dev:ino` of the folder as made; a different folder at the path differs. */
  identity: Schema.String,
});
const LatexTexLocationJson = Schema.fromJsonString(LatexTexLocationRecord);
const decodeLocation = Schema.decodeUnknownEffect(LatexTexLocationJson);
const encodeLocation = Schema.encodeEffect(LatexTexLocationJson);

class LatexTexDirectoryError extends Schema.TaggedError<LatexTexDirectoryError>()(
  "LatexTexDirectoryError",
  { detail: Schema.String },
) {
  override get message(): string {
    return this.detail;
  }
}

/** Printable ASCII, the only kind of path TeX Live on Windows reliably reads. */
export function isTexSafePath(value: string): boolean {
  return !/[^ -~]/u.test(value);
}

/**
 * A recorded location is used only if it is a folder this module could have
 * made: an ASCII path, directly under `%ProgramData%`, with its name pattern.
 */
export function isPrivateTexFolder(input: {
  readonly directory: string;
  readonly programData: string;
  readonly path: Pick<Path.Path, "basename" | "dirname" | "resolve">;
}): boolean {
  return (
    isTexSafePath(input.directory) &&
    PRIVATE_FOLDER_PATTERN.test(input.path.basename(input.directory)) &&
    input.path.resolve(input.path.dirname(input.directory)).toLowerCase() ===
      input.path.resolve(input.programData).toLowerCase()
  );
}

/** The SID in `whoami /user /fo csv /nh` output: `"host\name","S-1-5-21-…"`. */
export function windowsUserSid(output: string): string | null {
  return /"(S-1-[0-9-]+)"\s*$/u.exec(output.trim())?.[1] ?? null;
}

/**
 * Inherited access removed; full control, for this folder and everything that
 * will be created in it, for this user, SYSTEM and Administrators only.
 */
export function privateFolderLockArguments(folder: string, sid: string): ReadonlyArray<string> {
  return [
    folder,
    "/inheritance:r",
    "/grant:r",
    `*${sid}:(OI)(CI)F`,
    "*S-1-5-18:(OI)(CI)F",
    "*S-1-5-32-544:(OI)(CI)F",
  ];
}

/** Windows keeps environment names case-insensitive; a copied record does not. */
function environmentValue(environment: NodeJS.ProcessEnv, name: string): string | undefined {
  const key = Object.keys(environment).find((entry) => entry.toUpperCase() === name.toUpperCase());
  const value = key === undefined ? undefined : environment[key];
  return value === "" ? undefined : value;
}

/** The folder TeX's own files should live in on this computer. */
export const resolveLatexTexDirectory = Effect.fn("scient.latex.resolveLatexTexDirectory")(
  function* (latexDir: string) {
    const platform = yield* HostProcess.Platform;
    if (platform !== "win32" || isTexSafePath(latexDir)) return latexDir;

    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const environment = yield* HostProcess.Environment;
    const processRunner = yield* ProcessRunner.ProcessRunner;
    const locationPath = path.join(latexDir, LATEX_TEX_LOCATION_FILE);
    const system32 = `${environmentValue(environment, "SystemRoot") ?? "C:\\Windows"}\\System32`;
    const stayInProfile = (reason: string) =>
      Effect.logWarning("scient latex keeps TeX's files in the profile folder", {
        latexDir,
        reason,
      }).pipe(Effect.as(latexDir));

    const programData =
      environmentValue(environment, "ProgramData") ??
      environmentValue(environment, "ALLUSERSPROFILE");
    if (programData === undefined || !path.isAbsolute(programData) || !isTexSafePath(programData)) {
      return yield* stayInProfile("This computer has no plain-ASCII ProgramData folder.");
    }

    const runTool = (command: string, args: ReadonlyArray<string>) =>
      processRunner
        .run({
          command,
          args,
          timeout: TOOL_TIMEOUT,
          maxOutputBytes: TOOL_MAX_OUTPUT_BYTES,
          outputMode: "truncate",
          timeoutBehavior: "timedOutResult",
        })
        .pipe(
          Effect.filterOrFail(
            (result) => !result.timedOut && result.code === 0,
            (result) =>
              new LatexTexDirectoryError({
                detail: `${command} failed: ${
                  result.timedOut
                    ? "it did not finish in time"
                    : result.stderr.trim() || result.stdout.trim() || `exit ${result.code}`
                }`,
              }),
          ),
        );

    /**
     * `dev:ino` of a real folder at `directory`, or `null` for anything else.
     * A link answers `readLink`; a folder does not.
     */
    const folderIdentity = Effect.fn("latexTexDirectory.folderIdentity")(
      function* (directory: string) {
        if (Option.isSome(yield* fileSystem.readLink(directory).pipe(Effect.option))) return null;
        const info = yield* fileSystem.stat(directory);
        if (info.type !== "Directory" || Option.isNone(info.ino)) return null;
        return `${String(info.dev)}:${String(info.ino.value)}`;
      },
      (effect) => effect.pipe(Effect.orElseSucceed(() => null)),
    );

    /** The folder the record names, if it is still the very folder made. */
    const recordedFolder = Effect.gen(function* () {
      const recorded = yield* fileSystem.readFileString(locationPath).pipe(
        Effect.flatMap(decodeLocation),
        Effect.orElseSucceed(() => null),
      );
      return recorded !== null &&
        isPrivateTexFolder({ directory: recorded.directory, programData, path }) &&
        (yield* folderIdentity(recorded.directory)) === recorded.identity
        ? recorded.directory
        : null;
    });

    const makePrivateFolder = Effect.gen(function* () {
      const name = `scient-latex-${NodeCrypto.randomBytes(8).toString("hex")}`;
      const staging = path.join(latexDir, `.${name}`);
      const directory = path.join(programData, name);
      // What an interrupted earlier attempt left in the profile.
      for (const entry of yield* fileSystem.readDirectory(latexDir)) {
        if (!entry.startsWith(".scient-latex-")) continue;
        yield* fileSystem
          .remove(path.join(latexDir, entry), { recursive: true, force: true })
          .pipe(Effect.ignoreCause());
      }
      // Not recursive: an existing folder is refused rather than adopted.
      yield* fileSystem.makeDirectory(staging);
      let moved = false;
      return yield* Effect.gen(function* () {
        const whoami = yield* runTool(`${system32}\\whoami.exe`, ["/user", "/fo", "csv", "/nh"]);
        const sid = windowsUserSid(whoami.stdout);
        if (sid === null) {
          return yield* new LatexTexDirectoryError({
            detail: "whoami did not name this account's SID.",
          });
        }
        yield* runTool(`${system32}\\icacls.exe`, privateFolderLockArguments(staging, sid));
        yield* fileSystem.rename(staging, directory);
        moved = true;
        const identity = yield* folderIdentity(directory);
        if (identity === null) {
          return yield* new LatexTexDirectoryError({
            detail: "The moved folder could not be identified.",
          });
        }
        // Written beside the record and renamed over it, so it appears whole.
        // The temporary name is one the sweep above clears.
        const contents = yield* encodeLocation({ schemaVersion: 1, directory, identity });
        const pending = path.join(latexDir, `.${name}.json`);
        yield* fileSystem.writeFileString(pending, contents);
        yield* fileSystem.rename(pending, locationPath);
        yield* Effect.logInfo("scient latex keeps TeX's files in a private ASCII folder", {
          directory,
        });
        return directory;
      }).pipe(
        Effect.tapError(() =>
          fileSystem
            .remove(moved ? directory : staging, { recursive: true, force: true })
            .pipe(Effect.ignoreCause()),
        ),
      );
    });

    // Do not let uninterruptible cleanup delay server startup. The first decision wins; a folder
    // recorded after the wait deadline is used only next start, keeping this run's files in one
    // location.
    const decision = yield* Deferred.make<string>();
    yield* Effect.gen(function* () {
      const directory = (yield* recordedFolder) ?? (yield* makePrivateFolder);
      yield* Deferred.succeed(decision, directory);
    }).pipe(
      Effect.catch((cause) =>
        stayInProfile(cause.message).pipe(Effect.flatMap((dir) => Deferred.succeed(decision, dir))),
      ),
      Effect.forkDetach,
    );

    yield* Deferred.await(decision).pipe(Effect.timeoutOption(DECISION_TIMEOUT));
    if (yield* Deferred.succeed(decision, latexDir)) {
      return yield* stayInProfile("Finding the folder took too long.");
    }
    return yield* Deferred.await(decision);
  },
);

/**
 * Provides {@link LatexTexDirectory} to the LaTeX services; everything else
 * reads the default, `latexDir` itself.
 */
export const make = Effect.gen(function* () {
  const { latexDir } = yield* ServerConfig.ServerConfig;
  const directory = yield* resolveLatexTexDirectory(latexDir);
  return directory === latexDir ? null : directory;
});

export const layer = Layer.effect(LatexTexDirectory, make).pipe(Layer.provide(ProcessRunner.layer));
