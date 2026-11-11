import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Context from "effect/Context";
import { afterEach, assert, describe, expect, it } from "vite-plus/test";

import { runDesktopSmoke, runDesktopSmokeWithOutputFiles } from "./smoke-test.mjs";

const isWindows = Context.get(Context.empty(), HostProcess.Platform) === "win32";
const roots = [];
const lingering = [];

function makeFixture() {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "scient-smoke-files-"));
  roots.push(root);
  return {
    root,
    env: { PATH: NodePath.dirname(process.execPath), HOME: root, TMPDIR: root },
  };
}

afterEach(() => {
  for (const pid of lingering.splice(0)) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {}
  }
  for (const root of roots.splice(0)) NodeFS.rmSync(root, { recursive: true, force: true });
});

// The app stops, but a helper it started keeps its inherited output handles for a while.
const appWithLingeringHelper = (pidFile) => `
  const { spawn } = require("node:child_process");
  const helper = spawn(process.execPath, ["-e", "setTimeout(() => {}, 5000)"], { stdio: ["ignore", "inherit", "inherit"] });
  require("node:fs").writeFileSync(${JSON.stringify(pidFile)}, String(helper.pid));
  process.stdout.write("app started\\n");
  setInterval(() => {}, 1000);
  process.on("SIGTERM", () => process.exit(0));
`;

const remember = (pidFile) => {
  if (NodeFS.existsSync(pidFile)) lingering.push(Number(NodeFS.readFileSync(pidFile, "utf8")));
};

describe("runDesktopSmokeWithOutputFiles", () => {
  // Both apps stop from a SIGTERM handler, which Windows never runs.
  it.skipIf(isWindows)(
    "passes an app that stopped although a helper still holds its output handles",
    async () => {
      const piped = makeFixture();
      const pipedPidFile = NodePath.join(piped.root, "helper.pid");
      const withPipes = await runDesktopSmoke({
        executable: process.execPath,
        args: ["-e", appWithLingeringHelper(pipedPidFile)],
        cwd: piped.root,
        env: piped.env,
        survivalMs: 1_000,
        shutdownGraceMs: 1_000,
      });
      remember(pipedPidFile);
      assert.equal(withPipes.passed, false, "pipes wait for the helper");
      assert.equal(withPipes.drainageTimedOut, true);

      const filed = makeFixture();
      const filedPidFile = NodePath.join(filed.root, "helper.pid");
      const withFiles = await runDesktopSmokeWithOutputFiles({
        executable: process.execPath,
        args: ["-e", appWithLingeringHelper(filedPidFile)],
        cwd: filed.root,
        env: filed.env,
        outputDirectory: NodePath.join(filed.root, "output"),
        survivalMs: 1_000,
        shutdownGraceMs: 1_000,
        settleMs: 200,
      });
      remember(filedPidFile);
      assert.equal(withFiles.passed, true);
      assert.equal(withFiles.shutdownRequested, true);
      assert.equal(withFiles.forcedKill, false);
      assert.equal(withFiles.stdout, "app started\n");
    },
  );

  // The app writes the late output from its SIGTERM handler, which Windows never runs.
  it.skipIf(isWindows)("still rejects fatal output written after the exit", async () => {
    const fixture = makeFixture();
    const result = await runDesktopSmokeWithOutputFiles({
      executable: process.execPath,
      args: [
        "-e",
        `
        const { spawn } = require("node:child_process");
        setInterval(() => {}, 1000);
        process.on("SIGTERM", () => {
          spawn(process.execPath, ["-e", "setTimeout(() => process.stderr.write('Uncaught TypeError: late'), 100)"],
            { stdio: ["ignore", "inherit", "inherit"] });
          process.exit(0);
        });
      `,
      ],
      cwd: fixture.root,
      env: fixture.env,
      outputDirectory: NodePath.join(fixture.root, "output"),
      survivalMs: 1_000,
      shutdownGraceMs: 1_000,
      settleMs: 1_000,
    });
    assert.equal(result.passed, false);
    assert.deepEqual(result.failures, ["Uncaught TypeError"]);
  });

  it("scans output only after the caller's wait, so late output from the app's helpers counts", async () => {
    const fixture = makeFixture();
    const pidFile = NodePath.join(fixture.root, "helper.pid");
    const result = await runDesktopSmokeWithOutputFiles({
      executable: process.execPath,
      args: [
        "-e",
        `
        const { spawn } = require("node:child_process");
        const helper = spawn(process.execPath, ["-e", "setTimeout(() => process.stderr.write('Uncaught Error: late'), 1500)"],
          { stdio: ["ignore", "inherit", "inherit"] });
        require("node:fs").writeFileSync(${JSON.stringify(pidFile)}, String(helper.pid));
        setInterval(() => {}, 1000);
      `,
      ],
      cwd: fixture.root,
      env: fixture.env,
      outputDirectory: NodePath.join(fixture.root, "output"),
      survivalMs: 300,
      shutdownGraceMs: 1_000,
      settleMs: 0,
      // Like the Windows qualification: wait until the app's processes are gone.
      beforeScan: async () => {
        const helper = Number(NodeFS.readFileSync(pidFile, "utf8"));
        lingering.push(helper);
        await expect
          .poll(
            () => {
              try {
                process.kill(helper, 0);
                return true;
              } catch {
                return false;
              }
            },
            { timeout: 5_000 },
          )
          .toBe(false);
      },
    });
    assert.equal(result.passed, false);
    assert.deepEqual(result.failures, ["Uncaught Error"]);
  });

  it("fails, instead of waiting forever, when the wait before the scan fails", async () => {
    const fixture = makeFixture();
    let error;
    try {
      await runDesktopSmokeWithOutputFiles({
        executable: process.execPath,
        args: ["-e", "setInterval(() => {}, 1000);"],
        cwd: fixture.root,
        env: fixture.env,
        outputDirectory: NodePath.join(fixture.root, "output"),
        survivalMs: 300,
        shutdownGraceMs: 1_000,
        settleMs: 0,
        beforeScan: async () => {
          throw new Error("process listing failed");
        },
      });
    } catch (caught) {
      error = caught;
    }
    assert.equal(error?.message, "process listing failed");
  });

  it.skipIf(isWindows)("still rejects an app that needs a forced kill", async () => {
    const fixture = makeFixture();
    const result = await runDesktopSmokeWithOutputFiles({
      executable: process.execPath,
      args: ["-e", `setInterval(() => {}, 1000); process.on("SIGTERM", () => {});`],
      cwd: fixture.root,
      env: fixture.env,
      outputDirectory: NodePath.join(fixture.root, "output"),
      survivalMs: 1_000,
      shutdownGraceMs: 1_000,
      settleMs: 100,
    });
    assert.equal(result.passed, false);
    assert.equal(result.forcedKill, true);
  });

  it("reports an app that cannot start", async () => {
    const fixture = makeFixture();
    const result = await runDesktopSmokeWithOutputFiles({
      executable: NodePath.join(fixture.root, "missing-app"),
      cwd: fixture.root,
      env: fixture.env,
      outputDirectory: NodePath.join(fixture.root, "output"),
      settleMs: 0,
    });
    assert.equal(result.passed, false);
    assert.isDefined(result.error);
  });
});
