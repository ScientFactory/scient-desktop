// @effect-diagnostics-next-line nodeBuiltinImport:off -- FileSystem.access has no execute check.
import * as NodeFSP from "node:fs/promises";

import type { DesktopCliCommandState } from "@t3tools/contracts";
import { SCIENT_DESKTOP_IDENTITY } from "@t3tools/shared/scientDesktopIdentity";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { pathSetup, readUserLoginShell } from "@t3tools/shared/shell";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import * as DesktopCliShim from "./DesktopCliShim.ts";
import * as DesktopEnvironment from "./DesktopEnvironment.ts";
import { makeComponentLogger } from "./DesktopObservability.ts";

const { logInfo, logWarning } = makeComponentLogger("desktop-cli-command");

// Settings → Install `scient` command, like VS Code's "Install 'code' command".
// The app's launcher (see DesktopCliShim) lives in the Scient home and is off PATH

export class DesktopCliCommandError extends Schema.TaggedError<DesktopCliCommandError>()(
  "DesktopCliCommandError",
  { message: Schema.String },
) {}

const pathEntries = (value: string | undefined, separator: string) =>
  (value ?? "").split(separator).filter((entry) => entry.length > 0);

const sameWindowsPath = (left: string, right: string) =>
  left.replace(/[\\/]+$/, "").toLowerCase() === right.replace(/[\\/]+$/, "").toLowerCase();

// Preserve REG_EXPAND_SZ and %VAR% expansion; notify Explorer with WM_SETTINGCHANGE.
// Failed reads must exit nonzero to prevent replacing PATH wholesale.
const WINDOWS_USER_PATH_SCRIPT = `
$ErrorActionPreference = 'Stop'
if ($env:T3_SET -eq '1') {
  $key = [Microsoft.Win32.Registry]::CurrentUser.CreateSubKey('Environment')
  $kind = [Microsoft.Win32.RegistryValueKind]::ExpandString
  if ($key.GetValueNames() -contains 'Path' -and $key.GetValueKind('Path') -eq 'String') {
    $kind = [Microsoft.Win32.RegistryValueKind]::String
  }
  $key.SetValue('Path', $env:T3_PATH, $kind)
  Add-Type -Namespace T3 -Name Env -MemberDefinition '[DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern System.IntPtr SendMessageTimeout(System.IntPtr hWnd, uint Msg, System.UIntPtr wParam, string lParam, uint fuFlags, uint uTimeout, out System.UIntPtr lpdwResult);'
  $result = [System.UIntPtr]::Zero
  [void][T3.Env]::SendMessageTimeout([System.IntPtr]0xffff, 0x1A, [System.UIntPtr]::Zero, 'Environment', 2, 5000, [ref]$result)
} else {
  $key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Environment')
  $value = if ($key) { $key.GetValue('Path', '', 'DoNotExpandEnvironmentNames') } else { '' }
  [Console]::Out.Write([Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes([string]$value)))
}
`;

export class DesktopCliCommand extends Context.Service<
  DesktopCliCommand,
  {
    readonly state: Effect.Effect<DesktopCliCommandState>;
    readonly install: Effect.Effect<DesktopCliCommandState, DesktopCliCommandError>;
    readonly uninstall: Effect.Effect<DesktopCliCommandState, DesktopCliCommandError>;
    /** Adds the installed command's folder to PATH in the user's shell startup file. */
    readonly addToPath: Effect.Effect<DesktopCliCommandState, DesktopCliCommandError>;
    /** Installs the command on a fresh install's first launch; removing it in Settings sticks. */
    readonly installOnFirstLaunch: Effect.Effect<void>;
  }
>()("@t3tools/desktop/app/DesktopCliCommand") {}

export const make = Effect.gen(function* () {
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const fs = yield* FileSystem.FileSystem;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  // Read the live env: shell discovery patches PATH after startup, and Windows variable
  // names are case-insensitive only on process.env, not on Config's copy of it.
  const env = yield* HostProcess.Environment;
  const path = environment.path;
  const windows = environment.platform === "win32";
  const commandName = SCIENT_DESKTOP_IDENTITY.cliCommandName;
  const launcher = DesktopCliShim.launcherPath(environment);
  const binDirectory = path.dirname(launcher);
  const ownedPathMarker = path.join(environment.stateDir, "cli-command-path-entry");

  const fail = (message: string) => new DesktopCliCommandError({ message });
  const exists = (target: string) => fs.exists(target).pipe(Effect.orElseSucceed(() => false));
  const firstLaunchMarker = path.join(environment.stateDir, "cli-command-first-launch");
  // Read before this launch writes either one: an app that ran before left its launcher or
  // settings. Its user may have removed the command or chosen another, so only Settings installs.
  const freshInstall =
    !(yield* exists(launcher)) && !(yield* exists(environment.desktopSettingsPath));
  const writableDirectory = (directory: string) =>
    fs.access(directory, { writable: true }).pipe(
      Effect.as(true),
      Effect.orElseSucceed(() => false),
    );

  const isOurLauncher = (target: string) => DesktopCliShim.isOwnedLauncher(fs, target);
  const isOurLink = (link: string) => DesktopCliShim.isOwnedLink(fs, link);
  const directories = DesktopCliShim.unixCommandDirectories(
    environment.homeDirectory,
    environment.platform,
  );

  // PATH can reach the regular launcher directly; removal still requires isOurLink.
  const runsOurLauncher = Effect.fn("DesktopCliCommand.runsOurLauncher")(
    function* (candidate: string) {
      if (yield* isOurLink(candidate)) return true;
      const [resolved, ours] = yield* Effect.all([fs.realPath(candidate), fs.realPath(launcher)]);
      if (resolved !== ours) return false;
      const info = yield* fs.stat(candidate);
      if (info.type !== "File" || Number(info.size) > 16_384) return false;
      return (yield* fs.readFileString(candidate)).includes(DesktopCliShim.MARKER);
    },
    Effect.orElseSucceed(() => false),
  );

  const powershell = (overrides: Record<string, string>) =>
    Effect.scoped(
      Effect.gen(function* () {
        const root = env.SystemRoot ?? env.WINDIR;
        const handle = yield* spawner.spawn(
          ChildProcess.make(
            root ? `${root}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe` : "powershell.exe",
            ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", WINDOWS_USER_PATH_SCRIPT],
            { stdin: "ignore", stderr: "ignore", env: overrides, extendEnv: true },
          ),
        );
        const [stdout, exitCode] = yield* Effect.all(
          [handle.stdout.pipe(Stream.decodeText(), Stream.mkString), handle.exitCode],
          { concurrency: "unbounded" },
        );
        if (exitCode !== 0) return yield* Effect.fail(`powershell exited with ${exitCode}`);
        return stdout;
      }),
    );
  const readUserPath = powershell({}).pipe(
    Effect.map((encoded) => Buffer.from(encoded.trim(), "base64").toString("utf8")),
    Effect.mapError(() => fail("Could not read your PATH, so it was left unchanged.")),
  );
  const writeUserPath = (value: string) =>
    powershell({ T3_SET: "1", T3_PATH: value }).pipe(
      Effect.asVoid,
      Effect.mapError(() => fail("Could not update your PATH.")),
    );

  const recordedWindowsPath = Effect.gen(function* () {
    const recorded = yield* fs.readFileString(ownedPathMarker).pipe(Effect.option);
    if (Option.isNone(recorded) || !sameWindowsPath(recorded.value.trim(), binDirectory)) {
      return Option.none<Array<string>>();
    }
    const entries = pathEntries(yield* readUserPath, ";");
    // A valid record can outlive an external PATH removal. Remove must still
    // clear it, or a later user-added entry would inherit our stale ownership.
    return Option.some(entries);
  });

  const isExecutableFile = Effect.fn("DesktopCliCommand.isExecutableFile")(
    function* (target: string) {
      if ((yield* fs.stat(target)).type !== "File") return false;
      yield* Effect.tryPromise({
        try: () => NodeFSP.access(target, NodeFSP.constants.X_OK),
        catch: () => fail(`${target} is not executable.`),
      });
      return true;
    },
    Effect.orElseSucceed(() => false),
  );

  /** The `scient` a new shell runs, by PATH order, or none. */
  const firstOnPath = Effect.gen(function* () {
    for (const directory of pathEntries(env.PATH, ":")) {
      const candidate = path.join(directory, commandName);
      if (yield* isExecutableFile(candidate)) return Option.some(candidate);
    }
    return Option.none<string>();
  });

  /** The `scient` a new shell runs when it is not this app's, on Unix. */
  const foreignFirstOnPath = Effect.gen(function* () {
    if (windows) return Option.none<string>();
    const first = yield* firstOnPath;
    if (Option.isNone(first) || (yield* runsOurLauncher(first.value))) return Option.none<string>();
    return first;
  });

  const installedAt = Effect.gen(function* () {
    for (const directory of directories) {
      const link = path.join(directory, commandName);
      if (yield* isOurLink(link)) return Option.some(link);
    }
    return Option.none<string>();
  });

  /** Only installations Remove owns count, not an internal or user-added launcher. */
  const legacyInstalled = Effect.gen(function* () {
    for (const directory of directories) {
      if (yield* isOurLink(path.join(directory, "t3"))) return true;
    }
    return false;
  });

  const startupLine = (installedPath: string) => {
    const setup = pathSetup({
      directory: path.dirname(installedPath),
      home: environment.homeDirectory,
      // A Finder or desktop launch may not set SHELL.
      shell: env.SHELL || readUserLoginShell(),
      platform: environment.platform,
      configHome: env.XDG_CONFIG_HOME,
      zdotdir: env.ZDOTDIR,
    });
    if (setup === undefined) return undefined;
    const file = setup.file.startsWith("~/")
      ? path.join(environment.homeDirectory, setup.file.slice(2))
      : setup.file;
    return { ...setup, path: file };
  };
  const hasLine = (setup: { readonly path: string; readonly line: string }) =>
    fs.readFileString(setup.path).pipe(
      Effect.map((content) => content.split("\n").some((line) => line.trim() === setup.line)),
      Effect.orElseSucceed(() => false),
    );
  const folderOnPath = (link: string) =>
    Effect.sync(() =>
      pathEntries(env.PATH, ":").some((entry) => entry.replace(/\/+$/, "") === path.dirname(link)),
    );

  const state: DesktopCliCommand["Service"]["state"] = Effect.gen(function* () {
    if (!environment.isPackaged) {
      return {
        supported: false,
        installedPath: null,
        legacyInstalled: false,
        onPath: false,
        launcherPath: null,
      } as const;
    }
    // SCIENT-FORK:START — recovery commands must never recommend a foreign launcher.
    const launcherPath = (yield* isOurLauncher(launcher)) ? launcher : null;
    // SCIENT-FORK:END
    // SCIENT-FORK:START — Windows removal owns only the recorded PATH entry.
    if (windows) {
      const recorded = yield* recordedWindowsPath;
      const owned =
        Option.isSome(recorded) &&
        recorded.value.some((entry) => sameWindowsPath(entry, binDirectory));
      const installed = owned && (yield* isOurLauncher(launcher));
      return {
        supported: true,
        installedPath: installed ? launcher : null,
        legacyInstalled: owned && (yield* isOurLauncher(path.join(binDirectory, "t3.cmd"))),
        onPath: installed,
        launcherPath,
      };
    }
    // SCIENT-FORK:END
    const installed = yield* installedAt;
    const legacy = yield* legacyInstalled;
    const shadowedBy = yield* foreignFirstOnPath;
    const shadow = Option.isSome(shadowedBy) ? { shadowedBy: shadowedBy.value } : {};
    // first `scient` on PATH must be ours; a `scient` earlier on PATH would shadow it.
    const first = yield* firstOnPath;
    const onPath = Option.isSome(first) && (yield* runsOurLauncher(first.value));
    // Only a folder missing from PATH, with no other scient first: with one, the added folder
    // (last on PATH) would still not run this scient.
    const setup =
      onPath ||
      Option.isSome(shadowedBy) ||
      Option.isNone(installed) ||
      (yield* folderOnPath(installed.value))
        ? undefined
        : startupLine(installed.value);
    return {
      supported: true,
      installedPath: Option.getOrNull(installed),
      legacyInstalled: legacy,
      onPath,
      launcherPath,
      ...shadow,
      ...(setup === undefined
        ? {}
        : { pathSetup: { file: setup.file, added: yield* hasLine(setup) } }),
    };
  }).pipe(
    Effect.orElseSucceed(() => ({
      supported: false,
      installedPath: null,
      legacyInstalled: false,
      onPath: false,
      launcherPath: null,
    })),
  );

  const ensureLauncher = DesktopCliShim.install.pipe(
    Effect.provideService(DesktopEnvironment.DesktopEnvironment, environment),
    Effect.provideService(FileSystem.FileSystem, fs),
    Effect.flatMap(
      Option.match({
        onNone: () => Effect.fail(fail(`Could not set up the scient launcher at ${launcher}.`)),
        onSome: (installedLauncher) =>
          installedLauncher === launcher
            ? Effect.void
            : Effect.fail(fail(`Could not set up the scient launcher at ${launcher}.`)),
      }),
    ),
  );

  const installShortcut = Effect.gen(function* () {
    if (windows) {
      const entries = pathEntries(yield* readUserPath, ";");
      if (!entries.some((entry) => sameWindowsPath(entry, binDirectory))) {
        yield* writeUserPath([...entries, binDirectory].join(";"));
        yield* fs
          .writeFileString(ownedPathMarker, `${binDirectory}\n`)
          .pipe(Effect.mapError(() => fail("Added scient to your PATH but could not record it.")));
      }
      return yield* state;
    }
    const existing = yield* installedAt;
    if (Option.isSome(existing)) {
      const target = yield* fs.readLink(existing.value).pipe(Effect.option);
      if (Option.getOrUndefined(target) === launcher) return yield* state;
    }
    // Installing behind a foreign scient would only hide the problem.
    const shadowedBy = yield* foreignFirstOnPath;
    if (Option.isSome(shadowedBy)) {
      return yield* fail(
        `Another scient at ${shadowedBy.value} runs first in a new terminal. Remove it, or run the launcher directly at ${launcher}.`,
      );
    }
    if (Option.isSome(existing)) {
      const link = existing.value;
      yield* DesktopCliShim.replaceOwnedLink(fs, path, link, launcher).pipe(
        Effect.mapError(() => fail(`Could not replace ${link}.`)),
      );
      return yield* state;
    }
    const onPath = pathEntries(env.PATH, ":");
    const candidates = directories;
    for (const directory of [
      ...candidates.filter((candidate) => onPath.includes(candidate)),
      ...candidates.filter((candidate) => !onPath.includes(candidate)),
    ]) {
      const link = path.join(directory, commandName);
      const created = (yield* exists(directory))
        ? yield* writableDirectory(directory)
        : yield* fs.makeDirectory(directory, { recursive: true }).pipe(
            Effect.as(true),
            Effect.orElseSucceed(() => false),
          );
      if (!created) continue;
      const linked = yield* fs.symlink(launcher, link).pipe(
        Effect.as(true),
        Effect.orElseSucceed(() => false),
      );
      if (linked) return yield* state;
    }
    return yield* fail(
      `Another scient command is already installed, or no folder on your PATH is writable. Run the launcher directly at ${launcher}.`,
    );
  }).pipe(DesktopCliShim.pathMutationLock.withPermit);

  const install: DesktopCliCommand["Service"]["install"] = Effect.gen(function* () {
    if (!environment.isPackaged) return yield* fail("The scient command needs an installed app.");
    yield* ensureLauncher;
    return yield* installShortcut;
  }).pipe(Effect.withSpan("desktop.cliCommand.install"));

  const uninstall: DesktopCliCommand["Service"]["uninstall"] = Effect.gen(function* () {
    if (!environment.isPackaged) return yield* state;
    // A first launch put off for the shell PATH must not bring back what the user removed.
    yield* fs.writeFileString(firstLaunchMarker, "").pipe(Effect.ignore);
    if (windows) {
      const owned = yield* recordedWindowsPath;
      if (Option.isSome(owned)) {
        const entries = owned.value;
        const kept = entries.filter((entry) => !sameWindowsPath(entry, binDirectory));
        if (kept.length !== entries.length) yield* writeUserPath(kept.join(";"));
        yield* fs.remove(ownedPathMarker).pipe(Effect.ignore);
      }
      return yield* state;
    }
    for (const directory of directories) {
      for (const name of [commandName, "t3"]) {
        const link = path.join(directory, name);
        if (yield* isOurLink(link)) {
          yield* fs.remove(link).pipe(Effect.mapError(() => fail(`Could not remove ${link}.`)));
        }
      }
    }
    return yield* state;
  }).pipe(
    DesktopCliShim.pathMutationLock.withPermit,
    Effect.withSpan("desktop.cliCommand.uninstall"),
  );

  const addToPath: DesktopCliCommand["Service"]["addToPath"] = Effect.gen(function* () {
    const installed = yield* installedAt;
    if (windows || Option.isNone(installed)) {
      return yield* fail("Install the scient command first.");
    }
    const setup = startupLine(installed.value);
    if (setup === undefined) return yield* fail("Scient cannot add scient to this shell's PATH.");
    const shadowedBy = yield* foreignFirstOnPath;
    if (Option.isSome(shadowedBy)) {
      return yield* fail(
        `Another scient at ${shadowedBy.value} runs first; Scient leaves it in place.`,
      );
    }
    if (!(yield* folderOnPath(installed.value)) && !(yield* hasLine(setup))) {
      yield* fs.makeDirectory(path.dirname(setup.path), { recursive: true }).pipe(
        Effect.andThen(
          fs.writeFileString(setup.path, `\n# Added by Scient\n${setup.line}\n`, { flag: "a" }),
        ),
        Effect.mapError(() => fail(`Could not add scient to ${setup.file}.`)),
      );
    }
    return yield* state;
  }).pipe(
    // One at a time, so Settings and onboarding cannot both append the line.
    DesktopCliShim.pathMutationLock.withPermit,
    Effect.withSpan("desktop.cliCommand.addToPath"),
  );

  const installOnFirstLaunch: DesktopCliCommand["Service"]["installOnFirstLaunch"] = Effect.gen(
    function* () {
      if (!environment.isPackaged || (yield* exists(firstLaunchMarker))) return;
      // Mark first so a failed or removed install is never retried behind the user's back.
      yield* fs.writeFileString(firstLaunchMarker, "");
      if (!freshInstall) {
        return yield* logInfo("left the scient command to Settings on an existing install");
      }
      // A scient that is not ours in these folders, even off PATH, means the user has one already.
      // On Windows the app never writes there, so any scient there is someone else's.
      for (const directory of directories) {
        for (const name of windows ? [`${commandName}.cmd`, `${commandName}.exe`] : [commandName]) {
          const other = path.join(directory, name);
          const present =
            (yield* exists(other)) || Option.isSome(yield* fs.readLink(other).pipe(Effect.option));
          if (present && (windows || !(yield* isOurLink(other)))) {
            return yield* logInfo("left the scient command to Settings beside another scient", {
              other,
            });
          }
        }
      }
      const installed = yield* install;
      yield* logInfo("installed the scient command on first launch", {
        installedPath: installed.installedPath,
        onPath: installed.onPath,
      });
    },
  ).pipe(
    // Our own messages are short and name only paths; anything else is logged as a category.
    Effect.catch((error) =>
      logWarning("did not install the scient command on first launch", {
        reason: error._tag === "DesktopCliCommandError" ? error.message : "state-write-failed",
      }),
    ),
    Effect.withSpan("desktop.cliCommand.installOnFirstLaunch"),
  );

  // SCIENT-FORK: Scient's ownership rules with T3's first-launch install and PATH setup.
  return DesktopCliCommand.of({ state, install, uninstall, addToPath, installOnFirstLaunch });
});

export const layer = Layer.effect(DesktopCliCommand, make);
