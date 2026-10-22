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
 * which is ASCII on every Windows. That is a shared location, so the folder is
 * made private before anything goes in it: a fresh random name nobody can have
 * prepared, inherited access removed, access granted only to this user, SYSTEM
 * and Administrators, and then a check that it is still empty, so nothing
 * another account slipped in before the lock can stay. Other accounts cannot
 * remove or rename it afterwards, because `%ProgramData%` only lets them delete
 * what they created. Its path is recorded in the original `latexDir`, inside
 * the user's private profile, so every start finds the same folder.
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
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import * as ServerConfig from "../../config.ts";
import * as ProcessRunner from "../../processRunner.ts";

/** Written into the original `latexDir`; names the folder actually in use. */
export const LATEX_STATE_LOCATION_FILE = "tex-location.json";

const PRIVATE_FOLDER_PATTERN = /^scient-latex-[0-9a-f]{16}$/u;
const TOOL_TIMEOUT = "10 seconds";
const TOOL_MAX_OUTPUT_BYTES = 64 * 1024;
/**
 * What earlier builds left that is worth keeping: build evidence and the
 * SyncTeX indexes of published PDFs. Everything else there is rebuilt.
 */
const CARRIED_OVER = ["evidence", "synctex"] as const;

const LatexStateLocationRecord = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  directory: Schema.String,
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

    const makePrivateFolder = (programData: string) =>
      Effect.gen(function* () {
        const directory = path.join(
          programData,
          `scient-latex-${NodeCrypto.randomBytes(8).toString("hex")}`,
        );
        // Not recursive: an existing folder is refused rather than adopted.
        yield* fileSystem.makeDirectory(directory);
        return yield* Effect.gen(function* () {
          const whoami = yield* runTool(`${system32}\\whoami.exe`, ["/user", "/fo", "csv", "/nh"]);
          const sid = windowsUserSid(whoami.stdout);
          if (sid === null) {
            return yield* new LatexStateLocationError({
              detail: "whoami did not name this account's SID.",
            });
          }
          yield* runTool(`${system32}\\icacls.exe`, privateFolderLockArguments(directory, sid));
          if ((yield* fileSystem.readDirectory(directory)).length > 0) {
            return yield* new LatexStateLocationError({
              detail: "Something was put in the new folder before it was made private.",
            });
          }
          const contents = yield* encodeLocation({ schemaVersion: 1, directory });
          yield* writeFileStringAtomically({ filePath: locationPath, contents });
          yield* Effect.logInfo("scient latex state moved to a private ASCII folder", {
            directory,
          });
          return directory;
        }).pipe(
          Effect.onError(() =>
            fileSystem
              .remove(directory, { recursive: true, force: true })
              .pipe(Effect.ignoreCause()),
          ),
        );
      });

    return yield* Effect.gen(function* () {
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
        Effect.map((record) => record.directory),
        Effect.orElseSucceed(() => null),
      );
      const reusable =
        recorded !== null &&
        isPrivateLatexStateFolder({ directory: recorded, programData, path }) &&
        (yield* fileSystem.stat(recorded).pipe(
          Effect.map((info) => info.type === "Directory"),
          Effect.orElseSucceed(() => false),
        ));
      const directory = reusable ? recorded : yield* makePrivateFolder(programData);
      // Best effort and repeatable: a start interrupted before this ran
      // carries the rest over next time, and nothing here can fail a start.
      yield* Effect.forEach(
        CARRIED_OVER,
        (entry) =>
          Effect.gen(function* () {
            const from = path.join(latexDir, entry);
            const to = path.join(directory, entry);
            if ((yield* fileSystem.exists(from)) && !(yield* fileSystem.exists(to))) {
              yield* fileSystem.rename(from, to);
            }
          }).pipe(Effect.ignoreCause()),
        { discard: true },
      );
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
