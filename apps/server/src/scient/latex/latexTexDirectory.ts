// @effect-diagnostics nodeBuiltinImport:off -- The private folder's name is a host random value.
/**
 * Where Scient keeps the files TeX itself reads and writes: the TinyTeX it
 * installs (`managed`), each build's work directory (`builds`) and drawing
 * previews (`artwork`). Normally that is `latexDir`, in the user's profile.
 *
 * TeX Live on Windows cannot work from a path with letters outside plain
 * ASCII: kpathsea cannot find its own `texmf.cnf` from such a folder (a single
 * "ü" is enough), and `latexmk`, a Perl script, converts every path it is given
 * to the system code page, which turns Hebrew or Cyrillic into "?". Windows'
 * 8.3 short names do not help: kpathsea expands them back to the long name.
 *
 * So on Windows, when `latexDir` is not plain ASCII, those three folders live
 * instead in a folder of this user's own directly under `%ProgramData%`, which
 * is ASCII on every Windows. What only Node and Scient's own helpers read —
 * build evidence, SyncTeX indexes, the record below — stays in `latexDir`.
 * `%ProgramData%` is shared, so no other account may ever reach the folder:
 *
 * - It is made and locked inside the profile `latexDir`, which only this user
 *   can open — inherited access removed, full control for this user, SYSTEM
 *   and Administrators only — and then moved into `%ProgramData%`. A move on
 *   one volume keeps the folder's own access list, so it arrives already
 *   private; no other account could have opened it in between. Where the
 *   profile is on another drive the move fails and nothing changes.
 * - `%ProgramData%` lets accounts delete only what they created, so nobody
 *   else can remove, rename or replace it afterwards.
 * - Its path and its NTFS identity (volume and file ID) are recorded in the
 *   profile `latexDir`. A later start uses it only while that same folder,
 *   not a link, is still there. A folder someone recreated under the same
 *   name after it was deleted has a different identity and is ignored.
 *
 * Everywhere else, and on any Windows whose path is already ASCII, nothing
 * changes. If the private folder cannot be made, or the answer takes longer
 * than server start should wait, `latexDir` stays in use: that is how it was
 * before, and TeX's own error still reaches the user.
 *
 * All of this assumes the state directory is private to the account, as it
 * must be anyway: whoever can write there can already replace the managed TeX.
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
    const folderIdentity = (directory: string) =>
      Effect.gen(function* () {
        if (Option.isSome(yield* fileSystem.readLink(directory).pipe(Effect.option))) return null;
        const info = yield* fileSystem.stat(directory);
        if (info.type !== "Directory" || Option.isNone(info.ino)) return null;
        return `${String(info.dev)}:${String(info.ino.value)}`;
      }).pipe(Effect.orElseSucceed(() => null));

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

    // The work runs on its own fiber and only its answer is waited for. Some
    // of what it calls cleans up in steps nothing can interrupt — stopping a
    // hung process, closing a file — and none of that may hold server start.
    // Whichever settles `decision` first wins. A folder recorded after the
    // wait ran out is the one the next start uses; until then nothing has
    // been put in it, so nothing is split between the two.
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
