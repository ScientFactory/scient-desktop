import * as NodeAssert from "node:assert/strict";
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeTest from "node:test";
import * as NodeURL from "node:url";

const script = NodeURL.fileURLToPath(new URL("./wait-for-job.sh", import.meta.url));

// A fake `gh` answers each poll from a queue (the last answer repeats); `sleep` returns at once.
function waitForJob({ jobStates, artifactCounts, args = [] }) {
  const bin = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "scient-wait-for-job-"));
  try {
    NodeFS.writeFileSync(NodePath.join(bin, "jobs"), `${jobStates.join("\n")}\n`);
    NodeFS.writeFileSync(NodePath.join(bin, "artifacts"), `${artifactCounts.join("\n")}\n`);
    NodeFS.writeFileSync(
      NodePath.join(bin, "gh"),
      `#!/usr/bin/env bash
queue="${bin}/artifacts"
case "$2" in */jobs*) queue="${bin}/jobs" ;; esac
head -n 1 "$queue"
if [ "$(wc -l < "$queue")" -gt 1 ]; then tail -n +2 "$queue" > "$queue.next" && mv "$queue.next" "$queue"; fi
`,
      { mode: 0o755 },
    );
    NodeFS.writeFileSync(NodePath.join(bin, "sleep"), "#!/usr/bin/env bash\n", { mode: 0o755 });
    return NodeChildProcess.spawnSync(
      "bash",
      [script, "Package macOS x64", "resource-monitor-darwin-x64", ...args],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          PATH: `${bin}${NodePath.delimiter}${process.env.PATH}`,
          GITHUB_REPOSITORY: "ScientFactory/scient-desktop",
          GITHUB_RUN_ID: "1",
          GITHUB_RUN_ATTEMPT: "1",
        },
      },
    );
  } finally {
    NodeFS.rmSync(bin, { recursive: true, force: true });
  }
}

NodeTest.test("waits for the job to succeed and fails as soon as it ends otherwise", () => {
  NodeAssert.equal(
    waitForJob({
      jobStates: ["in_progress ", "completed success"],
      artifactCounts: ["1"],
    }).status,
    0,
  );
  const failed = waitForJob({
    jobStates: ["in_progress ", "completed failure"],
    artifactCounts: ["1"],
  });
  NodeAssert.equal(failed.status, 1);
  NodeAssert.match(failed.stderr, /ended without success \(completed failure\)/u);
});

NodeTest.test("--uploaded returns once the artifact exists, before its job finishes", () => {
  NodeAssert.equal(
    waitForJob({
      jobStates: ["in_progress "],
      artifactCounts: ["0", "0", "1"],
      args: ["--uploaded"],
    }).status,
    0,
  );
});

NodeTest.test("--uploaded fails when the job ends without the artifact", () => {
  const succeeded = waitForJob({
    jobStates: ["in_progress ", "completed success"],
    artifactCounts: ["0"],
    args: ["--uploaded"],
  });
  NodeAssert.equal(succeeded.status, 1);
  NodeAssert.match(succeeded.stderr, /succeeded without uploading resource-monitor-darwin-x64/u);
  const failed = waitForJob({
    jobStates: ["completed failure"],
    artifactCounts: ["0"],
    args: ["--uploaded"],
  });
  NodeAssert.equal(failed.status, 1);
});

NodeTest.test("accepts the artifact of a job a partial rerun reused", () => {
  NodeAssert.equal(waitForJob({ jobStates: ["absent "], artifactCounts: ["1"] }).status, 0);
});
