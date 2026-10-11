// @effect-diagnostics nodeBuiltinImport:off - Runs the rendered launcher in a real shell.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";

import { afterEach, describe, expect, it } from "vite-plus/test";

import { type CliShimTarget, renderCliShim } from "./DesktopCliShim.ts";

const nativePlatform = Effect.runSync(HostProcess.Platform);

const directories: Array<string> = [];
afterEach(() => {
  for (const directory of directories.splice(0)) {
    NodeFS.rmSync(directory, { recursive: true, force: true });
  }
});

const tempRoot = () => {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-cli-shim-"));
  directories.push(root);
  return root;
};

const writeExecutable = (path: string, content: string) => {
  NodeFS.mkdirSync(NodePath.dirname(path), { recursive: true });
  NodeFS.writeFileSync(path, content, { mode: 0o755 });
};

/** Writes a canonical launcher with a fixture profile, never the user's profile. */
const writeShim = (root: string, target: CliShimTarget) => {
  const shim = NodePath.join(root, "bin", "scient");
  writeExecutable(shim, renderCliShim({ target, shimPath: shim, t3Home: `${root}/home` }));
  return shim;
};

const run = (shim: string, args: ReadonlyArray<string>, env: NodeJS.ProcessEnv = {}) =>
  NodeChildProcess.spawnSync(shim, args, {
    encoding: "utf8",
    env: { PATH: process.env.PATH, ...env },
  });

/** An app executable that reports its environment and arguments. */
const REPORTER =
  '#!/bin/sh\necho "node=$ELECTRON_RUN_AS_NODE cli=$T3CODE_CLI_PATH home=$SCIENT_NEXT_HOME"\nprintf "%s\\n" "$@"\nexit 3\n';

/**
 * A stand-in AppImage whose image holds the reporter. `--appimage-mount`
 * prints the mount and stays up until killed, recording that it was; with
 * `canMount` false it fails like a host without FUSE. `--appimage-extract`
 * unpacks into ./squashfs-root.
 */
const fakeAppImage = (canMount = true) => {
  const root = tempRoot();
  const image = NodePath.join(root, "image");
  writeExecutable(NodePath.join(image, "t3code"), REPORTER);
  const appImage = NodePath.join(root, "T3 Code.AppImage");
  writeExecutable(
    appImage,
    [
      "#!/bin/sh",
      `if [ "$1" = --appimage-extract ]; then cp -R '${image}' squashfs-root; exit 0; fi`,
      '[ "$1" = --appimage-mount ] || exit 9',
      '[ -n "$APPIMAGE_EXTRACT_AND_RUN" ] && exit 8',
      canMount ? `echo '${image}'` : 'echo "Cannot mount AppImage"; exit 1',
      `trap 'touch "${root}/unmounted"; exit 0' TERM`,
      "while :; do sleep 0.05; done",
      "",
    ].join("\n"),
  );
  const shim = writeShim(root, { kind: "appimage", appImage, executableName: "t3code" });
  return { root, image, appImage, shim };
};

describe.skipIf(nativePlatform === "win32")("renderCliShim Unix execution", () => {
  it("runs the AppImage's bundled CLI with every argument and unmounts after", () => {
    const { root, image, shim } = fakeAppImage();
    const result = run(shim, ["browser", "setup", "a b"]);
    expect(result.status).toBe(3);
    expect(result.stdout.split("\n")).toEqual([
      `node=1 cli=${shim} home=${root}/home`,
      `${image}/resources/app.asar/apps/server/dist/bin.mjs`,
      "browser",
      "setup",
      "a b",
      "",
    ]);
    // The trap kills the mount helper as the launcher exits.
    NodeChildProcess.spawnSync("sh", [
      "-c",
      `i=0; while [ ! -e '${root}/unmounted' ] && [ $i -lt 40 ]; do sleep 0.05; i=$((i+1)); done`,
    ]);
    expect(NodeFS.existsSync(NodePath.join(root, "unmounted"))).toBe(true);
  });

  it("extracts the AppImage where it cannot be mounted", () => {
    const { shim } = fakeAppImage(false);
    // Extract-and-run is ignored too, so the runtime never starts the app.
    const result = run(shim, ["--version"], { APPIMAGE_EXTRACT_AND_RUN: "1" });
    expect(result.status).toBe(3);
    expect(result.stdout).toMatch(
      /squashfs-root\/resources\/app\.asar\/apps\/server\/dist\/bin\.mjs/,
    );
  });

  it("keeps the Scient install home under sudo and honors an explicit Scient override", () => {
    const root = tempRoot();
    writeExecutable(NodePath.join(root, "app"), REPORTER);
    const shim = writeShim(root, {
      kind: "direct",
      executable: NodePath.join(root, "app"),
      entry: "/bin.mjs",
    });
    // sudo clears the environment, so the launcher supplies its own.
    expect(run(shim, []).stdout).toContain(`home=${root}/home`);
    expect(run(shim, [], { SCIENT_NEXT_HOME: "/elsewhere" }).stdout).toContain("home=/elsewhere");
    // Ambient T3 state cannot redirect the Scient bundled launcher.
    expect(run(shim, [], { T3CODE_HOME: "/t3-profile" }).stdout).toContain(`home=${root}/home`);
    // Run by a relative path, it still names itself absolutely.
    const relative = NodeChildProcess.spawnSync("./bin/scient", [], {
      cwd: root,
      encoding: "utf8",
      env: { PATH: process.env.PATH },
    });
    expect(relative.stdout).toContain(`cli=${shim}`);
  });

  it("runs an installed app's server directly", () => {
    const root = tempRoot();
    const executable = NodePath.join(root, "opt", "T3 Code", "t3code");
    writeExecutable(executable, REPORTER);
    const shim = writeShim(root, {
      kind: "direct",
      executable,
      entry: "/opt/T3's/app.asar/bin.mjs",
    });
    expect(run(shim, ["browser", "setup"]).stdout.split("\n").slice(1)).toEqual([
      "/opt/T3's/app.asar/bin.mjs",
      "browser",
      "setup",
      "",
    ]);
  });

  it("tells a person whose app moved to reopen it", () => {
    const root = tempRoot();
    const shim = writeShim(root, {
      kind: "direct",
      executable: NodePath.join(root, "Gone.app/Contents/MacOS/T3 Code"),
      entry: "/bin.mjs",
    });
    const result = run(shim, ["--version"]);
    expect(result.status).toBe(127);
    expect(result.stderr).toContain("Open the app once to update this command.");
  });
});

describe.skipIf(nativePlatform !== "win32")("renderCliShim Windows execution", () => {
  const runWindows = (shim: string, args: ReadonlyArray<string>, env: NodeJS.ProcessEnv = {}) => {
    const quoted = args.map((argument) => `"${argument.replaceAll('"', '\\"')}"`).join(" ");
    return NodeChildProcess.spawnSync(
      process.env.ComSpec ?? `${process.env.SystemRoot}\\System32\\cmd.exe`,
      ["/d", "/s", "/c", `""${shim}" ${quoted}"`],
      {
        encoding: "utf8",
        windowsVerbatimArguments: true,
        env: {
          PATH: process.env.PATH,
          SystemRoot: process.env.SystemRoot,
          WINDIR: process.env.WINDIR,
          ...env,
        },
      },
    );
  };

  it("runs canonical and legacy batch commands with exact quoted arguments and Scient profiles", () => {
    const root = tempRoot();
    const home = NodePath.join(root, "Scient José's profile");
    const entry = NodePath.join(root, "App (x86) & 100% !keep!", "José's entry.mjs");
    NodeFS.mkdirSync(NodePath.dirname(entry), { recursive: true });
    NodeFS.writeFileSync(
      entry,
      "console.log(JSON.stringify({node:process.env.ELECTRON_RUN_AS_NODE,cli:process.env.T3CODE_CLI_PATH,home:process.env.SCIENT_NEXT_HOME,args:process.argv.slice(2)}));process.exitCode=3;",
    );
    const args = ["app", "space argument", 'single \' and "double" quotes', "", "José"];
    for (const name of ["scient.cmd", "t3.cmd"]) {
      const shim = NodePath.join(home, "bin", name);
      writeExecutable(
        shim,
        renderCliShim({
          target: { kind: "windows", executable: process.execPath, entry },
          shimPath: shim,
          t3Home: home,
        }),
      );
      const result = runWindows(shim, args, { T3CODE_HOME: "C:\\unrelated-t3" });
      expect(result.error).toBeUndefined();
      expect(result.status, result.stderr).toBe(3);
      expect(JSON.parse(result.stdout.trim())).toEqual({ node: "1", cli: shim, home, args });
      const override = NodePath.join(root, "explicit Scient profile");
      const overridden = runWindows(shim, args, { SCIENT_NEXT_HOME: override });
      expect(overridden.status, overridden.stderr).toBe(3);
      expect(JSON.parse(overridden.stdout.trim())).toEqual({
        node: "1",
        cli: shim,
        home: override,
        args,
      });
    }
  });

  it("returns 127 when the installed Windows executable is gone", () => {
    const root = tempRoot();
    const shim = NodePath.join(root, "scient.cmd");
    writeExecutable(
      shim,
      renderCliShim({
        target: {
          kind: "windows",
          executable: NodePath.join(root, "missing Scient.exe"),
          entry: NodePath.join(root, "missing entry.mjs"),
        },
        shimPath: shim,
        t3Home: NodePath.join(root, "profile"),
      }),
    );
    const result = runWindows(shim, ["--version"]);
    expect(result.status, result.stderr).toBe(127);
  });
});
