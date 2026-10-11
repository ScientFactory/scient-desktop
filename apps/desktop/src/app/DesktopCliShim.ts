import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Semaphore from "effect/Semaphore";
import { SCIENT_DESKTOP_IDENTITY } from "@t3tools/shared/scientDesktopIdentity";

import * as DesktopEnvironment from "./DesktopEnvironment.ts";
import { makeComponentLogger } from "./DesktopObservability.ts";

// A desktop install puts no `scient` on PATH, so commands the server asks a person
// to run (`sudo scient browser setup`) had nothing to call. The app keeps a small
// launcher for its bundled CLI in the Scient home, which is never on PATH and so
// never shadows another command, and the server names it by absolute path in those
// commands through T3CODE_CLI_PATH. An AppImage mounts somewhere new each run,
// so its launcher mounts the AppImage itself instead of pointing into it.
const { logInfo, logWarning } = makeComponentLogger("desktop-cli-shim");

// SCIENT-FORK: Keep this ownership marker stable so older Scient launchers remain recognizable.
export const MARKER = "Written by Scient: runs the desktop app's bundled t3 CLI.";

/** Server entry inside the app, relative to its server root (an asar archive when packaged). */
const SERVER_ENTRY = "apps/server/dist/bin.mjs";

const shellWord = (value: string) => `'${value.replaceAll("'", `'"'"'`)}'`;
/** cmd.exe expands `%` even inside quotes; Windows paths cannot contain `"`. */
const cmdText = (value: string) => value.replaceAll("%", "%%");
const cmdWord = (value: string) => `"${cmdText(value)}"`;

const MOVED = "Scient has moved or been removed. Open the app once to update this command.";
// SCIENT-FORK-END

export type CliShimTarget =
  | { readonly kind: "appimage"; readonly appImage: string; readonly executableName: string }
  | { readonly kind: "direct"; readonly executable: string; readonly entry: string }
  | { readonly kind: "windows"; readonly executable: string; readonly entry: string };

/**
 * The launcher script. Electron runs the server as plain Node with
 * `ELECTRON_RUN_AS_NODE`, which reads the entry from inside the asar archive.
 * The launcher's own path and the app's Scient home are written in, so the command
 * the server shows is absolute and `sudo`, which clears the environment, still
 * runs against this install's home.
 */
export const renderCliShim = (input: {
  readonly target: CliShimTarget;
  readonly shimPath: string;
  readonly t3Home: string;
}) => {
  const { target } = input;
  if (target.kind === "windows") {
    const utf8 = [target.executable, target.entry, input.shimPath, input.t3Home].some((value) =>
      [...value].some((character) => character.codePointAt(0)! > 0x7f),
    );
    const restore = utf8 ? ["chcp %t3_codepage% >nul"] : [];
    return [
      "@echo off",
      `rem ${MARKER}`,
      // Delayed expansion would rewrite `!name!` in paths and arguments.
      "setlocal EnableExtensions DisableDelayedExpansion",
      // The file is UTF-8. Only a non-ASCII path needs the console switched to
      // UTF-8 to read it; a Ctrl-C that ends the batch skips the restore, so the
      // switch is left out for the common all-ASCII install.
      ...(utf8
        ? [
            `for /f "tokens=2 delims=:." %%c in ('chcp') do set "t3_codepage=%%c"`,
            "chcp 65001 >nul",
          ]
        : []),
      `set "T3CODE_CLI_PATH=${cmdText(input.shimPath)}"`,
      // SCIENT-FORK: The safety envelope resolves Scient state, including under sudo.
      `if not defined SCIENT_NEXT_HOME set "SCIENT_NEXT_HOME=${cmdText(input.t3Home)}"`,
      // SCIENT-FORK-END
      'set "ELECTRON_RUN_AS_NODE=1"',
      // A goto, not a parenthesized block: "Program Files (x86)" would close the block early.
      `if exist ${cmdWord(target.executable)} goto run`,
      ...restore,
      `echo ${MOVED} 1>&2`,
      "exit /b 127",
      ":run",
      `${cmdWord(target.executable)} ${cmdWord(target.entry)} %*`,
      'set "t3_exit=%ERRORLEVEL%"',
      ...restore,
      "exit /b %t3_exit%",
      "",
    ].join("\r\n");
  }
  const header = [
    "#!/bin/sh",
    `# ${MARKER}`,
    `export T3CODE_CLI_PATH=${shellWord(input.shimPath)}`,
    `home=${shellWord(input.t3Home)}`,
    // SCIENT-FORK: Preserve the explicit Scient override; ignore an ambient T3 home.
    'export SCIENT_NEXT_HOME="${SCIENT_NEXT_HOME:-$home}"',
    // SCIENT-FORK-END
    "export ELECTRON_RUN_AS_NODE=1",
    `app=${shellWord(target.kind === "appimage" ? target.appImage : target.executable)}`,
    'if [ ! -x "$app" ]; then',
    `  echo "${MOVED}" >&2`,
    "  exit 127",
    "fi",
  ];
  if (target.kind === "direct") {
    return [...header, `exec "$app" ${shellWord(target.entry)} "$@"`, ""].join("\n");
  }
  const run = (root: string) =>
    `"${root}/${target.executableName}" "${root}/resources/app.asar/${SERVER_ENTRY}" "$@"`;
  return [
    ...header,
    // Extract-and-run would make the runtime start the app instead of mounting it.
    "unset APPIMAGE_EXTRACT_AND_RUN",
    // The AppImage runtime prints its mount point, then stays mounted until
    // killed. Background jobs ignore Ctrl-C, so the traps unmount it on any exit.
    "work=$(mktemp -d) || exit 1",
    '"$app" --appimage-mount >"$work/mount" 2>/dev/null &',
    "mounter=$!",
    `trap 'kill "$mounter" 2>/dev/null; rm -rf "$work"' EXIT`,
    "trap 'exit 130' INT TERM",
    "mount=",
    'while kill -0 "$mounter" 2>/dev/null; do',
    '  mount=$(head -n 1 "$work/mount")',
    '  [ -d "$mount" ] && break',
    "  mount=",
    "  sleep 0.05",
    "done",
    // Without FUSE the runtime cannot mount (it prints why and exits); extracting the image still works.
    'if [ -z "$mount" ]; then',
    '  (cd "$work" && "$app" --appimage-extract >/dev/null) || { echo "Could not open $app." >&2; exit 1; }',
    '  mount="$work/squashfs-root"',
    "fi",
    run("$mount"),
    "",
  ].join("\n");
};

/** Where the packaged app keeps its Scient launcher. */
export const launcherPath = (environment: DesktopEnvironment.DesktopEnvironment["Service"]) =>
  environment.path.join(
    environment.baseDir,
    "bin",
    `${SCIENT_DESKTOP_IDENTITY.cliCommandName}${environment.platform === "win32" ? ".cmd" : ""}`,
  );

/** Settings removal and startup refresh must not race to recreate a removed shortcut. */
export const pathMutationLock = Semaphore.makeUnsafe(1);

/** The user-writable locations used by Settings Install and startup refresh. */
export const unixCommandDirectories = (home: string, platform: NodeJS.Platform) =>
  platform === "darwin"
    ? ["/opt/homebrew/bin", "/usr/local/bin", `${home}/.local/bin`, `${home}/bin`]
    : [`${home}/.local/bin`, `${home}/bin`];

/** Recognizes old profiles too, without reading another command's large binary. */
export const isOwnedLauncher = Effect.fnUntraced(
  function* (fs: FileSystem.FileSystem, launcher: string) {
    const info = yield* fs.stat(launcher);
    if (info.type !== "File" || Number(info.size) > 16_384) return false;
    return (yield* fs.readFileString(launcher)).includes(MARKER);
  },
  Effect.orElseSucceed(() => false),
);

export const isOwnedLink = Effect.fnUntraced(
  function* (fs: FileSystem.FileSystem, link: string) {
    yield* fs.readLink(link);
    return yield* isOwnedLauncher(fs, link);
  },
  Effect.orElseSucceed(() => false),
);

/** Prepares beside the old shortcut; any failure leaves that shortcut executable. */
export const replaceOwnedLink = Effect.fnUntraced(function* (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  link: string,
  launcher: string,
) {
  const previous = yield* fs.readLink(link);
  if (previous === launcher) return;
  yield* Effect.scoped(
    Effect.gen(function* () {
      const directory = yield* fs.makeTempDirectoryScoped({
        directory: path.dirname(link),
        prefix: ".scient-cli-",
      });
      const replacement = path.join(directory, path.basename(link));
      yield* fs.symlink(launcher, replacement);
      // Recheck after preparation in case something outside the app changed it.
      if ((yield* fs.readLink(link)) !== previous || !(yield* isOwnedLink(fs, link))) {
        return yield* Effect.fail(`The command at ${link} changed during installation.`);
      }
      yield* fs.rename(replacement, link);
    }),
  );
});

/**
 * Writes the packaged app's launcher to `<Scient home>/bin` and returns its path
 * for the backend's T3CODE_CLI_PATH. Development builds run from a checkout
 * and get none.
 */
export const install = Effect.gen(function* () {
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  if (!environment.isPackaged) return Option.none<string>();
  const fs = yield* FileSystem.FileSystem;
  const path = environment.path;
  const windows = environment.platform === "win32";
  const shimPath = launcherPath(environment);
  const entry = path.join(environment.serverRoot, SERVER_ENTRY);
  const target: CliShimTarget = windows
    ? { kind: "windows", executable: process.execPath, entry }
    : Option.match(environment.appImagePath, {
        onSome: (appImage) => ({
          kind: "appimage" as const,
          appImage,
          executableName: path.basename(process.execPath),
        }),
        // macOS and .deb installs live at a fixed path, so the launcher runs the app directly.
        onNone: () => ({ kind: "direct" as const, executable: process.execPath, entry }),
      });
  const legacyPath = path.join(path.dirname(shimPath), windows ? "t3.cmd" : "t3");
  const legacyLinks: Array<string> = [];
  if (!windows) {
    for (const directory of unixCommandDirectories(
      environment.homeDirectory,
      environment.platform,
    )) {
      const link = path.join(directory, "t3");
      if (yield* isOwnedLink(fs, link)) legacyLinks.push(link);
    }
  }
  const writeLauncher = Effect.fnUntraced(function* (launcher: string, mustExist = false) {
    // A symlink (including a broken one) is not an app-owned launcher file.
    if (Option.isSome(yield* fs.readLink(launcher).pipe(Effect.option))) return false;
    const info = yield* fs.stat(launcher).pipe(Effect.option);
    if (Option.isSome(info) && (info.value.type !== "File" || Number(info.value.size) > 16_384)) {
      return false;
    }
    const existing = yield* fs.readFileString(launcher).pipe(Effect.option);
    if (mustExist && Option.isNone(existing)) return false;
    if (Option.isNone(existing) && (yield* fs.exists(launcher))) return false;
    if (Option.isSome(existing) && !existing.value.includes(MARKER)) {
      yield* logWarning("leaving a CLI launcher the app did not write", { shimPath: launcher });
      return false;
    }
    const content = renderCliShim({ target, shimPath: launcher, t3Home: environment.baseDir });
    if (Option.getOrUndefined(existing) !== content) {
      yield* fs.makeDirectory(path.dirname(launcher), { recursive: true });
      yield* Effect.scoped(
        Effect.gen(function* () {
          const directory = yield* fs.makeTempDirectoryScoped({
            directory: path.dirname(launcher),
            prefix: ".scient-launcher-",
          });
          const staging = path.join(directory, path.basename(launcher));
          yield* fs.writeFileString(staging, content, { mode: 0o755 });
          const currentInfo = yield* fs.stat(launcher).pipe(Effect.option);
          if (
            Option.isSome(yield* fs.readLink(launcher).pipe(Effect.option)) ||
            (Option.isSome(currentInfo) &&
              (currentInfo.value.type !== "File" || Number(currentInfo.value.size) > 16_384))
          ) {
            return yield* Effect.fail(`The launcher at ${launcher} changed during installation.`);
          }
          const current = yield* fs.readFileString(launcher).pipe(Effect.option);
          if (
            Option.getOrUndefined(current) !== Option.getOrUndefined(existing) ||
            (Option.isNone(current) && (yield* fs.exists(launcher)))
          ) {
            return yield* Effect.fail(`The launcher at ${launcher} changed during installation.`);
          }
          yield* fs.rename(staging, launcher);
        }),
      );
      yield* logInfo("installed CLI launcher", { shimPath: launcher });
    }
    return true;
  });

  return yield* Effect.gen(function* () {
    // An existing owned PATH shortcut authorizes a current-profile fallback, but
    // startup never creates a t3 PATH shortcut or modifies a previous profile.
    const legacyReady = yield* writeLauncher(legacyPath, legacyLinks.length === 0).pipe(
      Effect.catchCause((cause) =>
        logWarning("could not refresh legacy Scient launcher", { cause: Cause.pretty(cause) }).pipe(
          Effect.as(false),
        ),
      ),
    );
    const canonicalReady = yield* writeLauncher(shimPath).pipe(
      Effect.catchCause((cause) =>
        logWarning("could not install Scient launcher", { cause: Cause.pretty(cause) }).pipe(
          Effect.as(false),
        ),
      ),
    );
    const ready = canonicalReady ? shimPath : legacyReady ? legacyPath : undefined;
    if (ready === undefined) return Option.none<string>();
    for (const link of legacyLinks) {
      yield* replaceOwnedLink(fs, path, link, legacyReady ? legacyPath : ready);
    }
    return Option.some(ready);
  }).pipe(
    // Best-effort: never block backend startup; recovery can invoke its own runtime and entry.
    Effect.catchCause((cause) =>
      logWarning("could not install Scient launcher", {
        shimPath,
        cause: Cause.pretty(cause),
      }).pipe(Effect.as(Option.none<string>())),
    ),
    Effect.withSpan("desktop.cliShim.install"),
  );
}).pipe(pathMutationLock.withPermit);
