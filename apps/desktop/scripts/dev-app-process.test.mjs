import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { afterEach, assert, describe, it } from "vite-plus/test";

import {
  createCoalescedRestartScheduler,
  createDevelopmentLaunchGeneration,
  findOwnedDevelopmentChildProcess,
  listDevelopmentLaunchPaths,
  makeMacDevelopmentAppLaunchCommand,
  readOwnedDevelopmentAppProcess,
  readOwnedDevelopmentLauncherProcess,
  resolveDevelopmentAppDisplayName,
  resolveDevelopmentLaunchPaths,
  stopManagedDevelopmentLaunch,
  writeDevelopmentEnvironmentFile,
  writeDevelopmentProcessPid,
} from "./dev-app-process.mjs";

const roots = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    NodeFS.rmSync(root, { recursive: true, force: true });
  }
});

describe("macOS development app process ownership", () => {
  it("keeps launch environment values out of the open command line", () => {
    const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "scient-dev-env-"));
    roots.push(root);
    const environmentFilePath = NodePath.join(root, "environment.sh");
    writeDevelopmentEnvironmentFile(environmentFilePath, {
      PATH: "/usr/bin:/bin",
      PROVIDER_TOKEN: "secret with 'quotes'",
      SCIENT_DEV_APP_ENV_FILE: "/tmp/stale-environment.sh",
      SCIENT_DEV_APP_PID_FILE: "/tmp/stale-electron.pid",
      "invalid-name": "ignored",
    });

    const contents = NodeFS.readFileSync(environmentFilePath, "utf8");
    assert.include(contents, "export PATH='/usr/bin:/bin'");
    assert.include(contents, "export PROVIDER_TOKEN='secret with '\\''quotes'\\'''");
    assert.notInclude(contents, "invalid-name");
    assert.notInclude(contents, "SCIENT_DEV_APP_ENV_FILE");
    assert.notInclude(contents, "SCIENT_DEV_APP_PID_FILE");
    assert.equal(NodeFS.statSync(environmentFilePath).mode & 0o777, 0o600);

    const command = makeMacDevelopmentAppLaunchCommand({
      appBundlePath: "/repo/Scient (Dev).app",
      args: ["--remote-debugging-port=9000"],
      environmentFilePath,
      pidFilePath: "/tmp/electron.pid",
    });
    assert.equal(command.command, "/usr/bin/open");
    assert.deepEqual(command.args.slice(0, 2), ["-n", "-W"]);
    assert.include(command.args, "SCIENT_NEXT_DEV_RUNNER_ACTIVE=1");
    assert.include(command.args, "SCIENT_DEV_APP_PID_FILE=/tmp/electron.pid");
    assert.notInclude(command.args.join(" "), "PROVIDER_TOKEN");
  });

  it("accepts only the PID whose command uses the exact generated Electron binary", () => {
    const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "scient-dev-pid-"));
    roots.push(root);
    const pidFilePath = NodePath.join(root, "electron.pid");
    NodeFS.writeFileSync(pidFilePath, "4321\n");
    const electronBinaryPath = "/repo/Scient (Dev).app/Contents/MacOS/Electron";

    assert.deepEqual(
      readOwnedDevelopmentAppProcess({
        pidFilePath,
        electronBinaryPath,
        inspectCommand: () => `${electronBinaryPath} --flag`,
      }),
      { pid: 4321, command: `${electronBinaryPath} --flag` },
    );
    assert.isNull(
      readOwnedDevelopmentAppProcess({
        pidFilePath,
        electronBinaryPath,
        inspectCommand: () => "/another/worktree/Electron --flag",
      }),
    );
  });

  it("records and resolves only the exact backend child of the owned app", () => {
    const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "scient-dev-backend-pid-"));
    roots.push(root);
    const pidFilePath = NodePath.join(root, "backend.pid");
    writeDevelopmentProcessPid(pidFilePath, 5432);
    assert.equal(NodeFS.readFileSync(pidFilePath, "utf8"), "5432\n");
    assert.equal(NodeFS.statSync(pidFilePath).mode & 0o777, 0o600);

    const commandPrefix = "/repo/Scient.app/Contents/MacOS/Electron /repo/server/dist/bin.mjs";
    const child = findOwnedDevelopmentChildProcess({
      parentPid: 4321,
      commandPrefix,
      inspectChildren: (parentPid) =>
        [
          { pid: 1111, command: `${commandPrefix} --bootstrap-fd 3`, parentPid: 9999 },
          { pid: 5432, command: `${commandPrefix} --bootstrap-fd 3`, parentPid },
        ].filter((candidate) => candidate.parentPid === parentPid),
    });

    assert.deepEqual(child, {
      pid: 5432,
      command: `${commandPrefix} --bootstrap-fd 3`,
      parentPid: 4321,
    });
  });

  it("keeps overlapping launch generations in distinct durable PID records", () => {
    const runtimeDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "scient-dev-launches-"));
    roots.push(runtimeDir);
    const firstGeneration = createDevelopmentLaunchGeneration({
      pid: 100,
      sequence: 1,
      randomUUID: () => "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
    });
    const secondGeneration = createDevelopmentLaunchGeneration({
      pid: 100,
      sequence: 2,
      randomUUID: () => "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
    });
    const first = resolveDevelopmentLaunchPaths(runtimeDir, firstGeneration);
    const second = resolveDevelopmentLaunchPaths(runtimeDir, secondGeneration);

    writeDevelopmentProcessPid(first.appPidPath, 1111);
    writeDevelopmentProcessPid(first.backendPidPath, 1112);
    writeDevelopmentProcessPid(second.appPidPath, 2221);
    writeDevelopmentProcessPid(second.backendPidPath, 2222);

    assert.notEqual(first.appPidPath, second.appPidPath);
    assert.deepEqual(
      listDevelopmentLaunchPaths(runtimeDir).map((record) => ({
        generation: record.generation,
        appPid: NodeFS.readFileSync(record.appPidPath, "utf8").trim(),
        backendPid: NodeFS.readFileSync(record.backendPidPath, "utf8").trim(),
      })),
      [
        { generation: firstGeneration, appPid: "1111", backendPid: "1112" },
        { generation: secondGeneration, appPid: "2221", backendPid: "2222" },
      ],
    );
  });

  it("validates the recorded open launcher against its exact generation PID path", () => {
    const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "scient-dev-open-pid-"));
    roots.push(root);
    const pidFilePath = NodePath.join(root, "launcher.pid");
    const appPidFilePath = NodePath.join(root, "electron.pid");
    const appBundlePath = "/repo/Scient (Dev).app";
    NodeFS.writeFileSync(pidFilePath, "7654\n");
    const command = `/usr/bin/open -n -W --env SCIENT_DEV_APP_PID_FILE=${appPidFilePath} ${appBundlePath}`;

    assert.deepEqual(
      readOwnedDevelopmentLauncherProcess({
        pidFilePath,
        appBundlePath,
        appPidFilePath,
        inspectCommand: () => command,
      }),
      { pid: 7654, command },
    );
    assert.isNull(
      readOwnedDevelopmentLauncherProcess({
        pidFilePath,
        appBundlePath,
        appPidFilePath: `${appPidFilePath}-other`,
        inspectCommand: () => command,
      }),
    );
  });

  it("coalesces writes during an active restart into one later restart", async () => {
    const timers = [];
    const setTimer = (callback) => {
      const timer = { callback, cancelled: false, fired: false, unref() {} };
      timers.push(timer);
      return timer;
    };
    const clearTimer = (timer) => {
      timer.cancelled = true;
    };
    const fireNextTimer = () => {
      const timer = timers.find((candidate) => !candidate.cancelled && !candidate.fired);
      assert.isDefined(timer);
      timer.fired = true;
      timer.callback();
    };
    const releases = [];
    let restartCount = 0;
    const scheduler = createCoalescedRestartScheduler({
      debounceMs: 120,
      setTimer,
      clearTimer,
      restart: () => {
        restartCount += 1;
        return new Promise((resolve) => releases.push(resolve));
      },
    });

    scheduler.request();
    scheduler.request();
    scheduler.request();
    assert.equal(timers.filter((timer) => !timer.cancelled && !timer.fired).length, 1);
    fireNextTimer();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(restartCount, 1);

    scheduler.request();
    scheduler.request();
    scheduler.request();
    assert.equal(timers.filter((timer) => !timer.cancelled && !timer.fired).length, 0);
    releases.shift()();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(timers.filter((timer) => !timer.cancelled && !timer.fired).length, 1);

    fireNextTimer();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(restartCount, 2);
    releases.shift()();
    await scheduler.close();
  });

  it("waits for backend ownership and stops the backend before its app", async () => {
    let publishBackend;
    const backendPidPromise = new Promise((resolve) => {
      publishBackend = resolve;
    });
    const signals = [];
    const launcher = { exitCode: 0, kill: () => assert.fail("launcher should not be killed") };
    const stopping = stopManagedDevelopmentLaunch({
      appPidPromise: Promise.resolve({ pid: 1111 }),
      backendPidPromise,
      appPidFilePath: "/runtime/electron.pid",
      backendPidFilePath: "/runtime/backend.pid",
      electronBinaryPath: "/app/Electron",
      backendCommandPrefix: "/app/Electron /server/bin.mjs",
      launcher,
      signalOwnedProcess: (...args) => signals.push(args),
      waitForExit: async () => true,
      gracefulTimeoutMs: 10_000,
      forcedTimeoutMs: 2_000,
      generation: "test-generation",
    });

    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(signals, []);
    publishBackend({ pid: 2222 });
    await stopping;
    assert.deepEqual(signals, [
      ["/runtime/backend.pid", "/app/Electron /server/bin.mjs", "SIGTERM"],
      ["/runtime/electron.pid", "/app/Electron", "SIGTERM"],
    ]);
  });

  it("fails closed when a managed generation remains alive after SIGKILL", async () => {
    const signals = [];
    const launcherSignals = [];
    const launcher = {
      exitCode: null,
      kill: (signal) => launcherSignals.push(signal),
    };
    let failure;

    try {
      await stopManagedDevelopmentLaunch({
        appPidPromise: Promise.resolve({ pid: 1111 }),
        backendPidPromise: Promise.resolve({ pid: 2222 }),
        appPidFilePath: "/runtime/electron.pid",
        backendPidFilePath: "/runtime/backend.pid",
        electronBinaryPath: "/app/Electron",
        backendCommandPrefix: "/app/Electron /server/bin.mjs",
        launcher,
        signalOwnedProcess: (...args) => signals.push(args),
        waitForExit: async () => false,
        gracefulTimeoutMs: 10_000,
        forcedTimeoutMs: 2_000,
        generation: "test-generation",
      });
    } catch (error) {
      failure = error;
    }

    assert.instanceOf(failure, Error);
    assert.equal(failure.message, "Could not stop managed development launch test-generation.");
    assert.deepEqual(signals, [
      ["/runtime/backend.pid", "/app/Electron /server/bin.mjs", "SIGTERM"],
      ["/runtime/electron.pid", "/app/Electron", "SIGTERM"],
      ["/runtime/backend.pid", "/app/Electron /server/bin.mjs", "SIGKILL"],
      ["/runtime/electron.pid", "/app/Electron", "SIGKILL"],
    ]);
    assert.deepEqual(launcherSignals, ["SIGKILL"]);
  });

  it("uses a concise automatic label while keeping stable canonical", () => {
    assert.equal(
      resolveDevelopmentAppDisplayName({}, "/repo/scient-desktop-dev-app-lifecycle-20260824"),
      "Scient (Dev) · dev-app-lifecycle",
    );
    assert.equal(
      resolveDevelopmentAppDisplayName(
        { SCIENT_DEV_APP_ROLE: "stable" },
        "/repo/scient-desktop-main",
      ),
      "Scient (Dev) Stable",
    );
  });
});
