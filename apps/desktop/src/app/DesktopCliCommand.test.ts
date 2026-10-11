// @effect-diagnostics nodeBuiltinImport:off - Executes Windows batch launchers with native cmd.exe.
import * as NodeChildProcess from "node:child_process";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { afterEach, beforeEach, expect, it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as ChildProcess from "effect/process/ChildProcess";

import * as DesktopCliCommand from "./DesktopCliCommand.ts";
import * as DesktopCliShim from "./DesktopCliShim.ts";
import * as DesktopEnvironment from "./DesktopEnvironment.ts";

const nativePlatform = HostProcess.Platform.defaultValue();

const environmentFor = (
  path: Path.Path,
  input: {
    home: string;
    baseDir: string;
    platform?: NodeJS.Platform;
    isPackaged?: boolean;
    serverRoot?: string;
  },
) =>
  DesktopEnvironment.DesktopEnvironment.of({
    path,
    platform: input.platform ?? "linux",
    isPackaged: input.isPackaged ?? true,
    homeDirectory: input.home,
    baseDir: input.baseDir,
    stateDir: path.join(input.baseDir, "userdata"),
    serverRoot: input.serverRoot ?? "/opt/T3 Code/resources/app.asar",
    appImagePath: Option.none(),
  } as unknown as DesktopEnvironment.DesktopEnvironment["Service"]);

/** The service for a packaged app; the launcher is written on Install. */
const commandIn = (
  input: {
    home: string;
    baseDir?: string;
    platform?: NodeJS.Platform;
    isPackaged?: boolean;
    serverRoot?: string;
  },
  spawner?: ChildProcessSpawner.ChildProcessSpawner["Service"],
) =>
  Effect.gen(function* () {
    const path = yield* Path.Path;
    const fs = yield* FileSystem.FileSystem;
    const baseDir = input.baseDir ?? path.join(input.home, ".scient-next");
    yield* fs.makeDirectory(path.join(baseDir, "userdata"), { recursive: true });
    const make = DesktopCliCommand.make.pipe(
      Effect.provideService(
        DesktopEnvironment.DesktopEnvironment,
        environmentFor(path, { ...input, baseDir }),
      ),
    );
    return yield* spawner
      ? make.pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner))
      : make;
  });

/** A PowerShell that keeps the user's PATH in memory and can be told to fail reads. */
const fakePowerShell = (initial: string) => {
  const registry = { path: initial, failReads: false, writes: 0 };
  const spawner = ChildProcessSpawner.make((command) =>
    Effect.sync(() => {
      const { options } = command as unknown as {
        readonly options: { readonly env?: Record<string, string> };
      };
      const env = options.env ?? {};
      let exitCode = 0;
      let stdout = "";
      if (env.T3_SET === "1") {
        registry.path = env.T3_PATH ?? "";
        registry.writes += 1;
      } else if (registry.failReads) {
        exitCode = 1;
      } else {
        stdout = Buffer.from(registry.path, "utf8").toString("base64");
      }
      return ChildProcessSpawner.makeHandle({
        pid: ChildProcessSpawner.ProcessId(1),
        exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(exitCode)),
        isRunning: Effect.succeed(false),
        kill: () => Effect.void,
        unref: Effect.succeed(Effect.void),
        stdin: Sink.drain,
        stdout: Stream.make(new TextEncoder().encode(stdout)),
        stderr: Stream.empty,
        all: Stream.empty,
        getInputFd: () => Sink.drain,
        getOutputFd: () => Stream.empty,
      });
    }),
  );
  return { registry, spawner };
};

const machineEnvironment = {
  PATH: process.env.PATH,
  SCIENT_NEXT_HOME: process.env.SCIENT_NEXT_HOME,
  T3CODE_HOME: process.env.T3CODE_HOME,
  T3CODE_CLI_PATH: process.env.T3CODE_CLI_PATH,
};
beforeEach(() => {
  process.env.PATH = "";
  delete process.env.SCIENT_NEXT_HOME;
  delete process.env.T3CODE_HOME;
  delete process.env.T3CODE_CLI_PATH;
});
afterEach(() => {
  for (const [name, value] of Object.entries(machineEnvironment)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

const fixtureServer = Effect.fnUntraced(function* (root: string, revision: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const entry = path.join(root, "apps/server/dist/bin.mjs");
  yield* fs.makeDirectory(path.dirname(entry), { recursive: true });
  yield* fs.writeFileString(
    entry,
    `console.log(JSON.stringify({revision:${JSON.stringify(revision)},home:process.env.SCIENT_NEXT_HOME,cli:process.env.T3CODE_CLI_PATH,args:process.argv.slice(2)}));`,
  );
  return root;
});

const executeShortcut = Effect.fnUntraced(function* (
  launcher: string,
  args: ReadonlyArray<string>,
) {
  if ((yield* HostProcess.Platform) === "win32") {
    const quoted = args.map((argument) => `"${argument.replaceAll('"', '\\"')}"`).join(" ");
    const result = yield* Effect.sync(() =>
      NodeChildProcess.spawnSync(
        process.env.ComSpec ?? `${process.env.SystemRoot}\\System32\\cmd.exe`,
        ["/d", "/s", "/c", `""${launcher}" ${quoted}"`],
        {
          encoding: "utf8",
          windowsVerbatimArguments: true,
          env: { ...process.env, PATH: machineEnvironment.PATH },
        },
      ),
    );
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
    return JSON.parse(result.stdout.trim()) as unknown;
  }
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  return JSON.parse(yield* spawner.string(ChildProcess.make(launcher, args))) as unknown;
});

it.layer(NodeServices.layer)("DesktopCliCommand", (it) => {
  const unix = it.effect.skipIf(nativePlatform === "win32");
  unix(
    "executes the installed scient and upgraded t3 shortcuts with the same profile and arguments",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const home = yield* fs.makeTempDirectoryScoped({ prefix: "Scient's CLI space-" });
        const baseDir = path.join(home, ".scient-next");
        const serverRoot = yield* fixtureServer(path.join(home, "Scient App"), "current");
        const previousBase = path.join(home, "previous Scient profile");
        const legacy = path.join(previousBase, "bin", "t3");
        yield* fs.makeDirectory(path.dirname(legacy), { recursive: true });
        yield* fs.writeFileString(legacy, `#!/bin/sh\n# ${DesktopCliShim.MARKER}\nexit 127\n`, {
          mode: 0o755,
        });
        const oldLink = path.join(home, ".local/bin/t3");
        yield* fs.makeDirectory(path.dirname(oldLink), { recursive: true });
        yield* fs.symlink(legacy, oldLink);
        const previousContent = yield* fs.readFileString(legacy);
        const backendLauncher = yield* DesktopCliShim.install.pipe(
          Effect.provideService(
            DesktopEnvironment.DesktopEnvironment,
            environmentFor(path, { home, baseDir, serverRoot }),
          ),
        );
        expect(Option.getOrNull(backendLauncher)).toBe(path.join(baseDir, "bin", "scient"));
        const command = yield* commandIn({ home, serverRoot });
        const installed = yield* command.install;
        const args = ["app", "a project with spaces and 'quotes'", ""];
        expect(installed.legacyInstalled).toBe(true);
        for (const launcher of [installed.installedPath!, oldLink]) {
          const output = yield* executeShortcut(launcher, args);
          expect(output).toEqual({
            revision: "current",
            home: baseDir,
            cli: path.join(baseDir, "bin", launcher === oldLink ? "t3" : "scient"),
            args,
          });
        }
        expect(yield* fs.readFileString(legacy)).toBe(previousContent);
      }).pipe(Effect.scoped),
  );

  unix("links the launcher onto PATH and removes only that link", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const home = yield* fs.makeTempDirectoryScoped();
      const command = yield* commandIn({ home });
      const link = path.join(home, ".local", "bin", "scient");

      expect(yield* command.state).toEqual({
        supported: true,
        installedPath: null,
        legacyInstalled: false,
        onPath: false,
      });
      // Install writes the launcher itself, even when no local backend ever did.
      const installed = yield* command.install;
      expect(installed.installedPath).toBe(link);
      expect(yield* fs.readLink(link)).toBe(path.join(home, ".scient-next", "bin", "scient"));
      expect(yield* fs.exists(path.join(home, ".scient-next", "bin", "t3"))).toBe(false);
      expect((yield* command.install).installedPath).toBe(link);

      expect((yield* command.uninstall).installedPath).toBeNull();
      expect(yield* fs.exists(link)).toBe(false);
      // The launcher itself stays for setup commands.
      expect(yield* fs.exists(path.join(home, ".scient-next", "bin", "scient"))).toBe(true);
    }).pipe(Effect.scoped),
  );

  unix("upgrades an owned t3 shortcut without breaking it or claiming another t3", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const home = yield* fs.makeTempDirectoryScoped();
      const oldLauncher = path.join(home, ".scient-next", "bin", "t3");
      const oldLink = path.join(home, ".local", "bin", "t3");
      const unrelated = path.join(home, "bin", "t3");
      yield* fs.makeDirectory(path.dirname(oldLauncher), { recursive: true });
      yield* fs.writeFileString(oldLauncher, `#!/bin/sh\n# ${DesktopCliShim.MARKER}\nexit 127\n`);
      yield* fs.makeDirectory(path.dirname(oldLink), { recursive: true });
      yield* fs.symlink(oldLauncher, oldLink);
      yield* fs.makeDirectory(path.dirname(unrelated), { recursive: true });
      yield* fs.writeFileString(unrelated, "upstream t3\n");
      const command = yield* commandIn({ home });

      expect((yield* command.state).installedPath).toBeNull();
      expect((yield* command.state).legacyInstalled).toBe(true);
      expect((yield* command.install).installedPath).toBe(
        path.join(home, ".local", "bin", "scient"),
      );
      expect(yield* fs.readLink(oldLink)).toBe(oldLauncher);
      expect(yield* fs.readFileString(unrelated)).toBe("upstream t3\n");

      yield* command.uninstall;
      expect(yield* fs.exists(oldLink)).toBe(false);
      expect(yield* fs.readFileString(unrelated)).toBe("upstream t3\n");
    }).pipe(Effect.scoped),
  );

  unix("leaves a foreign legacy launcher untouched", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const home = yield* fs.makeTempDirectoryScoped();
      const legacy = path.join(home, ".scient-next", "bin", "t3");
      yield* fs.makeDirectory(path.dirname(legacy), { recursive: true });
      yield* fs.writeFileString(legacy, "someone else's launcher\n");
      const command = yield* commandIn({ home });
      expect((yield* command.install).installedPath).not.toBeNull();
      expect(yield* fs.readFileString(legacy)).toBe("someone else's launcher\n");
    }).pipe(Effect.scoped),
  );

  unix("retains removable legacy state and execution when a foreign file blocks scient", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const home = yield* fs.makeTempDirectoryScoped();
      const baseDir = path.join(home, ".scient-next");
      const canonical = path.join(baseDir, "bin", "scient");
      const previous = path.join(home, "previous", "bin", "t3");
      const link = path.join(home, ".local", "bin", "t3");
      const serverRoot = yield* fixtureServer(path.join(home, "app"), "fallback");
      yield* fs.makeDirectory(path.dirname(canonical), { recursive: true });
      yield* fs.makeDirectory(path.dirname(previous), { recursive: true });
      yield* fs.makeDirectory(path.dirname(link), { recursive: true });
      yield* fs.writeFileString(canonical, "foreign scient\n");
      yield* fs.writeFileString(previous, `#!/bin/sh\n# ${DesktopCliShim.MARKER}\nexit 127\n`, {
        mode: 0o755,
      });
      yield* fs.symlink(previous, link);
      const command = yield* commandIn({ home, baseDir, serverRoot });
      expect((yield* Effect.flip(command.install)).message).toContain(
        "Could not set up the scient launcher",
      );
      expect(yield* fs.readFileString(canonical)).toBe("foreign scient\n");
      const args = ["app", "quote ' and spaces", ""];
      expect(yield* executeShortcut(link, args)).toEqual({
        revision: "fallback",
        home: baseDir,
        cli: path.join(baseDir, "bin", "t3"),
        args,
      });
      expect(yield* command.state).toEqual({
        supported: true,
        installedPath: null,
        legacyInstalled: true,
        onPath: false,
      });
      expect((yield* command.uninstall).legacyInstalled).toBe(false);
      expect(yield* fs.exists(link)).toBe(false);
      expect(yield* fs.readFileString(canonical)).toBe("foreign scient\n");
    }).pipe(Effect.scoped),
  );

  unix(
    "leaves a previous-profile legacy shortcut executable when both current launchers collide",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const home = yield* fs.makeTempDirectoryScoped();
        const previousBase = path.join(home, "previous");
        const previous = path.join(previousBase, "bin", "t3");
        const link = path.join(home, ".local", "bin", "t3");
        const serverRoot = yield* fixtureServer(path.join(home, "previous app"), "previous");
        yield* fs.makeDirectory(path.dirname(previous), { recursive: true });
        yield* fs.writeFileString(
          previous,
          DesktopCliShim.renderCliShim({
            target: {
              kind: "direct",
              executable: process.execPath,
              entry: path.join(serverRoot, "apps/server/dist/bin.mjs"),
            },
            shimPath: previous,
            t3Home: previousBase,
          }),
          { mode: 0o755 },
        );
        yield* fs.makeDirectory(path.dirname(link), { recursive: true });
        yield* fs.symlink(previous, link);
        const baseDir = path.join(home, "current");
        const bin = path.join(baseDir, "bin");
        yield* fs.makeDirectory(bin, { recursive: true });
        yield* fs.writeFileString(path.join(bin, "scient"), "foreign canonical\n");
        yield* fs.writeFileString(path.join(bin, "t3"), "foreign legacy\n");
        const command = yield* commandIn({ home, baseDir });
        yield* Effect.flip(command.install);
        expect(yield* fs.readLink(link)).toBe(previous);
        const args = ["app", "still 'usable'", ""];
        expect(yield* executeShortcut(link, args)).toEqual({
          revision: "previous",
          home: previousBase,
          cli: previous,
          args,
        });
        expect((yield* command.state).legacyInstalled).toBe(true);
        expect(yield* fs.readFileString(path.join(bin, "scient"))).toBe("foreign canonical\n");
        expect(yield* fs.readFileString(path.join(bin, "t3"))).toBe("foreign legacy\n");
      }).pipe(Effect.scoped),
  );

  unix(
    "keeps the old executable launcher when preparation, publication, or ownership reads fail",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        for (const failure of ["prepare", "publish", "read"]) {
          const home = yield* fs.makeTempDirectoryScoped();
          const baseDir = path.join(home, "profile");
          const oldRoot = yield* fixtureServer(path.join(home, "old app"), "old");
          const command = yield* commandIn({ home, baseDir, serverRoot: oldRoot });
          const link = (yield* command.install).installedPath!;
          const launcher = yield* fs.readLink(link);
          const newRoot = yield* fixtureServer(path.join(home, "new app"), "new");
          const installed = yield* DesktopCliShim.install.pipe(
            Effect.provideService(
              DesktopEnvironment.DesktopEnvironment,
              environmentFor(path, { home, baseDir, serverRoot: newRoot }),
            ),
            Effect.provideService(FileSystem.FileSystem, {
              ...fs,
              readFileString: (target, encoding) =>
                failure === "read" && target === launcher
                  ? fs.readFileString(path.join(home, "missing"))
                  : fs.readFileString(target, encoding),
              writeFileString: (target, content, options) =>
                failure === "prepare" && path.basename(target) === "scient"
                  ? fs.writeFileString(path.join(home, "missing", "scient"), content, options)
                  : fs.writeFileString(target, content, options),
              rename: (from, to) =>
                failure === "publish" && to === launcher
                  ? fs.rename(path.join(home, "missing"), path.join(home, "unused"))
                  : fs.rename(from, to),
            }),
          );
          expect(Option.isNone(installed)).toBe(true);
          const args = ["app", "old 'quoted' arguments", ""];
          expect(yield* executeShortcut(link, args)).toEqual({
            revision: "old",
            home: baseDir,
            cli: launcher,
            args,
          });
        }
      }).pipe(Effect.scoped),
  );

  unix("does not recreate legacy shortcuts when startup refresh overlaps removal", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const home = yield* fs.makeTempDirectoryScoped();
      const oldBase = path.join(home, "old");
      const previous = path.join(oldBase, "bin", "t3");
      const link = path.join(home, ".local", "bin", "t3");
      yield* fs.makeDirectory(path.dirname(previous), { recursive: true });
      yield* fs.writeFileString(previous, `#!/bin/sh\n# ${DesktopCliShim.MARKER}\nexit 127\n`, {
        mode: 0o755,
      });
      yield* fs.makeDirectory(path.dirname(link), { recursive: true });
      yield* fs.symlink(previous, link);
      const baseDir = path.join(home, "current");
      const publicationStarted = yield* Deferred.make<void>();
      const releasePublication = yield* Deferred.make<void>();
      const environment = environmentFor(path, { home, baseDir });
      const refresh = yield* DesktopCliShim.install.pipe(
        Effect.provideService(DesktopEnvironment.DesktopEnvironment, environment),
        Effect.provideService(FileSystem.FileSystem, {
          ...fs,
          rename: (from, to) =>
            to === link
              ? Deferred.succeed(publicationStarted, undefined).pipe(
                  Effect.andThen(Deferred.await(releasePublication)),
                  Effect.andThen(fs.rename(from, to)),
                )
              : fs.rename(from, to),
        }),
        Effect.forkChild({ startImmediately: true }),
      );
      yield* Deferred.await(publicationStarted);
      const command = yield* commandIn({ home, baseDir });
      const removal = yield* command.uninstall.pipe(Effect.forkChild({ startImmediately: true }));
      yield* Deferred.succeed(releasePublication, undefined);
      yield* Fiber.join(refresh);
      expect((yield* Fiber.join(removal)).legacyInstalled).toBe(false);
      yield* DesktopCliShim.install.pipe(
        Effect.provideService(DesktopEnvironment.DesktopEnvironment, environment),
      );
      expect(yield* fs.exists(link)).toBe(false);
    }).pipe(Effect.scoped),
  );

  unix("refuses foreign files and broken symlinks at the internal launcher path", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      for (const brokenLink of [false, true]) {
        const home = yield* fs.makeTempDirectoryScoped();
        const launcher = path.join(home, ".scient-next", "bin", "scient");
        yield* fs.makeDirectory(path.dirname(launcher), { recursive: true });
        if (brokenLink) yield* fs.symlink(path.join(home, "missing"), launcher);
        else yield* fs.writeFileString(launcher, "foreign file\n");
        const command = yield* commandIn({ home });
        expect((yield* Effect.flip(command.install)).message).toContain(
          "Could not set up the scient launcher",
        );
        if (brokenLink) expect(yield* fs.readLink(launcher)).toBe(path.join(home, "missing"));
        else expect(yield* fs.readFileString(launcher)).toBe("foreign file\n");
      }
    }).pipe(Effect.scoped),
  );

  unix(
    "executes shortcuts through 40 install, reload, profile, update, and removal cycles",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const home = yield* fs.makeTempDirectoryScoped({ prefix: "scient cli quote ' space-" });
        const link = path.join(home, ".local", "bin", "scient");
        const legacyLink = path.join(home, ".local", "bin", "t3");
        const unrelated = path.join(home, "bin", "another-app");
        const legacy = path.join(home, "old profile", "bin", "t3");
        yield* fs.makeDirectory(path.dirname(legacy), { recursive: true });
        yield* fs.writeFileString(legacy, `#!/bin/sh\n# ${DesktopCliShim.MARKER}\nexit 127\n`, {
          mode: 0o755,
        });
        yield* fs.makeDirectory(path.dirname(legacyLink), { recursive: true });
        yield* fs.symlink(legacy, legacyLink);
        yield* fs.makeDirectory(path.dirname(unrelated), { recursive: true });
        yield* fs.writeFileString(unrelated, "unrelated app command\n");
        process.env.PATH = path.dirname(link);
        let legacyRemoved = false;
        for (let cycle = 0; cycle < 40; cycle += 1) {
          const baseDir = path.join(home, `profile-${cycle % 2}`);
          const serverRoot = yield* fixtureServer(path.join(home, `app-${cycle}`), `${cycle}`);
          const command = yield* commandIn({ home, baseDir, serverRoot });
          const installed = yield* command.install;
          expect(installed.installedPath).toBe(link);
          expect(installed.legacyInstalled).toBe(!legacyRemoved);
          const args = ["app", `cycle ${cycle} 'quoted'`, ""];
          const expected = { revision: `${cycle}`, home: baseDir, args };
          expect(yield* executeShortcut(link, args)).toEqual({
            ...expected,
            cli: path.join(baseDir, "bin", "scient"),
          });
          if (!legacyRemoved) {
            expect(yield* executeShortcut(legacyLink, args)).toEqual({
              ...expected,
              cli: path.join(baseDir, "bin", "t3"),
            });
          }
          const reloaded = yield* commandIn({ home, baseDir, serverRoot });
          expect(yield* reloaded.state).toEqual(installed);
          expect(yield* executeShortcut(link, args)).toEqual({
            ...expected,
            cli: path.join(baseDir, "bin", "scient"),
          });
          if (cycle % 4 === 3) {
            expect(yield* reloaded.uninstall).toEqual({
              supported: true,
              installedPath: null,
              legacyInstalled: false,
              onPath: false,
            });
            expect(yield* fs.exists(link)).toBe(false);
            expect(yield* fs.exists(legacyLink)).toBe(false);
            yield* DesktopCliShim.install.pipe(
              Effect.provideService(
                DesktopEnvironment.DesktopEnvironment,
                environmentFor(path, { home, baseDir, serverRoot }),
              ),
            );
            expect(yield* fs.exists(legacyLink)).toBe(false);
            legacyRemoved = true;
          }
          expect(yield* fs.readFileString(unrelated)).toBe("unrelated app command\n");
        }
      }).pipe(Effect.scoped),
    60_000,
  );

  unix("never replaces or removes a scient it did not create", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const home = yield* fs.makeTempDirectoryScoped();
      const command = yield* commandIn({ home });
      const theirs = path.join(home, ".local", "bin", "scient");
      yield* fs.makeDirectory(path.dirname(theirs), { recursive: true });
      yield* fs.writeFileString(theirs, "npm's t3\n");
      // Even a broken link in the next folder is someone else's.
      yield* fs.makeDirectory(path.join(home, "bin"), { recursive: true });
      yield* fs.symlink(path.join(home, "gone"), path.join(home, "bin", "scient"));

      const error = yield* Effect.flip(command.install);
      expect(error.message).toContain("Another scient command is already installed");
      yield* command.uninstall;
      expect(yield* fs.readFileString(theirs)).toBe("npm's t3\n");
      expect(yield* fs.readLink(path.join(home, "bin", "scient"))).toBe(path.join(home, "gone"));
    }).pipe(Effect.scoped),
  );

  unix("finds and removes a link left by a previous Scient home", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const home = yield* fs.makeTempDirectoryScoped();
      const before = yield* commandIn({ home, baseDir: path.join(home, "old-t3") });
      const link = (yield* before.install).installedPath;

      const after = yield* commandIn({ home, baseDir: path.join(home, "new-t3") });
      expect((yield* after.state).installedPath).toBe(link);
      // Installing again points the link at this home's launcher.
      expect((yield* after.install).installedPath).toBe(link);
      expect(yield* fs.readLink(link!)).toBe(path.join(home, "new-t3", "bin", "scient"));
      yield* after.uninstall;
      expect(yield* fs.exists(path.join(home, ".local", "bin", "scient"))).toBe(false);
      expect(yield* fs.exists(path.join(home, "bin", "scient"))).toBe(false);
    }).pipe(Effect.scoped),
  );

  unix("does not read a large binary another scient links to", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const home = yield* fs.makeTempDirectoryScoped();
      // A big executable that happens to contain the marker text is still not ours.
      const binary = path.join(home, "native-t3");
      yield* fs.writeFileString(binary, `${"\0".repeat(64 * 1024)}${DesktopCliShim.MARKER}`);
      yield* fs.makeDirectory(path.join(home, ".local", "bin"), { recursive: true });
      yield* fs.symlink(binary, path.join(home, ".local", "bin", "scient"));
      const command = yield* commandIn({ home });
      expect((yield* command.state).installedPath).toBeNull();
      yield* command.uninstall;
      expect(yield* fs.readLink(path.join(home, ".local", "bin", "scient"))).toBe(binary);
    }).pipe(Effect.scoped),
  );

  unix("preserves a previous-home shortcut when a foreign command rejects replacement", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const home = yield* fs.makeTempDirectoryScoped();
      const previousBase = path.join(home, "old-profile");
      const serverRoot = yield* fixtureServer(path.join(home, "old-app"), "old");
      const before = yield* commandIn({ home, baseDir: previousBase, serverRoot });
      const link = (yield* before.install).installedPath!;
      const previousTarget = yield* fs.readLink(link);
      const shadow = path.join(home, "shadow");
      yield* fs.makeDirectory(shadow);
      const foreign = path.join(shadow, "scient");
      yield* fs.writeFileString(foreign, "foreign command\n");
      process.env.PATH = [shadow, path.dirname(link)].join(":");
      const after = yield* commandIn({ home, baseDir: path.join(home, "new-profile") });
      expect((yield* Effect.flip(after.install)).message).toContain(foreign);
      expect(yield* fs.readLink(link)).toBe(previousTarget);
      const args = ["app", "old 'quoted' argument"];
      expect(yield* executeShortcut(link, args)).toEqual({
        revision: "old",
        home: previousBase,
        cli: previousTarget,
        args,
      });
      expect(yield* fs.readFileString(foreign)).toBe("foreign command\n");
    }).pipe(Effect.scoped),
  );

  unix("preserves executable shortcuts when replacement preparation or publication fails", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      for (const publication of [false, true]) {
        const home = yield* fs.makeTempDirectoryScoped();
        const previousBase = path.join(home, "old-profile");
        const serverRoot = yield* fixtureServer(path.join(home, "old-app"), "old");
        const before = yield* commandIn({ home, baseDir: previousBase, serverRoot });
        const link = (yield* before.install).installedPath!;
        const previousTarget = yield* fs.readLink(link);
        const after = yield* commandIn({ home, baseDir: path.join(home, "new-profile") }).pipe(
          Effect.provideService(FileSystem.FileSystem, {
            ...fs,
            symlink: (from, to) =>
              !publication && to.endsWith(`${path.sep}scient`) && to !== link
                ? fs.symlink(from, path.join(home, "missing", "scient"))
                : fs.symlink(from, to),
            rename: (from, to) =>
              publication && to === link
                ? fs.rename(path.join(home, "missing"), path.join(home, "unused"))
                : fs.rename(from, to),
          }),
        );
        expect((yield* Effect.flip(after.install)).message).toContain(`Could not replace ${link}`);
        expect(yield* fs.readLink(link)).toBe(previousTarget);
        const args = ["app", "old 'quoted' argument", ""];
        expect(yield* executeShortcut(link, args)).toEqual({
          revision: "old",
          home: previousBase,
          cli: previousTarget,
          args,
        });
        expect(yield* fs.readDirectory(path.dirname(link))).toEqual(["scient"]);
      }
    }).pipe(Effect.scoped),
  );

  unix("refuses to install behind another scient that runs first", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const home = yield* fs.makeTempDirectoryScoped();
      const shadow = path.join(home, "shadow");
      yield* fs.makeDirectory(shadow);
      const theirs = path.join(shadow, "scient");
      yield* fs.writeFileString(theirs, "#!/bin/sh\n", { mode: 0o755 });
      process.env.PATH = [shadow, path.join(home, ".local", "bin")].join(":");
      const command = yield* commandIn({ home });
      expect((yield* command.state).shadowedBy).toBe(theirs);
      expect((yield* Effect.flip(command.install)).message).toContain(theirs);
      expect(yield* fs.exists(path.join(home, ".local", "bin", "scient"))).toBe(false);
      yield* fs.remove(theirs);
      const installed = yield* command.install;
      expect(installed).toMatchObject({
        onPath: true,
        installedPath: path.join(home, ".local", "bin", "scient"),
      });
      expect(installed.shadowedBy).toBeUndefined();
    }).pipe(Effect.scoped),
  );

  it.effect("leaves the Windows PATH alone when it cannot be read", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const home = yield* fs.makeTempDirectoryScoped();
      const userPath = "C:\\Users\\Me\\npm;%USERPROFILE%\\tools";
      const { registry, spawner } = fakePowerShell(userPath);
      const command = yield* commandIn({ home, platform: "win32" }, spawner);

      registry.failReads = true;
      const error = yield* Effect.flip(command.install);
      expect(error.message).toContain("left unchanged");
      expect(registry).toMatchObject({ path: userPath, writes: 0 });

      registry.failReads = false;
      const launcherDir = DesktopCliShim.launcherPath(
        environmentFor(yield* Path.Path, {
          home,
          baseDir: `${home}/.scient-next`,
          platform: "win32",
        }),
      ).replace(/[\\/]scient\.cmd$/, "");
      yield* command.install;
      expect(registry.path).toBe(`${userPath};${launcherDir}`);
      yield* command.uninstall;
      expect(registry.path).toBe(userPath);
    }).pipe(Effect.scoped),
  );

  it.effect("upgrades an existing Windows PATH entry without changing it", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const home = yield* fs.makeTempDirectoryScoped();
      const baseDir = path.join(home, ".scient-next");
      const bin = path.join(baseDir, "bin");
      yield* fs.makeDirectory(bin, { recursive: true });
      const legacy = path.join(bin, "t3.cmd");
      yield* fs.writeFileString(legacy, `rem ${DesktopCliShim.MARKER}\r\n`);
      const { registry, spawner } = fakePowerShell(`C:\\Tools;${bin}`);
      const command = yield* commandIn({ home, platform: "win32" }, spawner);
      yield* fs.writeFileString(
        path.join(baseDir, "userdata", "cli-command-path-entry"),
        `${bin}\n`,
      );
      expect(yield* command.state).toEqual({
        supported: true,
        installedPath: null,
        legacyInstalled: true,
        onPath: false,
      });
      expect((yield* command.install).installedPath).toBe(path.join(bin, "scient.cmd"));
      expect(registry.writes).toBe(0);
      expect((yield* command.state).legacyInstalled).toBe(true);
      yield* command.uninstall;
      expect(registry.path).toBe("C:\\Tools");
      expect((yield* command.state).legacyInstalled).toBe(false);
    }).pipe(Effect.scoped),
  );

  it.effect("does not claim or remove a Windows PATH entry the user added", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const home = yield* fs.makeTempDirectoryScoped();
      const launcherDir = path.dirname(
        DesktopCliShim.launcherPath(
          environmentFor(path, {
            home,
            baseDir: path.join(home, ".scient-next"),
            platform: "win32",
          }),
        ),
      );
      const userPath = `C:\\Tools;${launcherDir}`;
      const { registry, spawner } = fakePowerShell(userPath);
      const command = yield* commandIn({ home, platform: "win32" }, spawner);
      yield* fs.makeDirectory(launcherDir, { recursive: true });
      const legacy = path.join(launcherDir, "t3.cmd");
      yield* fs.writeFileString(legacy, `rem ${DesktopCliShim.MARKER}\r\n`);
      yield* command.install;

      expect(yield* command.state).toEqual({
        supported: true,
        installedPath: null,
        legacyInstalled: false,
        onPath: false,
      });
      yield* command.uninstall;
      expect(registry.path).toBe(userPath);
      expect(registry.writes).toBe(0);
      expect(yield* fs.exists(legacy)).toBe(true);
    }).pipe(Effect.scoped),
  );

  it.effect(
    "does not reclaim a user-added Windows PATH entry after removing an absent owned entry",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const home = yield* fs.makeTempDirectoryScoped();
        const userPath = "C:\\Tools;%USERPROFILE%\\tools";
        const { registry, spawner } = fakePowerShell(userPath);
        const command = yield* commandIn({ home, platform: "win32" }, spawner);
        const installed = yield* command.install;
        const bin = path.dirname(installed.installedPath!);

        // An external PATH edit removes our entry before Settings Remove runs.
        registry.path = userPath;
        yield* command.uninstall;
        // A later user edit is theirs, not a resurrection of our ownership.
        const userAddedPath = `${userPath};${bin}`;
        registry.path = userAddedPath;
        expect(yield* command.state).toEqual({
          supported: true,
          installedPath: null,
          legacyInstalled: false,
          onPath: false,
        });
        yield* command.uninstall;
        expect(registry.path).toBe(userAddedPath);
      }).pipe(Effect.scoped),
  );

  it.effect("offers nothing for a development build", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const command = yield* commandIn({
        home: yield* fs.makeTempDirectoryScoped(),
        isPackaged: false,
      });
      expect(yield* command.state).toEqual({
        supported: false,
        installedPath: null,
        legacyInstalled: false,
        onPath: false,
      });
    }).pipe(Effect.scoped),
  );

  unix("does not let a development build remove packaged-app shortcuts", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const home = yield* fs.makeTempDirectoryScoped();
      const packaged = yield* commandIn({ home });
      const installed = yield* packaged.install;
      const dev = yield* commandIn({ home, isPackaged: false });
      expect((yield* dev.uninstall).supported).toBe(false);
      expect(yield* fs.exists(installed.installedPath!)).toBe(true);
    }).pipe(Effect.scoped),
  );

  it.effect(
    "retains owned Windows legacy removal when scient is blocked by a foreign launcher",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const home = yield* fs.makeTempDirectoryScoped();
        const baseDir = path.join(home, ".scient-next");
        const bin = path.join(baseDir, "bin");
        const { registry, spawner } = fakePowerShell(`C:\\Tools;${bin}`);
        const command = yield* commandIn({ home, platform: "win32" }, spawner);
        yield* fs.makeDirectory(bin, { recursive: true });
        yield* fs.writeFileString(path.join(bin, "scient.cmd"), "foreign scient\r\n");
        yield* fs.writeFileString(path.join(bin, "t3.cmd"), `rem ${DesktopCliShim.MARKER}\r\n`);
        yield* fs.writeFileString(
          path.join(baseDir, "userdata", "cli-command-path-entry"),
          `${bin}\n`,
        );
        yield* Effect.flip(command.install);
        expect(yield* command.state).toEqual({
          supported: true,
          installedPath: null,
          legacyInstalled: true,
          onPath: false,
        });
        registry.failReads = true;
        expect((yield* Effect.flip(command.uninstall)).message).toContain("left unchanged");
        expect(registry).toMatchObject({ path: `C:\\Tools;${bin}`, writes: 0 });
        registry.failReads = false;
        yield* command.uninstall;
        expect(registry.path).toBe("C:\\Tools");
        expect(yield* fs.readFileString(path.join(bin, "scient.cmd"))).toBe("foreign scient\r\n");
      }).pipe(Effect.scoped),
  );

  it.effect.skipIf(nativePlatform !== "win32")(
    "executes installed Windows scient and legacy launchers through update, profile, and removal cycles",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const home = yield* fs.makeTempDirectoryScoped({ prefix: "Scient José's CLI space-" });
        const { registry, spawner } = fakePowerShell("C:\\OtherApp");
        const args = ["app", "a project with spaces", 'single \' and "double" quotes', "", "José"];
        for (let cycle = 0; cycle < 40; cycle += 1) {
          const baseDir = path.join(home, `profile ${cycle % 2}`);
          const bin = path.join(baseDir, "bin");
          const serverRoot = yield* fixtureServer(
            path.join(home, `App (x86) ${cycle}`),
            `${cycle}`,
          );
          const command = yield* commandIn(
            { home, baseDir, platform: "win32", serverRoot },
            spawner,
          );
          if (cycle === 0) {
            yield* fs.makeDirectory(bin, { recursive: true });
            yield* fs.writeFileString(path.join(bin, "t3.cmd"), `rem ${DesktopCliShim.MARKER}\r\n`);
          }
          const installed = yield* command.install;
          expect(installed.installedPath).toBe(path.join(bin, "scient.cmd"));
          expect(yield* executeShortcut(installed.installedPath!, args)).toEqual({
            revision: `${cycle}`,
            home: baseDir,
            cli: path.join(bin, "scient.cmd"),
            args,
          });
          if (yield* fs.exists(path.join(bin, "t3.cmd"))) {
            expect(yield* executeShortcut(path.join(bin, "t3.cmd"), args)).toEqual({
              revision: `${cycle}`,
              home: baseDir,
              cli: path.join(bin, "t3.cmd"),
              args,
            });
          }
          const reloaded = yield* commandIn(
            { home, baseDir, platform: "win32", serverRoot },
            spawner,
          );
          expect(yield* reloaded.state).toEqual(installed);
          yield* reloaded.uninstall;
          expect(yield* reloaded.state).toEqual({
            supported: true,
            installedPath: null,
            legacyInstalled: false,
            onPath: false,
          });
          expect(registry.path).toBe("C:\\OtherApp");
        }
      }).pipe(Effect.scoped),
    60_000,
  );
});
