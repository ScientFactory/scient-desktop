import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { afterEach, assert, describe, it } from "vite-plus/test";

import {
  createCoalescedRestartScheduler,
  developmentLauncherIsActive,
  findOwnedDevelopmentChildProcess,
  findOwnedDevelopmentProcesses,
  makeMacDevelopmentAppLaunchCommand,
  readOwnedDevelopmentAppProcess,
  resolveDevelopmentAppDisplayName,
  writeDevelopmentEnvironmentFile,
  writeDevelopmentProcessPid,
} from "./dev-app-process.mjs";

const roots = [];

function flushPromises() {
  return new Promise((resolve) => setImmediate(resolve));
}

function makeManualTimers() {
  const timers = [];
  return {
    set: (callback) => {
      const timer = { callback, cancelled: false, fired: false };
      timers.push(timer);
      return timer;
    },
    clear: (timer) => {
      timer.cancelled = true;
    },
    pending: () => timers.filter((timer) => !timer.cancelled && !timer.fired).length,
    fireNext: () => {
      const timer = timers.find((candidate) => !candidate.cancelled && !candidate.fired);
      assert.isDefined(timer);
      timer.fired = true;
      timer.callback();
    },
  };
}

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
      "invalid-name": "ignored",
    });

    const contents = NodeFS.readFileSync(environmentFilePath, "utf8");
    assert.include(contents, "export PATH='/usr/bin:/bin'");
    assert.include(contents, "export PROVIDER_TOKEN='secret with '\\''quotes'\\'''");
    assert.notInclude(contents, "invalid-name");
    assert.equal(NodeFS.statSync(environmentFilePath).mode & 0o777, 0o600);

    const command = makeMacDevelopmentAppLaunchCommand({
      appBundlePath: "/repo/Scient (Dev).app",
      args: ["--remote-debugging-port=9000"],
      environmentFilePath,
      pidFilePath: "/tmp/electron.pid",
    });
    assert.equal(command.command, "/usr/bin/open");
    assert.equal(command.args[0], "-W");
    assert.notInclude(command.args, "-n");
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

  it("discovers every process with the exact worktree-owned command prefix", () => {
    const commandPrefix =
      "/repo/apps/desktop/.electron-runtime/Scient.app/Contents/MacOS/Electron --t3code-dev-root=/repo/apps/desktop /repo/apps/desktop/dist-electron/main.cjs";

    assert.deepEqual(
      findOwnedDevelopmentProcesses({
        commandPrefix,
        inspectAllProcesses: () => [
          { pid: 101, command: commandPrefix },
          { pid: 102, command: `${commandPrefix} --remote-debugging-port=9000` },
          {
            pid: 103,
            command:
              "/repo/apps/desktop/.electron-runtime/Scient.app/Contents/MacOS/Electron /repo/apps/server/dist/bin.mjs",
          },
          { pid: 104, command: `/other${commandPrefix}` },
        ],
      }),
      [
        { pid: 101, command: commandPrefix },
        { pid: 102, command: `${commandPrefix} --remote-debugging-port=9000` },
      ],
    );
  });

  it("treats a launcher terminated by a signal as no longer active", () => {
    assert.isTrue(developmentLauncherIsActive({ pid: 7654, exitCode: null, signalCode: null }));
    assert.isFalse(developmentLauncherIsActive({ pid: 7654, exitCode: 0, signalCode: null }));
    assert.isFalse(
      developmentLauncherIsActive({ pid: 7654, exitCode: null, signalCode: "SIGINT" }),
    );
    assert.isFalse(
      developmentLauncherIsActive({ pid: undefined, exitCode: null, signalCode: null }),
    );
  });

  it("coalesces restart requests made during an active restart into one follow-up", async () => {
    const timers = makeManualTimers();
    const releases = [];
    let restarts = 0;
    const scheduler = createCoalescedRestartScheduler({
      debounceMs: 120,
      setTimer: timers.set,
      clearTimer: timers.clear,
      restart: () => {
        restarts += 1;
        return new Promise((resolve) => releases.push(resolve));
      },
    });

    scheduler.request();
    scheduler.request();
    scheduler.request();
    assert.equal(timers.pending(), 1);
    timers.fireNext();
    await flushPromises();
    assert.equal(restarts, 1);

    scheduler.request();
    scheduler.request();
    assert.equal(timers.pending(), 0);
    releases.shift()();
    await flushPromises();
    assert.equal(timers.pending(), 1);
    timers.fireNext();
    await flushPromises();
    assert.equal(restarts, 2);

    releases.shift()();
    await scheduler.close();
    assert.equal(restarts, 2);
  });

  it("waits for an in-flight restart on close and drops pending requests", async () => {
    const timers = makeManualTimers();
    let release;
    let finished = false;
    let restarts = 0;
    const scheduler = createCoalescedRestartScheduler({
      debounceMs: 120,
      setTimer: timers.set,
      clearTimer: timers.clear,
      restart: () => {
        restarts += 1;
        return new Promise((resolve) => {
          release = resolve;
        }).then(() => {
          finished = true;
        });
      },
    });

    scheduler.request();
    timers.fireNext();
    await flushPromises();
    scheduler.request();

    let closed = false;
    const closing = scheduler.close().then(() => {
      closed = true;
    });
    await flushPromises();
    assert.isFalse(closed);

    release();
    await closing;
    assert.isTrue(finished);
    assert.equal(timers.pending(), 0);
    scheduler.request();
    assert.equal(timers.pending(), 0);
    assert.equal(restarts, 1);
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
