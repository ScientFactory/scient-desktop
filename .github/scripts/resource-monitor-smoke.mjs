import * as NodeAssert from "node:assert/strict";
import * as NodeChildProcess from "node:child_process";
import * as NodeURL from "node:url";

export async function smokeResourceMonitor({
  monitorPath,
  expectedArch,
  args = [],
  timeoutMs = 15_000,
}) {
  const monitor = NodeChildProcess.spawn(monitorPath, args, { stdio: ["pipe", "pipe", "inherit"] });
  monitor.stdout.setEncoding("utf8");
  let output = "";
  let hello;
  let pending = "";
  let timer;
  try {
    await new Promise((resolve, reject) => {
      timer = setTimeout(
        () => reject(new Error("Resource monitor smoke test timed out")),
        timeoutMs,
      );
      monitor.on("error", reject);
      monitor.stdin.on("error", reject);
      monitor.stdout.on("data", (chunk) => {
        output += chunk;
        pending += chunk;
        if (hello || !pending.includes("\n")) return;
        try {
          hello = JSON.parse(pending.slice(0, pending.indexOf("\n")));
          NodeAssert.equal(hello.type, "hello");
          NodeAssert.equal(hello.arch, expectedArch);
          const send = (message) =>
            monitor.stdin.write(`${JSON.stringify({ version: hello.version, ...message })}\n`);
          send({ type: "configure", rootPid: process.pid, sampleIntervalMs: 1000 });
          send({ type: "sampleNow", requestId: "verify" });
          monitor.stdin.end();
        } catch (error) {
          reject(error);
        }
      });
      monitor.on("close", (code) => {
        try {
          NodeAssert.equal(code, 0, `Resource monitor exit: ${code}`);
          NodeAssert.ok(hello, "Resource monitor exited before hello");
          const sample = output
            .split("\n")
            .filter((line) => line.trim())
            .map((line) => JSON.parse(line))
            .find((message) => message.requestId === "verify");
          NodeAssert.equal(sample?.type, "snapshot", "Resource monitor did not return a snapshot");
          NodeAssert.ok(sample.processes.some((entry) => entry.pid === process.pid));
          resolve();
        } catch (error) {
          reject(error);
        }
      });
    });
  } finally {
    clearTimeout(timer);
    // Only the child launched above is ours; a failed protocol must not leave it running.
    if (monitor.exitCode === null) monitor.kill();
  }
}

if (process.argv[1] && import.meta.url === NodeURL.pathToFileURL(process.argv[1]).href) {
  await smokeResourceMonitor({
    monitorPath: process.env.MONITOR,
    expectedArch: process.env.EXPECTED_ARCH,
  });
  console.log("Resource monitor returned its architecture and sampled the verifier process.");
}
