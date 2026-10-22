import * as NodeAssert from "node:assert/strict";
import * as NodeTest from "node:test";
import { smokeResourceMonitor } from "./resource-monitor-smoke.mjs";

const fake = (body, timeoutMs = 2000) =>
  smokeResourceMonitor({
    monitorPath: process.execPath,
    expectedArch: "x86_64",
    args: ["-e", body],
    timeoutMs,
  });

NodeTest.test(
  "checks the monitor hello, configuration and snapshot through real stdio",
  async () => {
    await fake(`
    console.log(JSON.stringify({ type: "hello", arch: "x86_64", version: 1 }));
    let pending = "", rootPid;
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", chunk => {
      pending += chunk;
      let end;
      while ((end = pending.indexOf("\\n")) !== -1) {
        const message = JSON.parse(pending.slice(0, end)); pending = pending.slice(end + 1);
        if (message.type === "configure") rootPid = message.rootPid;
        if (message.type === "sampleNow") {
          if (message.version !== 1 || !rootPid) process.exit(2);
          console.log(JSON.stringify({ type: "snapshot", requestId: message.requestId, processes: [{pid: rootPid}] }));
        }
      }
    });
  `);
  },
);

NodeTest.test("rejects the wrong native architecture", async () => {
  await NodeAssert.rejects(
    fake(`
    console.log(JSON.stringify({ type: "hello", arch: "aarch64", version: 1 }));
    setInterval(() => {}, 1000);
  `),
    /aarch64/,
  );
});

NodeTest.test("rejects a monitor that exits without a sample", async () => {
  await NodeAssert.rejects(
    fake(`
    console.log(JSON.stringify({ type: "hello", arch: "x86_64", version: 1 }));
    process.stdin.resume();
  `),
    /snapshot/,
  );
});

NodeTest.test("bounds a silent monitor and stops its child", async () => {
  await NodeAssert.rejects(fake("setInterval(() => {}, 1000)", 100), /timed out/);
});
