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

// A fake `gh` applies the script's --jq filter to the next queued response for that endpoint
// (the last repeats); a queued `apiError` fails after printing an error body to stdout, as `gh
// api` does. A fake `curl` answers the download endpoint with the next queued HTTP status and
// records the URL; `sleep` returns at once.
function waitForJob({
  jobs,
  artifactLists,
  downloads = [302],
  args = [],
  unwritableOutput = false,
}) {
  const bin = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "scient-wait-for-job-"));
  try {
    const queue = (file, responses) =>
      NodeFS.writeFileSync(
        NodePath.join(bin, file),
        `${responses.map((response) => JSON.stringify(response)).join("\n")}\n`,
      );
    queue("jobs", jobs);
    queue("artifacts", artifactLists);
    queue("downloads", downloads);
    const downloadRequests = NodePath.join(bin, "download-requests");
    NodeFS.writeFileSync(downloadRequests, "");
    NodeFS.writeFileSync(
      NodePath.join(bin, "gh"),
      `#!/usr/bin/env bash
set -euo pipefail
queue="${bin}/artifacts"
case "$2" in */jobs*) queue="${bin}/jobs" ;; esac
line="$(head -n 1 "$queue")"
if [ "$(wc -l < "$queue")" -gt 1 ]; then tail -n +2 "$queue" > "$queue.next" && mv "$queue.next" "$queue"; fi
if [ "$line" = '"apiError"' ]; then echo '{"message": "Bad Gateway"}'; echo "HTTP 502: Bad Gateway" >&2; exit 1; fi
printf '%s\\n' "$line" | jq -r "$4"
`,
      { mode: 0o755 },
    );
    NodeFS.writeFileSync(
      NodePath.join(bin, "curl"),
      `#!/usr/bin/env bash
set -euo pipefail
queue="${bin}/downloads"
[[ " $* " == *" Authorization: Bearer test-token "* ]] || { echo "unauthenticated" >&2; exit 2; }
printf '%s\\n' "\${@: -1}" >> "${downloadRequests}"
head -n 1 "$queue"
if [ "$(wc -l < "$queue")" -gt 1 ]; then tail -n +2 "$queue" > "$queue.next" && mv "$queue.next" "$queue"; fi
`,
      { mode: 0o755 },
    );
    NodeFS.writeFileSync(NodePath.join(bin, "sleep"), "#!/usr/bin/env bash\n", { mode: 0o755 });
    const output = NodePath.join(bin, "output");
    // A directory in place of the output file makes every write to it fail.
    if (unwritableOutput) NodeFS.mkdirSync(output);
    else NodeFS.writeFileSync(output, "");
    const result = NodeChildProcess.spawnSync(
      "bash",
      [script, "Package macOS x64", name, ...args],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          PATH: `${bin}${NodePath.delimiter}${process.env.PATH}`,
          GITHUB_REPOSITORY: "ScientFactory/scient-desktop",
          GITHUB_API_URL: "https://api.example.test",
          GH_TOKEN: "test-token",
          GITHUB_RUN_ID: "1",
          GITHUB_RUN_ATTEMPT: "2",
          GITHUB_OUTPUT: output,
        },
      },
    );
    return {
      ...result,
      output: unwritableOutput ? "" : NodeFS.readFileSync(output, "utf8"),
      downloadRequests: NodeFS.readFileSync(downloadRequests, "utf8").split("\n").filter(Boolean),
    };
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

NodeTest.test("retries a failed API request, and fails the wait if it keeps failing", () => {
  const uploadedAt = "2026-11-10T19:40:00Z";
  const retried = waitForJob({
    jobs: ["apiError", job("completed", "success")],
    artifactLists: ["apiError", artifacts(uploadedAt)],
  });
  NodeAssert.equal(retried.status, 0);
  NodeAssert.equal(retried.output, "artifact-id=1\n");
  const down = waitForJob({
    jobs: [job("completed", "success")],
    artifactLists: ["apiError"],
  });
  NodeAssert.equal(down.status, 1);
  NodeAssert.match(down.stderr, /Could not list resource-monitor-darwin-x64 uploads/u);
  NodeAssert.doesNotMatch(down.stderr, /succeeded without uploading/u);
});

NodeTest.test("names an upload only once GitHub has served its download twice in a row", () => {
  const download =
    "https://api.example.test/repos/ScientFactory/scient-desktop/actions/artifacts/1/zip";
  for (const [args, status] of [
    [[], job("completed", "success")],
    [["--uploaded"], job("in_progress")],
  ]) {
    // Listed, then refused, then served once, refused again, and finally served twice.
    const settled = waitForJob({
      jobs: [status],
      artifactLists: [artifacts("2026-11-10T19:40:00Z")],
      downloads: [404, 302, 404, 302, 302],
      args,
    });
    NodeAssert.equal(settled.status, 0);
    NodeAssert.equal(settled.output, "artifact-id=1\n");
    NodeAssert.deepEqual(settled.downloadRequests, Array(5).fill(download));
  }
});

NodeTest.test("fails the wait when GitHub keeps refusing a listed upload's download", () => {
  const refused = waitForJob({
    jobs: [job("completed", "success")],
    artifactLists: [artifacts("2026-11-10T19:40:00Z")],
    downloads: [404],
  });
  NodeAssert.equal(refused.status, 1);
  NodeAssert.equal(refused.output, "");
  NodeAssert.equal(refused.downloadRequests.length, 30);
  NodeAssert.match(
    refused.stderr,
    /Download check for resource-monitor-darwin-x64 1 answered HTTP 404/u,
  );
  NodeAssert.match(
    refused.stderr,
    /resource-monitor-darwin-x64 1 is listed, but GitHub still refuses to download it/u,
  );
});

NodeTest.test("fails the wait when it cannot record the upload's ID", () => {
  const unrecorded = waitForJob({
    jobs: [job("completed", "success")],
    artifactLists: [artifacts("2026-11-10T19:40:00Z")],
    unwritableOutput: true,
  });
  NodeAssert.equal(unrecorded.status, 1);
  NodeAssert.match(
    unrecorded.stderr,
    /Could not record resource-monitor-darwin-x64 1 as the step output/u,
  );
});
