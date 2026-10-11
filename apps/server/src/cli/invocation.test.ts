import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import {
  resolveCliCommand,
  resolveRootCliCommand,
  resolveServerInstallation,
} from "./invocation.ts";

const nativePlatform = Effect.runSync(HostProcess.Platform);

it.layer(NodeServices.layer)("operational CLI commands", (it) => {
  const fixture = Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const root = yield* fs.makeTempDirectoryScoped();
    const bin = path.join(root, "tools");
    const runtime = path.join(root, "private Node's location", "node");
    yield* fs.makeDirectory(bin);
    yield* fs.makeDirectory(path.dirname(runtime));
    yield* fs.symlink(process.execPath, runtime);
    for (const name of ["scient", "t3", "npx", "npm", "pnpm", "bunx"]) {
      yield* fs.writeFileString(path.join(bin, name), "#!/bin/sh\nexit 70\n", { mode: 0o755 });
    }
    // Emulate sudo's HOME/PATH reset without invoking root or changing a profile.
    yield* fs.writeFileString(
      path.join(bin, "sudo"),
      '#!/bin/sh\nHOME=/synthetic-root\nPATH="$SCIENT_TEST_ROOT_PATH"\nexport HOME PATH\nexec "$@"\n',
      { mode: 0o755 },
    );
    const run = (command: string) =>
      spawner.string(
        ChildProcess.make("/bin/sh", ["-c", command], {
          env: {
            PATH: bin,
            HOME: "/synthetic-user",
            SCIENT_TEST_ROOT_PATH: `${bin}:/usr/bin:/bin`,
          },
          extendEnv: false,
          stdin: "ignore",
        }),
      );
    return { fs, path, root, runtime, run };
  });

  it.effect.skipIf(nativePlatform === "win32")(
    "executes the running global or cached package with private Node and no CLI or npm on PATH",
    () =>
      Effect.gen(function* () {
        const { fs, path, root, runtime, run } = yield* fixture;
        const profile = path.join(root, "Scient profile's data");
        for (const relative of [
          "global/lib/node_modules/t3/dist/bin.mjs",
          "npm/_npx/hash/node_modules/t3/dist/bin.mjs",
          "pnpm/dlx/hash/node_modules/t3/dist/bin.mjs",
          ".bun/install/cache/t3/dist/bin.mjs",
        ]) {
          const entry = path.join(root, "entry's cache", relative);
          yield* fs.makeDirectory(path.dirname(entry), { recursive: true });
          yield* fs.writeFileString(
            entry,
            "console.log(JSON.stringify({entry:process.argv[1],args:process.argv.slice(2),execArgv:process.execArgv,home:process.env.HOME}));",
          );
          const resolve = (args: ReadonlyArray<string>, asRoot = false) =>
            (asRoot ? resolveRootCliCommand(args) : resolveCliCommand(args)).pipe(
              Effect.provideService(HostProcess.ExecutablePath, runtime),
              Effect.provideService(HostProcess.Arguments, [runtime, entry]),
              Effect.provideService(HostProcess.Environment, {}),
              Effect.provideService(HostProcess.IsExecutable, false),
              Effect.provideService(HostProcess.Platform, "linux"),
            );
          const args = ["browser", "setup", "--base-dir", profile];
          const command = yield* resolve(args, true);
          expect(JSON.parse(yield* run(command))).toEqual({
            entry,
            args,
            execArgv: [],
            home: "/synthetic-root",
          });
          const userCommand = yield* resolve(["serve", "--base-dir", profile]);
          expect(JSON.parse(yield* run(userCommand))).toEqual({
            entry,
            args: ["serve", "--base-dir", profile],
            execArgv: [],
            home: "/synthetic-user",
          });
        }
      }).pipe(Effect.scoped),
  );

  it.effect.skipIf(nativePlatform === "win32")(
    "executes canonical and legacy packaged launchers instead of an unrelated PATH command",
    () =>
      Effect.gen(function* () {
        const { fs, path, root, runtime, run } = yield* fixture;
        const args = ["browser", "setup", "--base-dir", path.join(root, "profile with spaces")];
        for (const name of ["scient", "t3"]) {
          const shim = path.join(root, "packaged app's bin", name);
          yield* fs.makeDirectory(path.dirname(shim), { recursive: true });
          yield* fs.writeFileString(shim, '#!/bin/sh\nprintf "%s\\n" "$@"\n', { mode: 0o755 });
          const command = yield* resolveRootCliCommand(args).pipe(
            Effect.provideService(HostProcess.ExecutablePath, runtime),
            Effect.provideService(HostProcess.Arguments, [runtime, "/not-the-packaged-entry.mjs"]),
            Effect.provideService(HostProcess.Environment, { T3CODE_CLI_PATH: shim }),
            Effect.provideService(HostProcess.IsExecutable, false),
            Effect.provideService(HostProcess.Platform, "linux"),
          );
          expect((yield* run(command)).trim().split("\n")).toEqual(args);
        }
      }).pipe(Effect.scoped),
  );

  it.effect.skipIf(nativePlatform === "win32")(
    "falls back from a stale or unusable launcher and restores Electron Node mode under sudo",
    () =>
      Effect.gen(function* () {
        const { fs, path, root, runtime, run } = yield* fixture;
        const entry = path.join(root, "entry.mjs");
        yield* fs.writeFileString(
          entry,
          "console.log(JSON.stringify({args:process.argv.slice(2),nodeMode:process.env.ELECTRON_RUN_AS_NODE}));",
        );
        const nonExecutable = path.join(root, "not-executable");
        yield* fs.writeFileString(nonExecutable, "not a launcher", { mode: 0o644 });
        for (const shim of [path.join(root, "gone"), root, nonExecutable, "scient"]) {
          const command = yield* resolveRootCliCommand(["browser", "setup"]).pipe(
            Effect.provideService(HostProcess.ExecutablePath, runtime),
            Effect.provideService(HostProcess.Arguments, [runtime, entry]),
            Effect.provideService(HostProcess.Environment, {
              T3CODE_CLI_PATH: shim,
              ELECTRON_RUN_AS_NODE: "1",
            }),
            Effect.provideService(HostProcess.IsExecutable, false),
            Effect.provideService(HostProcess.Platform, "linux"),
          );
          expect(JSON.parse(yield* run(command))).toEqual({
            args: ["browser", "setup"],
            nodeMode: "1",
          });
        }
      }).pipe(Effect.scoped),
  );

  it.effect.skipIf(nativePlatform === "win32")(
    "executes a standalone installation's own binary",
    () =>
      Effect.gen(function* () {
        const { fs, path, root, run } = yield* fixture;
        const executable = path.join(root, "standalone scient");
        yield* fs.writeFileString(executable, '#!/bin/sh\nprintf "%s\\n" "$@"\n', { mode: 0o755 });
        const command = yield* resolveRootCliCommand(["browser", "setup"]).pipe(
          Effect.provideService(HostProcess.ExecutablePath, executable),
          Effect.provideService(HostProcess.Arguments, [executable, "not-an-entry-script"]),
          Effect.provideService(HostProcess.Environment, {}),
          Effect.provideService(HostProcess.IsExecutable, true),
          Effect.provideService(HostProcess.Platform, "linux"),
        );
        expect((yield* run(command)).trim().split("\n")).toEqual(["browser", "setup"]);
      }).pipe(Effect.scoped),
  );

  it.effect.skipIf(nativePlatform !== "win32")(
    "executes direct and packaged commands through native PowerShell with quoted profile paths",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
        const root = yield* fs.makeTempDirectoryScoped();
        const entry = path.join(root, "Scient's cache 終", "entry.mjs");
        const profile = path.join(root, "Scient's profile 終");
        yield* fs.makeDirectory(path.dirname(entry), { recursive: true });
        yield* fs.writeFileString(
          entry,
          "console.log(JSON.stringify({args:process.argv.slice(2),nodeMode:process.env.ELECTRON_RUN_AS_NODE}).replaceAll('終', '\\\\u7d42'));",
        );
        const shim = path.join(root, "Scient's launcher 終.cmd");
        yield* fs.writeFileString(
          shim,
          [
            "@echo off",
            "setlocal EnableExtensions DisableDelayedExpansion",
            `for /f "tokens=2 delims=:." %%c in ('chcp') do set "original_codepage=%%c"`,
            "chcp 65001 >nul",
            `set "ELECTRON_RUN_AS_NODE=1"`,
            `"${process.execPath}" "${entry}" %*`,
            `set "result=%ERRORLEVEL%"`,
            "chcp %original_codepage% >nul",
            "exit /b %result%",
            "",
          ].join("\r\n"),
        );
        const args = ["serve", "--base-dir", profile];
        for (const launcher of [undefined, shim]) {
          const command = yield* resolveCliCommand(args).pipe(
            Effect.provideService(HostProcess.ExecutablePath, process.execPath),
            Effect.provideService(HostProcess.Arguments, [process.execPath, entry]),
            Effect.provideService(HostProcess.Environment, {
              ELECTRON_RUN_AS_NODE: "1",
              ...(launcher ? { T3CODE_CLI_PATH: launcher } : {}),
            }),
            Effect.provideService(HostProcess.IsExecutable, false),
            Effect.provideService(HostProcess.Platform, "win32"),
          );
          const output = yield* spawner.string(
            ChildProcess.make("powershell.exe", [
              "-NoProfile",
              "-NonInteractive",
              "-Command",
              command,
            ]),
          );
          expect(JSON.parse(output)).toEqual({ args, nodeMode: "1" });
        }
      }).pipe(Effect.scoped),
  );
});

it.layer(NodeServices.layer)("manual server installation ownership", (it) => {
  it.effect("recognizes runner caches for both script and executable packages", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped();
      for (const [relative, kind] of [
        ["npm/_npx/hash/node_modules/t3/dist/bin.mjs", "npx"],
        ["npm/_npx/hash/node_modules/@t3code/t3-linux-x64/t3", "npx"],
        ["pnpm/dlx/hash/node_modules/t3/dist/bin.mjs", "pnpm-dlx"],
        [".bun/install/cache/t3/dist/bin.mjs", "bunx"],
      ] as const) {
        const entry = path.join(root, relative);
        yield* fs.makeDirectory(path.dirname(entry), { recursive: true });
        yield* fs.writeFileString(entry, "");
        const installation = yield* resolveServerInstallation.pipe(
          Effect.provideService(HostProcess.Arguments, ["node", entry]),
          Effect.provideService(HostProcess.ExecutablePath, entry),
          Effect.provideService(HostProcess.IsExecutable, entry.endsWith("/t3")),
        );
        expect(installation).toEqual({ kind });
      }
    }),
  );

  it.effect("requires the npm prefix's bin to point to the running package", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped();
      const prefix = path.join(root, "bunx-tools");
      const packageRoot = path.join(prefix, "lib/node_modules/t3");
      const entry = path.join(packageRoot, "dist/bin.mjs");
      const globalBin = path.join(prefix, "bin/t3");
      yield* fs.makeDirectory(path.dirname(entry), { recursive: true });
      yield* fs.makeDirectory(path.dirname(globalBin), { recursive: true });
      yield* fs.writeFileString(entry, "");
      yield* fs.writeFileString(
        path.join(packageRoot, "package.json"),
        '{"name":"t3","version":"0.0.45","bin":{"t3":"./dist/bin.mjs"}}',
      );
      const resolve = resolveServerInstallation.pipe(
        Effect.provideService(HostProcess.Arguments, ["node", entry]),
        Effect.provideService(HostProcess.IsExecutable, false),
        Effect.provideService(HostProcess.Platform, "linux"),
      );
      expect(yield* resolve).toBeNull();
      yield* fs.symlink(entry, globalBin);
      const canonicalPrefix = yield* fs.realPath(prefix);
      expect(yield* resolve).toEqual({ kind: "npm-global", prefix: canonicalPrefix });
      yield* fs.remove(globalBin);
      yield* fs.writeFileString(globalBin, "an unrelated t3 command");
      expect(yield* resolve).toBeNull();
      expect(yield* resolve.pipe(Effect.provideService(HostProcess.Platform, "win32"))).toBeNull();
    }),
  );

  it.effect("proves the native executable belongs to the npm launcher", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped();
      const prefix = path.join(root, "bunx-tools");
      const packageRoot = path.join(prefix, "lib/node_modules/t3");
      const launcher = path.join(packageRoot, "bin/t3.js");
      const entry = path.join(packageRoot, "node_modules/@t3code/t3-linux-x64/t3");
      yield* fs.makeDirectory(path.dirname(launcher), { recursive: true });
      yield* fs.makeDirectory(path.dirname(entry), { recursive: true });
      yield* fs.makeDirectory(path.join(prefix, "bin"));
      yield* fs.writeFileString(launcher, "");
      yield* fs.writeFileString(entry, "");
      yield* fs.writeFileString(
        path.join(packageRoot, "package.json"),
        '{"name":"t3","version":"0.0.45","bin":{"t3":"./bin/t3.js"},"optionalDependencies":{"@t3code/t3-linux-x64":"0.0.45"}}',
      );
      yield* fs.symlink(launcher, path.join(prefix, "bin/t3"));
      const canonicalPrefix = yield* fs.realPath(prefix);
      const resolve = resolveServerInstallation.pipe(
        Effect.provideService(HostProcess.ExecutablePath, entry),
        Effect.provideService(HostProcess.IsExecutable, true),
        Effect.provideService(HostProcess.Platform, "linux"),
      );
      for (const [version, expected] of [
        ["0.0.44", null],
        ["0.0.45", { kind: "npm-global", prefix: canonicalPrefix }],
      ]) {
        yield* fs.writeFileString(
          path.join(path.dirname(entry), "package.json"),
          `{"name":"@t3code/t3-linux-x64","version":"${version}"}`,
        );
        expect(yield* resolve).toEqual(expected);
      }
    }),
  );

  it.effect("leaves local, standalone, missing and unreadable installs unknown", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped();
      for (const relative of [
        "project/node_modules/t3/dist/bin.mjs",
        "project/apps/server/dist/bin.mjs",
        ".t3/runtime/0.0.45/t3",
        "missing/dist/bin.mjs",
      ]) {
        const entry = path.join(root, relative);
        if (!relative.startsWith("missing")) {
          yield* fs.makeDirectory(path.dirname(entry), { recursive: true });
          yield* fs.writeFileString(entry, "");
        }
        expect(
          yield* resolveServerInstallation.pipe(
            Effect.provideService(HostProcess.Arguments, ["node", entry]),
            Effect.provideService(HostProcess.IsExecutable, false),
          ),
        ).toBeNull();
      }
    }),
  );
});
