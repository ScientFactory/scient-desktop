import * as NodeAssert from "node:assert/strict";
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeTest from "node:test";
import * as NodeURL from "node:url";

const script = NodeURL.fileURLToPath(new URL("./wait-for-job.sh", import.meta.url));
const name = "resource-monitor-darwin-x64";
const started = "2026-11-10T19:30:00Z";
const job = (status, conclusion = null, startedAt = started) => ({
  jobs: [{ name: "Package macOS x64", status, conclusion, started_at: startedAt }],
});
const noJob = { jobs: [] };
// Each artifact's ID is its position in the list, from 1.
const artifacts = (...createdAt) => ({
  artifacts: createdAt.map((created_at, index) => ({
    id: index + 1,
    name,
    expired: false,
    created_at,
  })),
});

// A fake `gh` applies the script's own --jq filter to the next queued response for that
// endpoint (the last one repeats); `sleep` returns at once.
function waitForJob({ jobs, artifactLists, args = [] }) {
  const bin = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "scient-wait-for-job-"));
  try {
    const queue = (file, responses) =>
      NodeFS.writeFileSync(
        NodePath.join(bin, file),
        `${responses.map((response) => JSON.stringify(response)).join("\n")}\n`,
      );
    queue("jobs", jobs);
    queue("artifacts", artifactLists);
    NodeFS.writeFileSync(
      NodePath.join(bin, "gh"),
      `#!/usr/bin/env bash
set -euo pipefail
queue="${bin}/artifacts"
case "$2" in */jobs*) queue="${bin}/jobs" ;; esac
head -n 1 "$queue" | jq -r "$4"
if [ "$(wc -l < "$queue")" -gt 1 ]; then tail -n +2 "$queue" > "$queue.next" && mv "$queue.next" "$queue"; fi
`,
      { mode: 0o755 },
    );
    NodeFS.writeFileSync(NodePath.join(bin, "sleep"), "#!/usr/bin/env bash\n", { mode: 0o755 });
    const output = NodePath.join(bin, "output");
    NodeFS.writeFileSync(output, "");
    const result = NodeChildProcess.spawnSync(
      "bash",
      [script, "Package macOS x64", name, ...args],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          PATH: `${bin}${NodePath.delimiter}${process.env.PATH}`,
          GITHUB_REPOSITORY: "ScientFactory/scient-desktop",
          GITHUB_RUN_ID: "1",
          GITHUB_RUN_ATTEMPT: "2",
          GITHUB_OUTPUT: output,
        },
      },
    );
    return { ...result, output: NodeFS.readFileSync(output, "utf8") };
  } finally {
    NodeFS.rmSync(bin, { recursive: true, force: true });
  }
}

NodeTest.test("waits for the job to succeed and fails as soon as it ends otherwise", () => {
  NodeAssert.equal(
    waitForJob({
      jobs: [job("in_progress"), job("completed", "success")],
      artifactLists: [artifacts("2026-11-10T19:40:00Z")],
    }).status,
    0,
  );
  const failed = waitForJob({
    jobs: [job("in_progress"), job("completed", "failure")],
    artifactLists: [artifacts("2026-11-10T19:40:00Z")],
  });
  NodeAssert.equal(failed.status, 1);
  NodeAssert.match(failed.stderr, /ended without success \(failure\)/u);
});

NodeTest.test("--uploaded returns once this attempt uploads, before its job finishes", () => {
  NodeAssert.equal(
    waitForJob({
      jobs: [job("in_progress")],
      artifactLists: [artifacts(), artifacts(), artifacts("2026-11-10T19:35:00Z")],
      args: ["--uploaded"],
    }).status,
    0,
  );
});

NodeTest.test("--uploaded ignores an earlier attempt's copy while this attempt rebuilds", () => {
  const earlier = "2026-11-10T19:10:00Z";
  // Queued, then running: the earlier attempt's artifact must not satisfy the wait.
  const result = waitForJob({
    jobs: [job("queued", null, null), job("in_progress"), job("in_progress"), job("in_progress")],
    artifactLists: [
      artifacts(earlier),
      artifacts(earlier),
      artifacts(earlier, "2026-11-10T19:36:00Z"),
    ],
    args: ["--uploaded"],
  });
  NodeAssert.equal(result.status, 0);
  NodeAssert.equal(result.output, "artifact-id=2\n");
  const failedRebuild = waitForJob({
    jobs: [job("in_progress"), job("completed", "failure")],
    artifactLists: [artifacts(earlier)],
    args: ["--uploaded"],
  });
  NodeAssert.equal(failedRebuild.status, 1);
});

NodeTest.test("fails when the job succeeds without uploading in this attempt", () => {
  for (const args of [[], ["--uploaded"]]) {
    const succeeded = waitForJob({
      jobs: [job("in_progress"), job("completed", "success")],
      artifactLists: [artifacts("2026-11-10T19:10:00Z")],
      args,
    });
    NodeAssert.equal(succeeded.status, 1);
    NodeAssert.match(succeeded.stderr, /succeeded without uploading resource-monitor-darwin-x64/u);
    NodeAssert.equal(succeeded.output, "");
  }
});

NodeTest.test("names the newest upload of a job a partial rerun reused", () => {
  for (const args of [[], ["--uploaded"]]) {
    const reused = waitForJob({
      jobs: [noJob],
      artifactLists: [artifacts("2026-11-10T19:10:00Z", "2026-11-10T19:20:00Z")],
      args,
    });
    NodeAssert.equal(reused.status, 0);
    NodeAssert.equal(reused.output, "artifact-id=2\n");
  }
});
