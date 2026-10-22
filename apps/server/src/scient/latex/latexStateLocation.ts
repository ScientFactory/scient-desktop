// @effect-diagnostics nodeBuiltinImport:off -- The private folder's name is a host random value.
/**
 * Where Scient keeps the files TeX itself reads and writes.
 *
 * Everything a TeX run touches that Scient owns lives under `latexDir`: the
 * TinyTeX it installs (`managed`), each build's work directory (`builds`),
 * drawing previews (`artwork`) and the SyncTeX indexes it keeps (`synctex`).
 * On Windows `latexDir` sits in the user's profile, and TeX Live cannot work
 * from a path with letters outside plain ASCII: kpathsea cannot find its own
 * `texmf.cnf` from such a folder (a single "ü" is enough), and `latexmk`, a
 * Perl script, converts every path it is given to the system code page, which
 * turns Hebrew or Cyrillic into "?". Windows' 8.3 short names do not help:
 * kpathsea expands them back to the long name before using it.
 *
 * So on Windows, when `latexDir` is not plain ASCII, the LaTeX services get a
 * different one: a folder of this user's own directly under `%ProgramData%`,
 * which is ASCII on every Windows. That is a shared location, so no other
 * account may ever reach the folder:
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
 * changes. If the private folder cannot be made, the original stays in use:
 * that is how it was before, and TeX's own error still reaches the user.
 */
import * as NodeCrypto from "node:crypto";

import * as HostProcess from "@t3tools/shared/HostProcess";
import { writeFileStringAtomically } from "@t3tools/shared/atomicWrite";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import * as ServerConfig from "../../config.ts";
import * as ProcessRunner from "../../processRunner.ts";

/** Written into the original `latexDir`; names the folder actually in use. */
export const LATEX_STATE_LOCATION_FILE = "tex-location.json";

const PRIVATE_FOLDER_PATTERN = /^scient-latex-[0-9a-f]{16}$/u;
const TOOL_TIMEOUT = "10 seconds";
const TOOL_MAX_OUTPUT_BYTES = 64 * 1024;
/** Server start waits this long for the folder; past it, the profile one is used. */
const FOLDER_TIMEOUT = "30 seconds";
/** And this long for moving earlier state; whatever is left moves next start. */
const CARRY_OVER_TIMEOUT = "30 seconds";
/**
 * What earlier builds left that is worth keeping: build evidence and the
 * SyncTeX indexes of published PDFs. Everything else there is rebuilt.
 */
const CARRIED_OVER = ["evidence", "synctex"] as const;

const LatexStateLocationRecord = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  directory: Schema.String,
  /** `dev:ino` of the folder as made; a different folder at the path differs. */
  identity: Schema.String,
});
const LatexStateLocationJson = Schema.fromJsonString(LatexStateLocationRecord);
const decodeLocation = Schema.decodeUnknownEffect(LatexStateLocationJson);
const encodeLocation = Schema.encodeEffect(LatexStateLocationJson);

class LatexStateLocationError extends Schema.TaggedError<LatexStateLocationError>()(
  "LatexStateLocationError",
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
export function isPrivateLatexStateFolder(input: {
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

/** The `latexDir` the LaTeX services should use on this computer. */
export const resolveLatexStateDirectory = Effect.fn("scient.latex.resolveLatexStateDirectory")(
  function* (latexDir: string) {
    const platform = yield* HostProcess.Platform;
    if (platform !== "win32" || isTexSafePath(latexDir)) return latexDir;

    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const environment = yield* HostProcess.Environment;
    const processRunner = yield* ProcessRunner.ProcessRunner;
    const locationPath = path.join(latexDir, LATEX_STATE_LOCATION_FILE);
    const system32 = `${environmentValue(environment, "SystemRoot") ?? "C:\\Windows"}\\System32`;

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
              new LatexStateLocationError({
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

    const makePrivateFolder = (programData: string) =>
      Effect.gen(function* () {
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
            return yield* new LatexStateLocationError({
              detail: "whoami did not name this account's SID.",
            });
          }
          yield* runTool(`${system32}\\icacls.exe`, privateFolderLockArguments(staging, sid));
          yield* fileSystem.rename(staging, directory);
          moved = true;
          const identity = yield* folderIdentity(directory);
          if (identity === null) {
            return yield* new LatexStateLocationError({
              detail: "The moved folder could not be identified.",
            });
          }
          const contents = yield* encodeLocation({ schemaVersion: 1, directory, identity });
          yield* writeFileStringAtomically({ filePath: locationPath, contents });
          yield* Effect.logInfo("scient latex state moved to a private ASCII folder", {
            directory,
          });
          return directory;
        }).pipe(
          // On failure only, and interruptible: a removal that hangs must not
          // hold server start past its timeout. A folder an interrupted
          // attempt moved into ProgramData stays, empty and private.
          Effect.tapError(() =>
            fileSystem
              .remove(moved ? directory : staging, { recursive: true, force: true })
              .pipe(Effect.ignoreCause()),
          ),
        );
      });

    /**
     * Moves what is worth keeping, one entry at a time, never over an entry
     * already there. Best effort and repeatable: whatever fails moves on a
     * later start, and nothing here can fail one.
     */
    const carryOver = (directory: string) =>
      Effect.forEach(
        CARRIED_OVER,
        (folder) =>
          Effect.gen(function* () {
            const from = path.join(latexDir, folder);
            if (!(yield* fileSystem.exists(from))) return;
            const to = path.join(directory, folder);
            yield* fileSystem.makeDirectory(to, { recursive: true });
            for (const entry of yield* fileSystem.readDirectory(from)) {
              const target = path.join(to, entry);
              if (yield* fileSystem.exists(target)) continue;
              yield* fileSystem.rename(path.join(from, entry), target).pipe(Effect.ignoreCause());
            }
            if ((yield* fileSystem.readDirectory(from)).length === 0) {
              yield* fileSystem.remove(from, { recursive: true });
            }
          }).pipe(Effect.ignoreCause()),
        { discard: true },
      );

    const findOrMakeFolder = Effect.gen(function* () {
      const programData =
        environmentValue(environment, "ProgramData") ??
        environmentValue(environment, "ALLUSERSPROFILE");
      if (
        programData === undefined ||
        !path.isAbsolute(programData) ||
        !isTexSafePath(programData)
      ) {
        return yield* new LatexStateLocationError({
          detail: "This computer has no plain-ASCII ProgramData folder.",
        });
      }
      const recorded = yield* fileSystem.readFileString(locationPath).pipe(
        Effect.flatMap(decodeLocation),
        Effect.orElseSucceed(() => null),
      );
      const reusable =
        recorded !== null &&
        isPrivateLatexStateFolder({ directory: recorded.directory, programData, path }) &&
        (yield* folderIdentity(recorded.directory)) === recorded.identity;
      return reusable ? recorded.directory : yield* makePrivateFolder(programData);
    }).pipe(
      Effect.timeoutOrElse({
        duration: FOLDER_TIMEOUT,
        orElse: () =>
          Effect.fail(new LatexStateLocationError({ detail: "Finding the folder took too long." })),
      }),
    );

    return yield* Effect.gen(function* () {
      const directory = yield* findOrMakeFolder;
      // Once the folder is recorded it is the one in use, however the move of
      // earlier state goes: falling back now would split new state between two.
      yield* carryOver(directory).pipe(Effect.timeoutOption(CARRY_OVER_TIMEOUT));
      return directory;
    }).pipe(
      Effect.catch((cause) =>
        Effect.logWarning("scient latex state stays in the profile folder", {
          latexDir,
          reason: cause.message,
        }).pipe(Effect.as(latexDir)),
      ),
    );
  },
);

/**
 * `ServerConfig` with `latexDir` pointing where TeX can work. Provided to the
 * LaTeX services only; nothing else sees the changed value.
 */
export const make = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const latexDir = yield* resolveLatexStateDirectory(config.latexDir);
  return latexDir === config.latexDir
    ? config
    : ServerConfig.ServerConfig.of({ ...config, latexDir });
});

export const layer = Layer.effect(ServerConfig.ServerConfig, make).pipe(
  Layer.provide(ProcessRunner.layer),
);
