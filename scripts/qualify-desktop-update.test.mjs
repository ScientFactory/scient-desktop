import * as NodeAssert from "node:assert/strict";
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeHttp from "node:http";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { test } from "vitest";
import {
  browserProcessId,
  devToolsActivePort,
  devToolsEndpoint,
  largestWindow,
  launchInstalled,
  linuxMainCandidates,
  payload,
  qualifyTiming,
  recordWindow,
  requireGracefulQuit,
  timingEvents,
  verifyHandoff,
} from "./qualify-desktop-update.mjs";

const sourceSha = "a".repeat(40);
const identity = { attemptId: "attempt-1", fromVersion: "0.0.1", targetVersion: "0.0.2" };
const launch = { launchId: "launch-2", processId: 123 };
const usable = { projectControlsVisible: true, composerUsable: true, windowUnlocked: true };
function receipts() {
  return [
    { ...identity, event: "confirmed" },
    { ...identity, event: "shutdown-started", elapsedMs: 20 },
    { ...identity, event: "native-handoff", elapsedMs: 30 },
    { ...identity, ...launch, event: "launched", confirmToLaunchMs: 40, handoffToLaunchMs: 10 },
    { ...identity, ...launch, event: "backend-ready", launchToBackendMs: 12 },
    {
      ...identity,
      ...launch,
      ...usable,
      event: "workspace-ready",
      projectRestored: true,
      confirmToReadyMs: 60,
      launchToReadyMs: 20,
    },
    { ...identity, ...launch, ...usable, event: "workspace-settled", settledAfterReadyMs: 1_004 },
  ];
}
const qualify = (events) => qualifyTiming(events, "0.0.1", "0.0.2");
const named = (events, name) => events.find((event) => event.event === name);

test("reports preparation, shutdown and genuinely usable workspace separately", () => {
  NodeAssert.deepEqual(qualify(receipts()), {
    attemptId: "attempt-1",
    processId: 123,
    preparationAndSaveMs: 20,
    shutdownMs: 10,
    handoffToLaunchMs: 10,
    launchToBackendMs: 12,
    launchToReadyMs: 20,
    confirmToReadyMs: 60,
    settledAfterReadyMs: 1_004,
  });
});

test("does not qualify a launch or a rendered window as a usable workspace", () => {
  NodeAssert.throws(
    () => qualify(receipts().filter((event) => event.event !== "workspace-ready")),
    /workspace-ready/,
  );
  const events = receipts();
  named(events, "workspace-ready").projectRestored = false;
  NodeAssert.throws(() => qualify(events), /project.*restored/i);
});

test("requires the relaunched process itself to show the project and take input, then and settled", () => {
  NodeAssert.throws(
    () => qualify(receipts().filter((event) => event.event !== "workspace-settled")),
    /workspace-settled/,
  );
  for (const name of ["workspace-ready", "workspace-settled"])
    for (const field of Object.keys(usable)) {
      const locked = receipts();
      named(locked, name)[field] = false;
      NodeAssert.throws(() => qualify(locked), new RegExp(`${name} needs ${field}`));
      // A target that predates the observation records nothing, which is not a pass.
      const unobserved = receipts();
      delete named(unobserved, name)[field];
      NodeAssert.throws(() => qualify(unobserved), new RegExp(`${name} needs ${field}`));
    }
});

test("rejects readiness from another launch, another process, or a mismatched version", () => {
  for (const name of ["workspace-ready", "workspace-settled"])
    for (const change of [
      { launchId: "unrelated-launch" },
      { processId: 456 },
      { targetVersion: "0.0.3" },
    ]) {
      const events = receipts();
      Object.assign(named(events, name), change);
      NodeAssert.throws(() => qualify(events));
    }
});

test("rejects duplicate relaunch readiness and abandoned attempts", () => {
  const duplicate = receipts();
  duplicate.push({ ...named(duplicate, "workspace-ready") });
  NodeAssert.throws(() => qualify(duplicate), /Exactly one workspace-ready/);
  NodeAssert.throws(
    () => qualify([...receipts(), { ...identity, event: "abandoned" }]),
    /abandoned/,
  );
});

test("rejects missing measurements and readiness predating the backend", () => {
  const missing = receipts();
  delete named(missing, "workspace-ready").confirmToReadyMs;
  NodeAssert.throws(() => qualify(missing), /confirmToReadyMs/);
  const early = receipts();
  named(early, "workspace-ready").launchToReadyMs = 1;
  NodeAssert.throws(() => qualify(early), /preceded/);
});

test("reads only the actual structured restart log events and tolerates an incomplete final write", () => {
  const fields = { ...identity, event: "confirmed", component: "desktop-restart" };
  const text =
    JSON.stringify({
      events: [
        { name: "restart timing", attributes: fields },
        { name: "unrelated event", attributes: fields },
      ],
    }) + '\n{"events":';
  NodeAssert.deepEqual(timingEvents(text), [fields]);
});

function candidate() {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "scient-update-evidence-test-"));
  const bytes = Buffer.from("immutable synthetic artifact");
  NodeFS.writeFileSync(NodePath.join(root, "payload.zip"), bytes);
  NodeFS.writeFileSync(
    NodePath.join(root, "scient-release-handoff.json"),
    JSON.stringify({
      schemaVersion: 1,
      product: "Scient",
      source: { repository: "ScientFactory/scient-desktop", commit: sourceSha },
      assets: [
        {
          name: "payload.zip",
          size: bytes.length,
          sha256: NodeCrypto.createHash("sha256").update(bytes).digest("hex"),
        },
      ],
    }),
  );
  return root;
}

test("refuses altered candidate bytes and a source commit different from the attestation", () => {
  const root = candidate();
  try {
    NodeAssert.equal(verifyHandoff(root, sourceSha).source.commit, sourceSha);
    NodeAssert.throws(() => verifyHandoff(root, "b".repeat(40)), /requested source commit/);
    NodeFS.writeFileSync(NodePath.join(root, "payload.zip"), "altered immutable artifact!!");
    NodeAssert.throws(() => verifyHandoff(root, sourceSha));
  } finally {
    NodeFS.rmSync(root, { recursive: true, force: true });
  }
});

test("refuses unsealed files instead of accidentally qualifying a substituted manifest", () => {
  const root = candidate();
  try {
    NodeFS.writeFileSync(NodePath.join(root, "latest-mac.yml"), "version: 9.9.9\n");
    NodeAssert.throws(() => verifyHandoff(root, sourceSha), /unsealed/);
  } finally {
    NodeFS.rmSync(root, { recursive: true, force: true });
  }
});

test("selects the Linux x86_64 payload for an x64 host and rejects changed archive bytes", () => {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "scient-update-payload-test-"));
  const bytes = Buffer.from("synthetic AppImage payload");
  const name = "Scient-0.0.119-x86_64.AppImage";
  const filename = NodePath.join(root, name);
  try {
    NodeFS.writeFileSync(filename, bytes);
    NodeFS.writeFileSync(
      NodePath.join(root, "latest-linux.yml"),
      JSON.stringify({
        version: "0.0.119",
        files: [
          { url: "Scient-0.0.119-arm64.AppImage", size: 1, sha512: "not-the-host-architecture" },
          {
            url: name,
            size: bytes.length,
            sha512: NodeCrypto.createHash("sha512").update(bytes).digest("base64"),
          },
        ],
      }),
    );
    NodeAssert.equal(payload(root, "linux", "x64").filename, filename);
    NodeFS.writeFileSync(filename, bytes.fill(1));
    NodeAssert.throws(() => payload(root, "linux", "x64"), NodeAssert.AssertionError);
  } finally {
    NodeFS.rmSync(root, { recursive: true, force: true });
  }
});

test("drives the app through Chromium's DevTools endpoint, not the disabled Node inspector", () => {
  const browserPath = "/devtools/browser/6d5c0d36-2f1e-4bb4-8f5e-3c3f0b9c1a77";
  const endpoint = devToolsEndpoint(
    [
      "Debugger listening on ws://127.0.0.1:9229/0f6c2c2a-5a77-4d4f-9a3e-2e1f2a3b4c5d",
      `DevTools listening on ws://127.0.0.1:53021${browserPath}\r`,
      "[main] backend starting",
    ].join("\n"),
  );
  NodeAssert.deepEqual(endpoint, {
    url: `ws://127.0.0.1:53021${browserPath}`,
    port: 53021,
    path: browserPath,
  });
  NodeAssert.equal(devToolsEndpoint("Debugger listening on ws://127.0.0.1:9229/abc\n"), undefined);
  NodeAssert.equal(
    devToolsEndpoint(`DevTools listening on ws://0.0.0.0:53021${browserPath}`),
    undefined,
  );
  NodeAssert.deepEqual(devToolsActivePort(`53021\r\n${browserPath}`), {
    port: 53021,
    path: browserPath,
  });
  NodeAssert.equal(devToolsActivePort("53021\n"), undefined, "a half-written file is not ready");
});

test("takes the main process from DevTools' one browser process", () => {
  const helpers = [
    { type: "renderer", id: 12 },
    { type: "GPU", id: 13 },
  ];
  NodeAssert.equal(browserProcessId([...helpers, { type: "browser", id: 11 }]), 11);
  NodeAssert.throws(() => browserProcessId(helpers), /exactly one browser/);
  NodeAssert.throws(
    () =>
      browserProcessId([
        { type: "browser", id: 11 },
        { type: "browser", id: 14 },
      ]),
    /exactly one browser/,
  );
});

test("captures the relaunched app's largest shown window and fails when it shows none", () => {
  NodeAssert.equal(
    largestWindow([
      { id: "tooltip", width: 300, height: 40 },
      { id: "main", width: 1280, height: 800 },
      { id: "hidden", width: 0, height: 0 },
    ]).id,
    "main",
  );
  NodeAssert.throws(() => largestWindow([{ id: "hidden", width: 0, height: 0 }]), /no window/);
});

test("counts only an ordinary quit through the app's own shutdown, never a forced exit", () => {
  const quitLog =
    "[10:43:22.645] INFO (#578): before-quit received\n  component: desktop-lifecycle\n";
  requireGracefulQuit(quitLog, { code: 0, signal: null });
  NodeAssert.throws(() => requireGracefulQuit(quitLog, { code: null, signal: "SIGTERM" }));
  NodeAssert.throws(() => requireGracefulQuit(quitLog, { code: 1, signal: null }));
  NodeAssert.throws(
    () => requireGracefulQuit("app ready\n", { code: 0, signal: null }),
    /own quit path/,
  );
  NodeAssert.throws(
    () =>
      requireGracefulQuit(`${quitLog}desktop main process exiting before shutdown completed\n`, {
        code: 0,
        signal: null,
      }),
    /finish its shutdown/,
  );
});

test("counts a second Linux instance from another AppImage mount as another main process", () => {
  NodeAssert.deepEqual(
    linuxMainCandidates(
      [
        { pid: 10, exe: "/tmp/appimage_extracted_aa/scient", command: "scient" },
        { pid: 11, exe: "/tmp/appimage_extracted_aa/scient", command: "scient --type=renderer" },
        { pid: 20, exe: "/tmp/.mount_ScientXy/scient", command: "/tmp/.mount_ScientXy/scient" },
        { pid: 30, exe: "/home/runner/installed/Scient.AppImage", command: "Scient.AppImage" },
        { pid: 40, exe: "/usr/bin/node", command: "node scient" },
      ],
      "scient",
    ).map((candidate) => candidate.pid),
    [10, 20],
  );
});

// A DevTools browser endpoint: it answers the process list for `pid()` and records every method
// it receives. Unfragmented frames only, as the harness sends.
async function devToolsStub(pid) {
  const methods = [];
  const sockets = new Set();
  const server = NodeHttp.createServer();
  server.on("upgrade", (request, socket) => {
    sockets.add(socket);
    socket.on("error", () => {});
    const accept = NodeCrypto.createHash("sha1")
      .update(`${request.headers["sec-websocket-key"]}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
      .digest("base64");
    socket.write(
      `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`,
    );
    let pending = Buffer.alloc(0);
    socket.on("data", (chunk) => {
      pending = Buffer.concat([pending, chunk]);
      while (pending.length >= 2) {
        const opcode = pending[0] & 0x0f;
        let length = pending[1] & 0x7f;
        let offset = 2;
        if (length === 126) {
          if (pending.length < 4) return;
          length = pending.readUInt16BE(2);
          offset = 4;
        }
        if (pending.length < offset + 4 + length) return;
        const mask = pending.subarray(offset, offset + 4);
        const data = pending
          .subarray(offset + 4, offset + 4 + length)
          .map((byte, index) => byte ^ mask[index % 4]);
        pending = pending.subarray(offset + 4 + length);
        if (opcode === 8) return void socket.end(Buffer.from([0x88, 0]));
        if (opcode !== 1) continue;
        const message = JSON.parse(Buffer.from(data).toString());
        methods.push(message.method);
        const reply = Buffer.from(
          JSON.stringify({
            id: message.id,
            result:
              message.method === "SystemInfo.getProcessInfo"
                ? {
                    processInfo: [
                      { type: "renderer", id: 1 },
                      { type: "browser", id: pid() },
                    ],
                  }
                : {},
          }),
        );
        const header =
          reply.length < 126
            ? Buffer.from([0x81, reply.length])
            : Buffer.from([0x81, 126, reply.length >> 8, reply.length & 0xff]);
        socket.write(Buffer.concat([header, reply]));
      }
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    port: server.address().port,
    methods,
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

// A stand-in app: announces a DevTools endpoint answering for `owner(appPid)` (by default
// itself), writes it into its user data, and on SIGTERM exits as a quit (logging the app's own
// quit receipt only when FAKE_GRACEFUL is set).
async function fakeApp(owner = (appPid) => appPid) {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "scient-qualify-launch-test-"));
  const executable = NodePath.join(root, "fake-app.mjs");
  NodeFS.writeFileSync(
    executable,
    `#!/usr/bin/env node
import * as NodeFS from "node:fs";
const userData = process.env.FAKE_USER_DATA;
const port = process.env.FAKE_DEVTOOLS_PORT;
NodeFS.writeFileSync(userData + "/pid", String(process.pid));
NodeFS.writeFileSync(userData + "/DevToolsActivePort", port + "\\n/devtools/browser/fake");
console.error("DevTools listening on ws://127.0.0.1:" + port + "/devtools/browser/fake");
process.on("SIGTERM", () => {
  if (process.env.FAKE_GRACEFUL === "1") console.log("before-quit received");
  process.exit(0);
});
setInterval(() => {}, 1000);
`,
  );
  NodeFS.chmodSync(executable, 0o755);
  const appPid = () => Number(NodeFS.readFileSync(NodePath.join(root, "pid"), "utf8"));
  const devtools = await devToolsStub(() => owner(appPid()));
  // Playwright's connection: close() only disconnects; Browser.close asks the app to quit.
  const browser = ({ sessions = () => true } = {}) => ({
    newBrowserCDPSession: async () => {
      if (!sessions()) throw new Error("Target closed");
      return {
        send: async (method) => {
          if (method === "Browser.close") process.kill(appPid(), "SIGTERM");
        },
      };
    },
    contexts: () => [{ pages: () => [{ evaluate: async () => true }] }],
    close: async () => {},
  });
  let connects = 0;
  const launch = (fake, graceful) =>
    launchInstalled({
      executable,
      env: {
        ...process.env,
        FAKE_USER_DATA: root,
        FAKE_DEVTOOLS_PORT: String(devtools.port),
        FAKE_GRACEFUL: graceful ? "1" : "0",
      },
      userData: root,
      platform: "darwin",
      log: NodePath.join(root, "output.log"),
      connect: async () => {
        connects += 1;
        return fake;
      },
    });
  return {
    appPid,
    browser,
    launch,
    devtools,
    connects: () => connects,
    dispose: async () => {
      await devtools.close();
      NodeFS.rmSync(root, { recursive: true, force: true });
    },
  };
}

// The stand-ins are scripts started through their #! line, which Windows does not run.
const posixHost = HostProcess.Platform.defaultValue() !== "win32";

test.runIf(posixHost)(
  "only reads the process list of a DevTools endpoint it did not start, and leaves that process",
  async () => {
    const foreign = NodeChildProcess.spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"]);
    const app = await fakeApp(() => foreign.pid);
    try {
      await NodeAssert.rejects(app.launch(app.browser(), true), /did not start/);
      NodeAssert.deepEqual(app.devtools.methods, ["SystemInfo.getProcessInfo"]);
      NodeAssert.equal(app.connects(), 0, "Playwright must not connect to it");
      NodeAssert.equal(alive(foreign.pid), true, "The other process must keep running");
      NodeAssert.equal(alive(app.appPid()), false, "The harness's own launch is stopped");
    } finally {
      foreign.kill("SIGKILL");
      await app.dispose();
    }
  },
);

test.runIf(posixHost)(
  "quits only through the app's own quit and never falls back to killing it",
  async () => {
    const app = await fakeApp();
    try {
      await (await app.launch(app.browser(), true)).quit();
      NodeAssert.equal(alive(app.appPid()), false);

      // The app exited, but without its quit receipt: not an ordinary quit.
      await NodeAssert.rejects((await app.launch(app.browser(), false)).quit(), /own quit path/);

      // DevTools fails after launch: the quit fails and leaves the app to cleanup, unkilled.
      let sessions = true;
      const launched = await app.launch(app.browser({ sessions: () => sessions }), true);
      sessions = false;
      await NodeAssert.rejects(launched.quit(), /Target closed/);
      NodeAssert.equal(alive(app.appPid()), true);
      await launched.stop();
      NodeAssert.equal(alive(app.appPid()), false);
    } finally {
      await app.dispose();
    }
  },
);

test.runIf(posixHost)(
  "finishes the video encoder even when stopping the screencast hangs",
  async () => {
    const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "scient-qualify-video-test-"));
    // An encoder that notes the end of its input but never exits by itself.
    const encoder = NodePath.join(root, "encoder.mjs");
    NodeFS.writeFileSync(
      encoder,
      `#!/usr/bin/env node
import * as NodeFS from "node:fs";
const output = process.argv.at(-1);
NodeFS.writeFileSync(output + ".pid", String(process.pid));
process.stdin.on("end", () => NodeFS.writeFileSync(output + ".eof", ""));
process.stdin.resume();
setInterval(() => {}, 1000);
`,
    );
    NodeFS.chmodSync(encoder, 0o755);
    const video = NodePath.join(root, "restart.webm");
    const page = {
      screencast: { start: async () => {}, stop: () => new Promise(() => {}) },
    };
    try {
      const stop = await recordWindow(page, video, { encoder, timeout: 1_000 });
      const stopping = stop();
      // Cleanup stops the recording again: it gets the same stop, not a second wait.
      NodeAssert.equal(stop(), stopping, "Stopping must run once");
      await NodeAssert.rejects(stopping, /screencast hung/);
      NodeAssert.ok(NodeFS.existsSync(`${video}.eof`), "The encoder's input must be closed");
      const pid = Number(NodeFS.readFileSync(`${video}.pid`, "utf8"));
      NodeAssert.equal(alive(pid), false, "An encoder that outlives its deadline is killed");
    } finally {
      if (NodeFS.existsSync(`${video}.pid`)) {
        const pid = Number(NodeFS.readFileSync(`${video}.pid`, "utf8"));
        if (alive(pid)) process.kill(pid, "SIGKILL");
      }
      NodeFS.rmSync(root, { recursive: true, force: true });
    }
  },
);

test.runIf(posixHost)("finishes the video encoder when the screencast cannot start", async () => {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "scient-qualify-video-test-"));
  // An encoder that notes the end of its input but never exits by itself.
  const encoder = NodePath.join(root, "encoder.mjs");
  NodeFS.writeFileSync(
    encoder,
    `#!/usr/bin/env node
import * as NodeFS from "node:fs";
const output = process.argv.at(-1);
NodeFS.writeFileSync(output + ".pid", String(process.pid));
process.stdin.on("end", () => NodeFS.writeFileSync(output + ".eof", ""));
process.stdin.resume();
setInterval(() => {}, 1000);
`,
  );
  NodeFS.chmodSync(encoder, 0o755);
  const video = NodePath.join(root, "restart.webm");
  const page = {
    screencast: {
      // The page goes away once the encoder has started.
      start: () =>
        new Promise((_resolve, reject) => {
          const fail = () => {
            if (!NodeFS.existsSync(`${video}.pid`)) return;
            watcher.close();
            reject(new Error("Target page, context or browser has been closed"));
          };
          const watcher = NodeFS.watch(root, fail);
          fail();
        }),
      stop: async () => {},
    },
  };
  try {
    await NodeAssert.rejects(
      recordWindow(page, video, { encoder, timeout: 1_000 }),
      /has been closed/,
    );
    NodeAssert.ok(NodeFS.existsSync(`${video}.eof`), "The encoder's input must be closed");
    const pid = Number(NodeFS.readFileSync(`${video}.pid`, "utf8"));
    NodeAssert.equal(alive(pid), false, "An encoder left without a recording is killed");
  } finally {
    if (NodeFS.existsSync(`${video}.pid`)) {
      const pid = Number(NodeFS.readFileSync(`${video}.pid`, "utf8"));
      if (alive(pid)) process.kill(pid, "SIGKILL");
    }
    NodeFS.rmSync(root, { recursive: true, force: true });
  }
});
