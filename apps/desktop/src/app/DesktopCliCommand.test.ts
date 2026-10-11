import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
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

it.layer(NodeServices.layer)("DesktopCliCommand", (it) => {
  it.effect(
    "executes the installed scient and upgraded t3 shortcuts with the same profile and arguments",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
        const home = yield* fs.makeTempDirectoryScoped({ prefix: "Scient's CLI space-" });
        const baseDir = path.join(home, ".scient-next");
        const serverRoot = path.join(home, "Scient App");
        const entry = path.join(serverRoot, "apps/server/dist/bin.mjs");
        yield* fs.makeDirectory(path.dirname(entry), { recursive: true });
        yield* fs.writeFileString(
          entry,
          "console.log(JSON.stringify({home:process.env.SCIENT_NEXT_HOME,cli:process.env.T3CODE_CLI_PATH,args:process.argv.slice(2)}));",
        );
        const legacy = path.join(baseDir, "bin", "t3");
        yield* fs.makeDirectory(path.dirname(legacy), { recursive: true });
        yield* fs.writeFileString(legacy, `#!/bin/sh\n# ${DesktopCliShim.MARKER}\nexit 127\n`);
        const oldLink = path.join(home, ".local/bin/t3");
        yield* fs.makeDirectory(path.dirname(oldLink), { recursive: true });
        yield* fs.symlink(legacy, oldLink);
        const command = yield* commandIn({ home, serverRoot });
        const installed = yield* command.install;
        const args = ["app", "a project with spaces and 'quotes'", ""];
        for (const launcher of [installed.installedPath!, oldLink]) {
          const output = yield* spawner.string(
            ChildProcess.make(launcher, args, {
              env: { SCIENT_NEXT_HOME: "", T3CODE_HOME: "/unrelated-t3-profile" },
              extendEnv: true,
            }),
          );
          expect(JSON.parse(output)).toEqual({
            home: baseDir,
            cli: launcher === oldLink ? legacy : path.join(baseDir, "bin", "scient"),
            args,
          });
        }
      }).pipe(Effect.scoped),
  );

  it.effect("links the launcher onto PATH and removes only that link", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const home = yield* fs.makeTempDirectoryScoped();
      const command = yield* commandIn({ home });
      const link = path.join(home, ".local", "bin", "scient");

      expect(yield* command.state).toEqual({ supported: true, installedPath: null, onPath: false });
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

  it.effect("upgrades an owned t3 shortcut without breaking it or claiming another t3", () =>
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
      expect((yield* command.install).installedPath).toBe(
        path.join(home, ".local", "bin", "scient"),
      );
      expect(yield* fs.readLink(oldLink)).toBe(oldLauncher);
      const legacy = yield* fs.readFileString(oldLauncher);
      expect(legacy).toContain("SCIENT_NEXT_HOME");
      expect(legacy).toContain("/apps/server/dist/bin.mjs");
      expect(legacy).toContain(oldLauncher);
      expect(yield* fs.readFileString(unrelated)).toBe("upstream t3\n");

      yield* command.uninstall;
      expect(yield* fs.exists(oldLink)).toBe(false);
      expect(yield* fs.readFileString(unrelated)).toBe("upstream t3\n");
    }).pipe(Effect.scoped),
  );

  it.effect("leaves a foreign legacy launcher untouched", () =>
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

  it.effect("refreshes the owned legacy launcher when a foreign file blocks scient", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const home = yield* fs.makeTempDirectoryScoped();
      const baseDir = path.join(home, ".scient-next");
      const canonical = path.join(baseDir, "bin", "scient");
      const legacy = path.join(baseDir, "bin", "t3");
      yield* fs.makeDirectory(path.dirname(canonical), { recursive: true });
      yield* fs.writeFileString(canonical, "foreign scient\n");
      yield* fs.writeFileString(legacy, `#!/bin/sh\n# ${DesktopCliShim.MARKER}\nexit 127\n`);
      const command = yield* commandIn({ home });
      expect((yield* Effect.flip(command.install)).message).toContain(
        "Could not set up the scient launcher",
      );
      expect(yield* fs.readFileString(canonical)).toBe("foreign scient\n");
      const refreshed = yield* fs.readFileString(legacy);
      expect(refreshed).toContain("/apps/server/dist/bin.mjs");
      expect(refreshed).toContain(`export T3CODE_CLI_PATH='${legacy}'`);
      const backendLauncher = yield* DesktopCliShim.install.pipe(
        Effect.provideService(
          DesktopEnvironment.DesktopEnvironment,
          environmentFor(path, { home, baseDir }),
        ),
      );
      expect(Option.getOrNull(backendLauncher)).toBe(legacy);
      expect((yield* command.state).installedPath).toBeNull();
    }).pipe(Effect.scoped),
  );

  it.effect("refuses foreign files and broken symlinks at the internal launcher path", () =>
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

  it.effect("survives repeated install, reload, home change, and removal", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const home = yield* fs.makeTempDirectoryScoped({ prefix: "scient cli quote ' space-" });
      const link = path.join(home, ".local", "bin", "scient");
      for (let cycle = 0; cycle < 40; cycle += 1) {
        const baseDir = path.join(home, `profile-${cycle % 2}`);
        const command = yield* commandIn({ home, baseDir });
        const installed = yield* command.install;
        expect(installed.installedPath).toBe(link);
        expect(yield* fs.readLink(link)).toBe(path.join(baseDir, "bin", "scient"));
        expect((yield* command.install).installedPath).toBe(link);
        const reloaded = yield* commandIn({ home, baseDir });
        expect(yield* reloaded.state).toEqual(installed);
        if (cycle % 4 === 3) {
          expect((yield* reloaded.uninstall).installedPath).toBeNull();
          expect((yield* reloaded.uninstall).installedPath).toBeNull();
        }
      }
    }).pipe(Effect.scoped),
  );

  it.effect("never replaces or removes a scient it did not create", () =>
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

  it.effect("finds and removes a link left by a previous Scient home", () =>
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

  it.effect("does not read a large binary another scient links to", () =>
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

  it.effect("reports when another scient earlier on PATH would run instead", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const home = yield* fs.makeTempDirectoryScoped();
      const shadow = path.join(home, "shadow");
      yield* fs.makeDirectory(shadow);
      yield* fs.writeFileString(path.join(shadow, "scient"), "#!/bin/sh\n", { mode: 0o755 });
      const previous = process.env.PATH;
      process.env.PATH = [shadow, path.join(home, ".local", "bin")].join(":");
      yield* Effect.addFinalizer(() => Effect.sync(() => (process.env.PATH = previous)));

      const command = yield* commandIn({ home });
      const installed = yield* command.install;
      expect(installed.installedPath).toBe(path.join(home, ".local", "bin", "scient"));
      expect(installed.onPath).toBe(false);
      yield* fs.remove(path.join(shadow, "scient"));
      expect((yield* command.state).onPath).toBe(true);
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
      expect((yield* command.install).installedPath).toBe(path.join(bin, "scient.cmd"));
      expect(registry.writes).toBe(0);
      expect(yield* fs.readFileString(legacy)).toContain("SCIENT_NEXT_HOME");
      expect(yield* fs.readFileString(legacy)).toContain("t3.cmd");
      yield* command.uninstall;
      expect(registry.path).toBe("C:\\Tools");
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

      expect((yield* command.state).installedPath).toBeNull();
      yield* command.uninstall;
      expect(registry.path).toBe(userPath);
    }).pipe(Effect.scoped),
  );

  it.effect("offers nothing for a development build", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const command = yield* commandIn({
        home: yield* fs.makeTempDirectoryScoped(),
        isPackaged: false,
      });
      expect((yield* command.state).supported).toBe(false);
    }).pipe(Effect.scoped),
  );

  it.effect("does not let a development build remove packaged-app shortcuts", () =>
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
});
