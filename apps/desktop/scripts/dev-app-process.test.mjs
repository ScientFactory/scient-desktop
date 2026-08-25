import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { afterEach, assert, describe, it } from "vite-plus/test";

import {
  findOwnedDevelopmentChildProcess,
  makeMacDevelopmentAppLaunchCommand,
  readOwnedDevelopmentAppProcess,
  resolveDevelopmentAppDisplayName,
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
