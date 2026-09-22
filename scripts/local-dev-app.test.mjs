import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { afterEach, assert, describe, it } from "vite-plus/test";

import {
  resolveDevelopmentLaunchPaths,
  writeDevelopmentLaunchHandoff,
  writeDevelopmentProcessPid,
} from "../apps/desktop/scripts/dev-app-process.mjs";

import {
  acquireRunner,
  clearStaleRunner,
  installDevelopmentAppBundle,
  LOCAL_DEV_APP_NAME,
  LOCAL_DEV_APP_SERVICE_LABEL_PREFIX,
  LOCAL_DEV_APP_STABLE_NAME,
  LOCAL_DEV_APP_SCHEMA,
  MACOS_LSREGISTER_PATH,
  makeLocalDevAppLaunchAgentPlist,
  readLocalDevAppMarker,
  registerDevelopmentAppBundle,
  releaseRunner,
  resolveLocalDevAppPaths,
  resolveLocalDevAppServiceLabel,
  resolveOwnedDevelopmentLaunches,
  resolveStableDevHome,
  startAppInBackground,
  statusApp,
  stopApp,
  unloadLocalDevAppService,
  uninstallDevelopmentAppBundle,
} from "./local-dev-app.mjs";

const roots = [];

function fixture() {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "scient-next-local-dev-test-"));
  roots.push(root);
  const homeDir = NodePath.join(root, "home");
  const repoRoot = NodePath.join(root, "repo");
  const sourceAppBundlePath = NodePath.join(root, "source", `${LOCAL_DEV_APP_NAME}.app`);
  NodeFS.mkdirSync(NodePath.join(sourceAppBundlePath, "Contents", "Resources"), {
    recursive: true,
  });
  NodeFS.writeFileSync(NodePath.join(sourceAppBundlePath, "Contents", "Info.plist"), "fixture");
  return {
    sourceAppBundlePath,
    paths: resolveLocalDevAppPaths({ root: repoRoot, homeDir }),
  };
}

function writeRunnerState(paths, pid = 1234) {
  NodeFS.mkdirSync(paths.runnerDir, { recursive: true });
  NodeFS.writeFileSync(
    paths.runnerStatePath,
    `${JSON.stringify({ schema: LOCAL_DEV_APP_SCHEMA, repoRoot: paths.root, pid })}\n`,
  );
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    NodeFS.rmSync(root, { recursive: true, force: true });
  }
});

describe("local dev app installation", () => {
  it("registers the exact app bundle through the system LaunchServices helper", () => {
    const calls = [];
    registerDevelopmentAppBundle("/Applications/Scient (Dev).app", {
      spawnSync: (...args) => {
        calls.push(args);
        return { status: 0, stderr: "" };
      },
    });

    assert.deepEqual(calls, [
      [MACOS_LSREGISTER_PATH, ["-f", "/Applications/Scient (Dev).app"], { encoding: "utf8" }],
    ]);
  });

  it("uses a separate stable launcher name without changing candidate paths", () => {
    const { root } = fixture().paths;
    const homeDir = NodePath.join(root, "home");
    const candidate = resolveLocalDevAppPaths({ root, homeDir });
    const stable = resolveLocalDevAppPaths({ root, homeDir, role: "stable" });

    assert.equal(candidate.appName, LOCAL_DEV_APP_NAME);
    assert.equal(stable.appName, LOCAL_DEV_APP_STABLE_NAME);
    assert.notEqual(candidate.appBundlePath, stable.appBundlePath);
    assert.equal(stable.role, "stable");
    assert.equal(stable.stateRoot, resolveStableDevHome(homeDir));
    assert.notEqual(candidate.stateRoot, stable.stateRoot);
    assert.notEqual(candidate.serviceLabel, stable.serviceLabel);
  });

  it("reports LaunchServices registration failures", () => {
    assert.throws(
      () =>
        registerDevelopmentAppBundle("/Applications/Scient (Dev).app", {
          spawnSync: () => ({ status: 1, stderr: "registration failed" }),
        }),
      /registration failed/,
    );
  });

  it("restores the previous owned app when registration fails", () => {
    const { sourceAppBundlePath, paths } = fixture();
    installDevelopmentAppBundle({ sourceAppBundlePath, paths });
    const infoPath = NodePath.join(sourceAppBundlePath, "Contents", "Info.plist");
    NodeFS.writeFileSync(infoPath, "replacement");

    assert.throws(
      () =>
        installDevelopmentAppBundle({
          sourceAppBundlePath,
          paths,
          register: () => {
            throw new Error("registration failed");
          },
        }),
      /registration failed/,
    );
    assert.equal(
      NodeFS.readFileSync(NodePath.join(paths.appBundlePath, "Contents", "Info.plist"), "utf8"),
      "fixture",
    );
  });

  it("removes a first install when registration fails", () => {
    const { sourceAppBundlePath, paths } = fixture();

    assert.throws(
      () =>
        installDevelopmentAppBundle({
          sourceAppBundlePath,
          paths,
          register: () => {
            throw new Error("registration failed");
          },
        }),
      /registration failed/,
    );
    assert.isFalse(NodeFS.existsSync(paths.appBundlePath));
  });

  it("never deletes an unexpected app that races the staged commit", () => {
    const { sourceAppBundlePath, paths } = fixture();
    installDevelopmentAppBundle({ sourceAppBundlePath, paths });

    assert.throws(() =>
      installDevelopmentAppBundle({
        sourceAppBundlePath,
        paths,
        commitStagedApp: (_source, target) => {
          NodeFS.mkdirSync(target, { recursive: true });
          NodeFS.writeFileSync(NodePath.join(target, "unexpected"), "preserve me");
          const error = new Error("target raced");
          error.code = "EEXIST";
          throw error;
        },
      }),
    );

    assert.equal(
      NodeFS.readFileSync(NodePath.join(paths.appBundlePath, "unexpected"), "utf8"),
      "preserve me",
    );
    const backupName = NodeFS.readdirSync(paths.applicationsDir).find((name) =>
      name.startsWith(`${LOCAL_DEV_APP_NAME}.app.backup-`),
    );
    assert.isDefined(backupName);
    assert.equal(
      NodeFS.readFileSync(
        NodePath.join(paths.applicationsDir, backupName, "Contents", "Info.plist"),
        "utf8",
      ),
      "fixture",
    );
  });

  it("installs an owned app with the exact checkout marker", () => {
    const { sourceAppBundlePath, paths } = fixture();
    const installed = installDevelopmentAppBundle({ sourceAppBundlePath, paths });

    assert.equal(installed, paths.appBundlePath);
    assert.equal(
      NodeFS.readFileSync(NodePath.join(installed, "Contents", "Info.plist"), "utf8"),
      "fixture",
    );
    assert.deepInclude(readLocalDevAppMarker(paths), {
      schema: LOCAL_DEV_APP_SCHEMA,
      repoRoot: paths.root,
    });
  });

  it("refuses to overwrite an unrecognized application", () => {
    const { sourceAppBundlePath, paths } = fixture();
    NodeFS.mkdirSync(paths.appBundlePath, { recursive: true });

    assert.throws(
      () => installDevelopmentAppBundle({ sourceAppBundlePath, paths }),
      /Refusing to replace unrecognized application/,
    );
  });

  it("requires explicit replacement when another checkout owns the launcher", () => {
    const first = fixture();
    installDevelopmentAppBundle(first);
    const secondPaths = resolveLocalDevAppPaths({
      root: `${first.paths.root}-other`,
      homeDir: NodePath.dirname(first.paths.applicationsDir),
    });

    assert.throws(
      () =>
        installDevelopmentAppBundle({
          sourceAppBundlePath: first.sourceAppBundlePath,
          paths: secondPaths,
        }),
      /belongs to/,
    );

    installDevelopmentAppBundle({
      sourceAppBundlePath: first.sourceAppBundlePath,
      paths: secondPaths,
      replace: true,
    });
    assert.equal(readLocalDevAppMarker(secondPaths)?.repoRoot, secondPaths.root);
  });

  it("uninstalls only the launcher owned by the current checkout", () => {
    const { sourceAppBundlePath, paths } = fixture();
    installDevelopmentAppBundle({ sourceAppBundlePath, paths });

    assert.isTrue(uninstallDevelopmentAppBundle(paths));
    assert.isFalse(NodeFS.existsSync(paths.appBundlePath));
    assert.isFalse(uninstallDevelopmentAppBundle(paths));
  });
});

describe("local dev app background service", () => {
  it("gives every checkout and role a deterministic distinct service label", () => {
    const first = resolveLocalDevAppServiceLabel("/tmp/one", "candidate");
    const repeated = resolveLocalDevAppServiceLabel("/tmp/one", "candidate");
    const second = resolveLocalDevAppServiceLabel("/tmp/two", "candidate");
    const stable = resolveLocalDevAppServiceLabel("/tmp/one", "stable");

    assert.equal(first, repeated);
    assert.notEqual(first, second);
    assert.notEqual(first, stable);
    assert.isTrue(first.startsWith(`${LOCAL_DEV_APP_SERVICE_LABEL_PREFIX}.candidate.`));
  });

  it("launches the exact Node runner with only required non-secret environment", () => {
    const { paths } = fixture();
    const plist = makeLocalDevAppLaunchAgentPlist({
      paths,
      nodePath: "/opt/scient/node",
      environment: {
        HOME: "/Users/tester",
        PATH: "/opt/scient/bin:/usr/bin",
        npm_execpath: "/opt/scient/pnpm.cjs",
        SECRET_TOKEN: "must-not-be-persisted",
      },
    });

    assert.include(plist, `<string>${paths.serviceLabel}</string>`);
    assert.include(plist, "<string>/opt/scient/node</string>");
    assert.include(plist, `<string>${paths.root}/scripts/local-dev-app.mjs</string>`);
    assert.include(plist, "<string>run</string>");
    assert.include(plist, "<key>npm_execpath</key>");
    assert.notInclude(plist, "SECRET_TOKEN");
    assert.notInclude(plist, "must-not-be-persisted");
    assert.include(plist, "<string>Interactive</string>");
  });

  it("bootstraps one exact per-worktree service and returns immediately", async () => {
    const { paths } = fixture();
    const calls = [];
    const lines = [];

    const result = await startAppInBackground({
      paths,
      platform: "darwin",
      spawnSync: (command, args, options) => {
        const call = [command, args, options];
        calls.push(call);
        if (args[0] === "print") return { status: 1, stdout: "", stderr: "" };
        return { status: 0, stdout: "", stderr: "" };
      },
      writeLine: (line) => lines.push(line),
    });

    assert.deepEqual(result, { status: "started" });
    assert.isTrue(NodeFS.existsSync(paths.servicePlistPath));
    assert.equal(calls.length, 2);
    assert.deepEqual(calls[1][1], [
      "bootstrap",
      `gui/${String(process.getuid())}`,
      paths.servicePlistPath,
    ]);
    assert.match(lines[0], /^Launching Scient \(Dev\)/u);
  });

  it("unloads only its exact registered service", () => {
    const { paths } = fixture();
    NodeFS.mkdirSync(paths.runtimeDir, { recursive: true });
    NodeFS.writeFileSync(paths.servicePlistPath, "fixture");
    const calls = [];

    assert.isTrue(
      unloadLocalDevAppService(paths, {
        spawnSync: (...args) => {
          calls.push(args);
          return { status: 0, stdout: "", stderr: "" };
        },
      }),
    );

    assert.deepEqual(calls[1][1], [
      "bootout",
      `gui/${String(process.getuid())}/${paths.serviceLabel}`,
    ]);
    assert.isFalse(NodeFS.existsSync(paths.servicePlistPath));
  });
});

describe("local dev app runner lifecycle", () => {
  it("does not acquire a second runner while the recorded runner matches", () => {
    const { paths } = fixture();
    writeRunnerState(paths);

    const result = acquireRunner(paths, { matchesRunner: () => true });

    assert.isFalse(result.acquired);
    assert.equal(result.state.pid, 1234);
  });

  it("removes stale runner state before acquiring a replacement", () => {
    const { paths } = fixture();
    writeRunnerState(paths);

    const result = acquireRunner(paths, { matchesRunner: () => false });

    assert.isTrue(result.acquired);
    assert.equal(result.state.pid, process.pid);
    assert.equal(JSON.parse(NodeFS.readFileSync(paths.runnerStatePath, "utf8")).pid, process.pid);
  });

  it("returns the winning runner when stale-lock recovery races", () => {
    const { paths } = fixture();
    writeRunnerState(paths, 1234);
    let attempts = 0;

    const result = acquireRunner(paths, {
      matchesRunner: (pid) => pid === 5678,
      makeRunnerDirectory: () => {
        attempts += 1;
        if (attempts === 2) writeRunnerState(paths, 5678);
        const error = new Error("already exists");
        error.code = "EEXIST";
        throw error;
      },
    });

    assert.isFalse(result.acquired);
    assert.equal(result.state.pid, 5678);
    assert.equal(attempts, 2);
  });

  it("does not let an exiting old runner remove a replacement runner lock", () => {
    const { paths } = fixture();
    writeRunnerState(paths, 5678);

    assert.isFalse(releaseRunner(paths, 1234));
    assert.equal(JSON.parse(NodeFS.readFileSync(paths.runnerStatePath, "utf8")).pid, 5678);
    assert.isTrue(releaseRunner(paths, 5678));
    assert.isFalse(NodeFS.existsSync(paths.runnerDir));
  });

  it("preserves the grace window for a runner that has not written state yet", () => {
    const { paths } = fixture();
    NodeFS.mkdirSync(paths.runnerDir, { recursive: true });
    const state = clearStaleRunner(paths, {
      matchesRunner: () => false,
      now: () => NodeFS.statSync(paths.runnerDir).mtimeMs + 1,
    });

    assert.isTrue(state.starting);
    assert.isTrue(NodeFS.existsSync(paths.runnerDir));
  });

  it("reports status from validated runner state", () => {
    const { paths } = fixture();
    writeRunnerState(paths);
    const lines = [];

    statusApp({
      paths,
      matchesRunner: () => true,
      serviceIsLoaded: () => false,
      resolveOwnedLaunches: () => [
        {
          app: { pid: 2222 },
          backend: { pid: 3333 },
          launcher: { pid: 1111 },
        },
      ],
      writeLine: (line) => lines.push(line),
    });

    assert.deepEqual(lines, [
      `${LOCAL_DEV_APP_NAME} is running for ${paths.root} (runner PID 1234, app PID 2222, backend PID 3333).`,
    ]);
  });

  it("reports a runner without both owned processes as still starting", () => {
    const { paths } = fixture();
    writeRunnerState(paths);
    const lines = [];

    statusApp({
      paths,
      matchesRunner: () => true,
      serviceIsLoaded: () => true,
      resolveOwnedLaunches: () => [{ app: { pid: 2222 }, backend: null, launcher: { pid: 1111 } }],
      writeLine: (line) => lines.push(line),
    });

    assert.deepEqual(lines, [
      `${LOCAL_DEV_APP_NAME} is starting for ${paths.root} (runner PID 1234, app PID 2222).`,
    ]);
  });

  it("preserves an incomplete launch record for the full lifetime of its runner", () => {
    const { paths } = fixture();
    const record = resolveDevelopmentLaunchPaths(paths.runtimeDir, "1-1-cccccccc");
    NodeFS.mkdirSync(record.launchDir, { recursive: true });
    const twentySecondsAgo = new Date(Date.now() - 20_000);
    NodeFS.utimesSync(record.launchDir, twentySecondsAgo, twentySecondsAgo);

    assert.lengthOf(
      resolveOwnedDevelopmentLaunches(paths, {
        preserveIncomplete: true,
        inspectCommand: () => null,
        inspectChildren: () => [],
      }),
      1,
    );
    assert.isTrue(NodeFS.existsSync(record.launchDir));
    assert.deepEqual(
      resolveOwnedDevelopmentLaunches(paths, {
        preserveIncomplete: false,
        inspectCommand: () => null,
        inspectChildren: () => [],
      }),
      [],
    );
    assert.isFalse(NodeFS.existsSync(record.launchDir));
  });

  it("keeps a generation handoff until publication or its recovery grace expires", () => {
    const { paths } = fixture();
    const record = resolveDevelopmentLaunchPaths(paths.runtimeDir, "1-1-eeeeeeee");
    writeDevelopmentLaunchHandoff(record);
    const modifiedAt = NodeFS.statSync(record.backendPidPendingPath).mtimeMs;
    const dependencies = {
      inspectCommand: () => null,
      inspectChildren: () => [],
    };

    assert.lengthOf(
      resolveOwnedDevelopmentLaunches(paths, {
        ...dependencies,
        now: () => modifiedAt + 1,
      }),
      1,
    );
    assert.isTrue(NodeFS.existsSync(record.launchDir));
    assert.deepEqual(
      resolveOwnedDevelopmentLaunches(paths, {
        ...dependencies,
        now: () => modifiedAt + 5_001,
      }),
      [],
    );
    assert.isFalse(NodeFS.existsSync(record.launchDir));
  });

  it("does not delete a backend published while its handoff marker disappears", () => {
    const { paths } = fixture();
    const record = resolveDevelopmentLaunchPaths(paths.runtimeDir, "1-1-eeeeeeee");
    writeDevelopmentLaunchHandoff(record);
    writeDevelopmentProcessPid(record.backendPidPath, 5432);
    const electronBinaryPath = NodePath.join(
      paths.root,
      "apps",
      "desktop",
      ".electron-runtime",
      `${LOCAL_DEV_APP_NAME}.app`,
      "Contents",
      "MacOS",
      "Electron",
    );
    const commandPrefix = `${electronBinaryPath} ${NodePath.join(
      paths.root,
      "apps",
      "server",
      "dist",
      "bin.mjs",
    )}`;
    let backendInspections = 0;

    const launches = resolveOwnedDevelopmentLaunches(paths, {
      inspectCommand: (pid) => {
        if (pid !== 5432) return null;
        backendInspections++;
        if (backendInspections === 1) {
          NodeFS.rmSync(record.backendPidPendingPath);
          return null;
        }
        return `${commandPrefix} --bootstrap-fd 3`;
      },
      inspectChildren: () => [],
    });

    assert.equal(backendInspections, 2);
    assert.lengthOf(launches, 1);
    assert.equal(launches[0].backend?.pid, 5432);
    assert.isTrue(NodeFS.existsSync(record.launchDir));
    assert.isTrue(NodeFS.existsSync(record.backendPidPath));
  });

  it("signals only the validated runner PID", async () => {
    const { paths } = fixture();
    writeRunnerState(paths);
    const signals = [];

    await stopApp({
      paths,
      matchesRunner: () => true,
      killProcess: (...args) => signals.push(args),
      resolveOwnedLaunches: () => [],
      waitUntilStopped: async () => true,
      unloadService: () => false,
      writeLine: () => {},
    });

    assert.deepEqual(signals, [[1234, "SIGTERM"]]);
  });

  it("stops the exact recorded app and backend with the runner", async () => {
    const { paths } = fixture();
    writeRunnerState(paths);
    const signals = [];

    await stopApp({
      paths,
      matchesRunner: () => true,
      killProcess: (...args) => signals.push(args),
      resolveOwnedLaunches: () => [
        {
          record: { generation: "test-generation" },
          app: { pid: 2222, command: "/owned/Electron" },
          backend: { pid: 3333, command: "/owned/Electron server/bin.mjs" },
          launcher: null,
        },
      ],
      waitUntilStopped: async () => true,
      unloadService: () => false,
      writeLine: () => {},
    });

    assert.deepEqual(signals, [
      [3333, "SIGTERM"],
      [2222, "SIGTERM"],
      [1234, "SIGTERM"],
    ]);
  });

  it("stops every same-worktree process even when no launch record owns it", async () => {
    const { paths } = fixture();
    const signals = [];

    await stopApp({
      paths,
      matchesRunner: () => false,
      killProcess: (...args) => signals.push(args),
      resolveOwnedLaunches: () => [],
      resolveOwnedApps: () => [
        { pid: 2222, command: "/owned/Electron --t3code-dev-root=/owned" },
        { pid: 4444, command: "/owned/Electron --t3code-dev-root=/owned" },
      ],
      resolveOwnedBackends: () => [{ pid: 3333, command: "/owned/Electron server/bin.mjs" }],
      waitUntilStopped: async () => true,
      unloadService: () => false,
      writeLine: () => {},
    });

    assert.deepEqual(signals, [
      [2222, "SIGTERM"],
      [4444, "SIGTERM"],
      [3333, "SIGTERM"],
    ]);
  });

  it("revalidates a generation immediately before signaling a recorded PID", async () => {
    const { paths } = fixture();
    writeRunnerState(paths);
    const recordedLaunch = {
      record: { generation: "test-generation" },
      app: { pid: 2222, command: "/owned/Electron" },
      backend: null,
      launcher: null,
    };
    let resolutionCount = 0;
    const signals = [];

    await stopApp({
      paths,
      matchesRunner: () => true,
      killProcess: (...args) => signals.push(args),
      resolveOwnedLaunches: () => {
        resolutionCount += 1;
        return resolutionCount <= 2 ? [recordedLaunch] : [];
      },
      waitUntilStopped: async () => true,
      unloadService: () => false,
      writeLine: () => {},
    });

    assert.deepEqual(signals, [[1234, "SIGTERM"]]);
    assert.isAtLeast(resolutionCount, 3);
  });

  it("retains ownership of a discovered backend after its app exits", async () => {
    const { paths } = fixture();
    const record = resolveDevelopmentLaunchPaths(paths.runtimeDir, "1-1-dddddddd");
    const appBundlePath = NodePath.join(
      paths.root,
      "apps",
      "desktop",
      ".electron-runtime",
      `${LOCAL_DEV_APP_NAME}.app`,
    );
    const electronBinaryPath = NodePath.join(appBundlePath, "Contents", "MacOS", "Electron");
    const backendCommandPrefix = `${electronBinaryPath} ${NodePath.join(
      paths.root,
      "apps",
      "server",
      "dist",
      "bin.mjs",
    )}`;
    const commands = new Map([
      [1101, `${electronBinaryPath} --app`],
      [1102, `${backendCommandPrefix} --backend`],
      [
        1103,
        `/usr/bin/open -n -W --env SCIENT_DEV_APP_PID_FILE=${record.appPidPath} ${appBundlePath}`,
      ],
    ]);
    writeDevelopmentProcessPid(record.appPidPath, 1101);
    writeDevelopmentProcessPid(record.launcherPidPath, 1103);
    const alive = new Set(commands.keys());
    const inspectCommand = (pid) => (alive.has(pid) ? commands.get(pid) : null);
    const resolveOwnedLaunches = () =>
      resolveOwnedDevelopmentLaunches(paths, {
        inspectCommand,
        inspectChildren: (parentPid) =>
          parentPid === 1101 && alive.has(1102) ? [{ pid: 1102, command: commands.get(1102) }] : [],
      });
    const signals = [];
    let waitCount = 0;

    await stopApp({
      paths,
      matchesRunner: () => false,
      killProcess: (pid, signal) => {
        signals.push([pid, signal]);
        if (pid === 1102 && signal === "SIGTERM") {
          assert.equal(NodeFS.readFileSync(record.backendPidPath, "utf8").trim(), "1102");
          return;
        }
        alive.delete(pid);
      },
      resolveOwnedLaunches,
      waitUntilStopped: async () => {
        waitCount += 1;
        return waitCount > 1 && resolveOwnedLaunches().length === 0;
      },
      unloadService: () => false,
      writeLine: () => {},
    });

    assert.deepEqual(signals, [
      [1102, "SIGTERM"],
      [1101, "SIGTERM"],
      [1103, "SIGTERM"],
      [1102, "SIGKILL"],
    ]);
    assert.isFalse(NodeFS.existsSync(record.launchDir));
  });

  it("treats a runner that exits before signaling as already stopped", async () => {
    const { paths } = fixture();
    writeRunnerState(paths);
    const lines = [];

    await stopApp({
      paths,
      matchesRunner: () => true,
      killProcess: () => {
        const error = new Error("gone");
        error.code = "ESRCH";
        throw error;
      },
      resolveOwnedLaunches: () => [],
      waitUntilStopped: async () => true,
      unloadService: () => false,
      writeLine: (line) => lines.push(line),
    });

    assert.isFalse(NodeFS.existsSync(paths.runnerDir));
    assert.deepEqual(lines, [`Stopped ${LOCAL_DEV_APP_NAME} for ${paths.root}.`]);
  });

  it("stops every recorded launch generation after the runner has crashed", async () => {
    const { paths } = fixture();
    const first = resolveDevelopmentLaunchPaths(paths.runtimeDir, "1-1-aaaaaaaa");
    const second = resolveDevelopmentLaunchPaths(paths.runtimeDir, "1-2-bbbbbbbb");
    const appBundlePath = NodePath.join(
      paths.root,
      "apps",
      "desktop",
      ".electron-runtime",
      `${LOCAL_DEV_APP_NAME}.app`,
    );
    const electronBinaryPath = NodePath.join(appBundlePath, "Contents", "MacOS", "Electron");
    const backendCommandPrefix = `${electronBinaryPath} ${NodePath.join(
      paths.root,
      "apps",
      "server",
      "dist",
      "bin.mjs",
    )}`;
    const commands = new Map([
      [1101, `${electronBinaryPath} --first`],
      [1102, `${backendCommandPrefix} --first`],
      [
        1103,
        `/usr/bin/open -n -W --env SCIENT_DEV_APP_PID_FILE=${first.appPidPath} ${appBundlePath}`,
      ],
      [2201, `${electronBinaryPath} --second`],
      [2202, `${backendCommandPrefix} --second`],
      [
        2203,
        `/usr/bin/open -n -W --env SCIENT_DEV_APP_PID_FILE=${second.appPidPath} ${appBundlePath}`,
      ],
    ]);
    for (const [record, pids] of [
      [first, { app: 1101, backend: 1102, launcher: 1103 }],
      [second, { app: 2201, backend: 2202, launcher: 2203 }],
    ]) {
      writeDevelopmentProcessPid(record.appPidPath, pids.app);
      writeDevelopmentProcessPid(record.backendPidPath, pids.backend);
      writeDevelopmentProcessPid(record.launcherPidPath, pids.launcher);
    }
    const alive = new Set(commands.keys());
    const inspectCommand = (pid) => (alive.has(pid) ? commands.get(pid) : null);
    const resolveOwnedLaunches = () =>
      resolveOwnedDevelopmentLaunches(paths, { inspectCommand, inspectChildren: () => [] });
    const signals = [];
    const lines = [];

    await stopApp({
      paths,
      matchesRunner: () => false,
      killProcess: (pid, signal) => {
        signals.push([pid, signal]);
        alive.delete(pid);
      },
      resolveOwnedLaunches,
      waitUntilStopped: async () => resolveOwnedLaunches().length === 0,
      unloadService: () => false,
      writeLine: (line) => lines.push(line),
    });

    assert.deepEqual(signals, [
      [1102, "SIGTERM"],
      [2202, "SIGTERM"],
      [1101, "SIGTERM"],
      [2201, "SIGTERM"],
      [1103, "SIGTERM"],
      [2203, "SIGTERM"],
    ]);
    assert.isFalse(NodeFS.existsSync(first.launchDir));
    assert.isFalse(NodeFS.existsSync(second.launchDir));
    assert.deepEqual(lines, [
      `Stopped orphaned ${LOCAL_DEV_APP_NAME} app processes for ${paths.root}.`,
    ]);
  });
});
