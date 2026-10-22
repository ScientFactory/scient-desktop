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
 * changes. If the private folder cannot be made, or the answer takes longer
 * than server start should wait, the original stays in use: that is how it was
 * before, and TeX's own error still reaches the user.
 */
import * as NodeCrypto from "node:crypto";

import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Deferred from "effect/Deferred";
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
/** Server start waits this long for the answer; past it, the profile folder is used. */
const DECISION_TIMEOUT = "30 seconds";
/** And this long for earlier state to move; the rest moves on in the background. */
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
          // Written beside the record and renamed over it: one interruptible
          // step publishes it whole. The temporary name is one the sweep
          // above clears if an attempt stops in between.
          const contents = yield* encodeLocation({ schemaVersion: 1, directory, identity });
          const pending = path.join(latexDir, `.${name}.json`);
          yield* fileSystem.writeFileString(pending, contents);
          yield* fileSystem.rename(pending, locationPath);
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
     * already there — not even one the services write while this still runs:
     * a file is linked to its new name, which fails if the name is taken, and
     * only then unlinked; a folder rename fails onto a folder with contents.
     * Best effort and repeatable: whatever fails moves on a later start.
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
              const source = path.join(from, entry);
              const target = path.join(to, entry);
              if (yield* fileSystem.exists(target)) continue;
              yield* Effect.gen(function* () {
                if ((yield* fileSystem.stat(source)).type === "Directory") {
                  yield* fileSystem.rename(source, target);
                } else {
                  yield* fileSystem.link(source, target);
                  yield* fileSystem.remove(source);
                }
              }).pipe(Effect.ignoreCause());
            }
            if ((yield* fileSystem.readDirectory(from)).length === 0) {
              yield* fileSystem.remove(from, { recursive: true });
            }
          }).pipe(Effect.ignoreCause()),
        { discard: true },
      );

    const programData =
      environmentValue(environment, "ProgramData") ??
      environmentValue(environment, "ALLUSERSPROFILE");
    if (programData === undefined || !path.isAbsolute(programData) || !isTexSafePath(programData)) {
      yield* Effect.logWarning("scient latex state stays in the profile folder", {
        latexDir,
        reason: "This computer has no plain-ASCII ProgramData folder.",
      });
      return latexDir;
    }

    /** The folder the record names, if it is still the very folder made. */
    const recordedFolder = Effect.gen(function* () {
      const recorded = yield* fileSystem.readFileString(locationPath).pipe(
        Effect.flatMap(decodeLocation),
        Effect.orElseSucceed(() => null),
      );
      return recorded !== null &&
        isPrivateLatexStateFolder({ directory: recorded.directory, programData, path }) &&
        (yield* folderIdentity(recorded.directory)) === recorded.identity
        ? recorded.directory
        : null;
    });

    const decision = yield* Deferred.make<string>();
    const carried = yield* Deferred.make<void>();
    // The work runs on its own fiber and only its answer is waited for. Some
    // of what it calls cleans up in steps nothing can interrupt — stopping a
    // hung process, closing a file — and none of that may hold server start.
    // Whichever settles `decision` first wins: this folder, or the profile one
    // when the wait runs out. Earlier state moves only when this folder won,
    // so it is never split between the two. A folder recorded after losing is
    // the one the next start uses.
    yield* Effect.gen(function* () {
      const directory = yield* Effect.gen(function* () {
        return (yield* recordedFolder) ?? (yield* makePrivateFolder(programData));
      }).pipe(
        Effect.catch((cause) =>
          Effect.logWarning("scient latex state stays in the profile folder", {
            latexDir,
            reason: cause.message,
          }).pipe(Effect.as(latexDir)),
        ),
      );
      if ((yield* Deferred.succeed(decision, directory)) && directory !== latexDir) {
        yield* carryOver(directory);
      }
    }).pipe(Effect.ensuring(Deferred.succeed(carried, undefined)), Effect.forkDetach);

    yield* Deferred.await(decision).pipe(Effect.timeoutOption(DECISION_TIMEOUT));
    if (yield* Deferred.succeed(decision, latexDir)) {
      yield* Effect.logWarning("scient latex state stays in the profile folder", {
        latexDir,
        reason: "Finding the folder took too long.",
      });
      return latexDir;
    }
    const chosen = yield* Deferred.await(decision);
    if (chosen !== latexDir) {
      yield* Deferred.await(carried).pipe(Effect.timeoutOption(CARRY_OVER_TIMEOUT));
    }
    return chosen;
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
