import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeEvents from "node:events";
import * as NodeNet from "node:net";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Context from "effect/Context";
import { afterEach, assert, describe, it } from "vite-plus/test";

import { runDesktopSmoke } from "./smoke-test.mjs";

const roots = [];
const isWindows = Context.get(Context.empty(), HostProcess.Platform) === "win32";

function makeFixture() {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "scient-smoke-gate-"));
  roots.push(root);
  return {
    root,
    env: { PATH: NodePath.dirname(process.execPath), HOME: root, TMPDIR: root },
  };
}

async function runChild(source, deadlines = {}) {
  const fixture = makeFixture();
  const result = await runDesktopSmoke({
    executable: process.execPath,
    args: ["-e", source],
    cwd: fixture.root,
    env: fixture.env,
    survivalMs: 1_000,
    shutdownGraceMs: 1_000,
    ...deadlines,
  });
  if (result.pid !== undefined) assert.throws(() => process.kill(result.pid, 0), /ESRCH/);
  return result;
}

function processHasExited(pid) {
  try {
    process.kill(pid, 0);
  } catch (error) {
    if (error.code === "ESRCH") return true;
    throw error;
  }
  // An orphan that already exited stays a zombie until its new parent reaps it.
  try {
    const stat = NodeFS.readFileSync(`/proc/${pid}/stat`, "utf8");
    return stat.slice(stat.lastIndexOf(")") + 2).startsWith("Z");
  } catch {
    return false;
  }
}

async function waitForProcessExit(pid, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (!processHasExited(pid)) {
    if (Date.now() > deadline) assert.fail(`process ${pid} is still running`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

afterEach(() => {
  for (const root of roots.splice(0)) NodeFS.rmSync(root, { recursive: true, force: true });
});

describe("actual desktop smoke child lifecycle", () => {
  it.each(
    [0, 7].map((code) => ({
      caseTitle: `rejects an early exit ${code} without fatal output`,
      code,
    })),
  )("$caseTitle", async ({ code }) => {
    const result = await runChild(
      `process.stdout.write("ordinary early output"); process.exitCode = ${code};`,
    );
    assert.equal(result.passed, false);
    assert.equal(result.code, code);
    assert.equal(result.shutdownRequested, false);
    assert.deepEqual(result.failures, []);
    assert.equal(result.stdout, "ordinary early output");
  });

  it.skipIf(isWindows)("accepts survival followed by the requested graceful exit", async () => {
    const result = await runChild(`
      setInterval(() => {}, 1000);
      process.on("SIGTERM", () => process.stdout.write("graceful shutdown", () => process.exit(0)));
    `);
    assert.equal(result.passed, true);
    assert.equal(result.shutdownRequested, true);
    assert.equal(result.forcedKill, false);
    assert.equal(result.code, 0);
    assert.equal(result.stdout, "graceful shutdown");
  });

  it.skipIf(isWindows)("accepts the requested default SIGTERM shutdown", async () => {
    const result = await runChild("setInterval(() => {}, 1000);");
    assert.equal(result.passed, true);
    assert.equal(result.shutdownRequested, true);
    assert.equal(result.signal, "SIGTERM");
    assert.equal(result.forcedKill, false);
  });

  it.skipIf(isWindows)(
    "allows bounded native cleanup beyond two seconds with the default grace",
    async () => {
      const fixture = makeFixture();
      const result = await runDesktopSmoke({
        executable: process.execPath,
        args: [
          "-e",
          `
        setInterval(() => {}, 1000);
        process.on("SIGTERM", () => {
          setTimeout(() => {
            process.stdout.write("scoped cleanup complete", () => process.exit(0));
          }, 2250);
        });
      `,
        ],
        cwd: fixture.root,
        env: fixture.env,
        survivalMs: 1_000,
        // Omit shutdownGraceMs: this case exercises the production default.
      });
      assert.equal(result.passed, true);
      assert.equal(result.shutdownRequested, true);
      assert.equal(result.code, 0);
      assert.equal(result.signal, null);
      assert.equal(result.forcedKill, false);
      assert.equal(result.drainageTimedOut, false);
      assert.deepEqual(result.failures, []);
      assert.equal(result.stdout, "scoped cleanup complete");
      assert.equal(result.stderr, "");
      assert.throws(() => process.kill(result.pid, 0), /ESRCH/);
    },
  );

  it.skipIf(isWindows)("rejects a nonzero exit during requested shutdown", async () => {
    const result = await runChild(`
      setInterval(() => {}, 1000);
      process.on("SIGTERM", () => process.exit(9));
    `);
    assert.equal(result.passed, false);
    assert.equal(result.shutdownRequested, true);
    assert.equal(result.code, 9);
    assert.deepEqual(result.failures, []);
  });

  it.skipIf(isWindows)("rejects a child requiring forced termination", async () => {
    const result = await runChild(`
      setInterval(() => {}, 1000);
      process.on("SIGTERM", () => process.stdout.write("refused graceful shutdown"));
    `);
    assert.equal(result.passed, false);
    assert.equal(result.shutdownRequested, true);
    assert.equal(result.forcedKill, true);
    assert.equal(result.signal, "SIGKILL");
    assert.equal(result.stdout, "refused graceful shutdown");
  });

  it.skipIf(isWindows)(
    "drains both complete output streams before accepting a graceful exit",
    async () => {
      const result = await runChild(`
      setInterval(() => {}, 1000);
      process.on("SIGTERM", () => {
        process.stdout.write("O".repeat(256 * 1024), () =>
          process.stderr.write("E".repeat(256 * 1024), () => process.exit(0)));
      });
    `);
      assert.equal(result.passed, true);
      assert.equal(result.stdout, "O".repeat(256 * 1024));
      assert.equal(result.stderr, "E".repeat(256 * 1024));
      assert.equal(result.drainageTimedOut, false);
    },
  );

  it.skipIf(isWindows)("rejects fatal output arriving after the child exit", async () => {
    const descendant = `
      process.on("disconnect", () => process.stderr.write("Uncaught TypeError: late child output", () => process.exit(0)));
      process.send("ready");
    `;
    const result = await runChild(`
      const { spawn } = require("node:child_process");
      setInterval(() => {}, 1000);
      process.on("SIGTERM", () => {
        const descendant = spawn(process.execPath, ["-e", ${JSON.stringify(descendant)}], { stdio: ["ignore", "inherit", "inherit", "ipc"] });
        descendant.once("message", () => process.exit(0));
      });
    `);
    assert.equal(result.passed, false);
    assert.equal(result.code, 0);
    assert.equal(result.shutdownRequested, true);
    assert.equal(result.forcedKill, false);
    assert.equal(result.stderr, "Uncaught TypeError: late child output");
    assert.deepEqual(result.failures, ["Uncaught TypeError"]);
  });

  it.skipIf(isWindows)(
    "bounds incomplete drainage after an early exit without leaking the inherited-pipe descendant",
    async () => {
      const server = NodeNet.createServer();
      let socket;
      let closed;
      let pending;
      let descendantPid;
      server.on("connection", (connection) => {
        socket = connection;
        closed = new Promise((resolve) => connection.once("close", resolve));
        // An errored peer still closes and is released by the outer finally.
        connection.on("error", () => {});
      });
      try {
        server.listen(0, "127.0.0.1");
        await NodeEvents.once(server, "listening");
        const address = server.address();
        assert.isNotNull(address);
        assert.notEqual(typeof address, "string");
        const connected = NodeEvents.once(server, "connection", {
          signal: AbortSignal.timeout(5_000),
        });
        const descendant = `
          const net = require("node:net");
          const socket = net.connect(${address.port}, "127.0.0.1", () => {
            socket.write(String(process.pid));
            process.send("ready");
          });
          socket.on("data", () => process.exit(0));
          socket.on("end", () => process.exit(1));
          socket.on("error", () => process.exit(1));
          // Safety cleanup if the test's handshake itself fails; this is not
          // the successful test's ordering or incomplete-drainage proof.
          socket.setTimeout(5_000, () => process.exit(1));
        `;
        pending = runChild(`
          const { spawn } = require("node:child_process");
          const descendant = spawn(process.execPath, ["-e", ${JSON.stringify(descendant)}], {
            stdio: ["ignore", "inherit", "inherit", "ipc"]
          });
          descendant.once("message", () => process.exit(7));
        `);
        await connected;
        const [data] = await NodeEvents.once(socket, "data", {
          signal: AbortSignal.timeout(5_000),
        });
        descendantPid = Number(data.toString());
        assert.isTrue(Number.isInteger(descendantPid) && descendantPid > 0);
        const result = await pending;
        assert.equal(result.passed, false);
        assert.equal(result.code, 7);
        assert.equal(result.shutdownRequested, false);
        assert.equal(result.forcedKill, false);
        assert.equal(result.drainageTimedOut, true);
        assert.deepEqual(result.failures, []);
        // The descendant remains alive with both inherited pipes open until
        // this test releases it; bounded gate settlement cannot be normal EOF.
        assert.doesNotThrow(() => process.kill(descendantPid, 0));
      } finally {
        try {
          if (socket && !socket.destroyed) socket.write("finish");
          // The descendant closes this socket only as part of process.exit.
          if (closed) await closed;
          if (pending) await pending;
          if (Number.isInteger(descendantPid) && descendantPid > 0) {
            await waitForProcessExit(descendantPid);
          }
        } finally {
          if (server.listening) {
            await new Promise((resolve, reject) =>
              server.close((error) => (error ? reject(error) : resolve())),
            );
          }
        }
      }
    },
  );

  it("returns a launch failure without pretending the child survived", async () => {
    const fixture = makeFixture();
    const result = await runDesktopSmoke({
      executable: NodePath.join(fixture.root, "missing-executable"),
      env: fixture.env,
      survivalMs: 1_000,
      shutdownGraceMs: 1_000,
    });
    assert.equal(result.passed, false);
    assert.equal(result.shutdownRequested, false);
    assert.include(result.error, "ENOENT");
  });

  it("the actual CLI reports an early native child exit as failure", async () => {
    const fixture = makeFixture();
    const source = NodeFS.readFileSync(
      NodeURL.fileURLToPath(new URL("./smoke-test.mjs", import.meta.url)),
      "utf8",
    );
    const originalResolver =
      'import { resolveElectronLaunchCommand } from "./electron-launcher.mjs";';
    assert.equal(source.split(originalResolver).length, 2);
    const controlledResolver =
      'const resolveElectronLaunchCommand = () => ({ electronPath: process.execPath, args: ["-e", "process.exitCode = 7;"] });';
    const script = NodePath.join(fixture.root, "smoke-cli.mjs");
    // Only launch selection changes; the CLI and actual spawn gate are intact.
    NodeFS.writeFileSync(script, source.replace(originalResolver, controlledResolver));
    const result = NodeChildProcess.spawnSync(process.execPath, [script], {
      cwd: fixture.root,
      env: fixture.env,
      encoding: "utf8",
      timeout: 12_000,
    });
    assert.isUndefined(result.error);
    assert.equal(result.status, 1);
    assert.notInclude(result.stdout, "Desktop smoke test passed.");
    assert.include(result.stderr, "Child exited before the smoke deadline.");
    assert.include(result.stderr, "code=7");
  });
});
