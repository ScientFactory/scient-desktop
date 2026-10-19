const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { execFileSync } = require("node:child_process");
const { createHash } = require("node:crypto");
const { validateResult } = require("./thread-transfer-report.cjs");

const WORKFLOW = ".github/workflows/ci.yml";
const REQUIRED = [
  "check",
  "test_workspaces",
  "compute_changes",
  "windows_packaging_changes",
  "test",
  "test_web",
  "test_web_layout",
  "test_server",
  "transfer-report",
  "rust",
  "mobile_native_changes",
  "release_smoke",
];
const CONDITIONAL = {
  compute_native: ["compute_changes", "changed"],
  windows_packaging: ["windows_packaging_changes", "changed"],
  remote_server_packaging: ["windows_packaging_changes", "changed"],
  linux_packaging: ["windows_packaging_changes", "linux_changed"],
  mobile_native_static_analysis: ["mobile_native_changes", "changed"],
};
const SHA = /^[a-f0-9]{40}$/;
const MAX_REPORT = 64 * 1024 * 1024;
const assert = (condition, message) => {
  if (!condition) throw new Error(message);
};
const positive = (value) => Number.isSafeInteger(value) && value > 0;
const directory = (env) => path.join(env.RUNNER_TEMP, "ci-queue-reuse");

function identity(context, env) {
  assert(env.RUNNER_TEMP, "Runner temporary directory is missing");
  const repository = `${context.repo.owner}/${context.repo.repo}`;
  const runAttempt = Number(env.GITHUB_RUN_ATTEMPT);
  assert(SHA.test(context.sha) && context.sha === env.GITHUB_SHA, "Head identity is missing");
  assert(SHA.test(env.GITHUB_WORKFLOW_SHA), "Workflow source identity is missing");
  assert(positive(context.runId) && positive(runAttempt), "Run identity is missing");
  assert(context.workflow === "CI", "Unexpected workflow name");
  assert(
    env.GITHUB_WORKFLOW_REF?.startsWith(`${repository}/${WORKFLOW}@`),
    "Unexpected workflow path",
  );
  return {
    repository,
    workflow: WORKFLOW,
    workflowSha: env.GITHUB_WORKFLOW_SHA,
    runId: context.runId,
    runAttempt,
    headSha: context.sha,
  };
}

/** Queue-only evidence; the source run must additionally finish successfully before reuse. */
function writeReceipt({ context, core, needs, env = process.env }) {
  const who = identity(context, env);
  const group = context.payload.merge_group;
  assert(
    context.eventName === "merge_group" && group?.base_ref === "refs/heads/main",
    "Not the main merge queue",
  );
  assert(group.head_sha === who.headSha && SHA.test(group.base_sha), "Invalid queue comparison");
  assert(
    REQUIRED.every((job) => needs[job]?.result === "success"),
    "A required CI job did not succeed",
  );
  for (const [job, [gate, output]] of Object.entries(CONDITIONAL)) {
    assert(
      needs[job]?.result === "success" ||
        (needs[job]?.result === "skipped" && needs[gate]?.outputs?.[output] === "false"),
      `Native qualification is missing: ${job}`,
    );
  }
  const receipt = { schemaVersion: 1, ...who, baseSha: group.base_sha };
  fs.mkdirSync(directory(env), { recursive: true });
  fs.writeFileSync(path.join(directory(env), "receipt.json"), JSON.stringify(receipt) + "\n");
  core.info(`Qualified merge queue commit ${who.headSha} from ${group.base_sha}.`);
}

/** Reads exactly one bounded JSON member without extracting archive paths. */
function readArchive(bytes, filename, limit, env = process.env) {
  const scratch = fs.mkdtempSync(path.join(env.RUNNER_TEMP || os.tmpdir(), "ci-reuse-archive-"));
  try {
    const archive = path.join(scratch, "artifact.zip");
    fs.writeFileSync(archive, bytes);
    const names = execFileSync("unzip", ["-Z1", archive], {
      encoding: "utf8",
      maxBuffer: 64 * 1024,
      timeout: 30_000,
      stdio: ["ignore", "pipe", "pipe"],
    })
      .trim()
      .split("\n");
    assert(names.length === 1 && names[0] === filename, "Unexpected archive members");
    return execFileSync("unzip", ["-p", archive, filename], {
      maxBuffer: limit,
      timeout: 30_000,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

function validateVitest(value) {
  assert(value?.success === true, "Vitest did not succeed");
  assert(value.numFailedTests === 0 && value.numFailedTestSuites === 0, "Vitest reports failures");
  assert(
    Number.isSafeInteger(value.numTotalTests) && value.numTotalTests > 0,
    "Vitest report has no tests",
  );
  assert(
    Array.isArray(value.testResults) && value.testResults.length > 0,
    "Vitest suites are missing",
  );
  assert(
    value.testResults.every((suite) => suite.status === "passed" || suite.status === "pending"),
    "Vitest suite failed",
  );
}

function matchesRun(run, current, who) {
  return (
    run.id !== current.id &&
    run.workflow_id === current.workflow_id &&
    run.path === WORKFLOW &&
    run.repository?.full_name === who.repository &&
    run.head_repository?.full_name === who.repository &&
    run.event === "merge_group" &&
    run.head_sha === who.headSha &&
    run.head_branch?.startsWith("gh-readonly-queue/main/") &&
    positive(run.id) &&
    positive(run.run_attempt) &&
    run.status === "completed" &&
    run.conclusion === "success"
  );
}

/** Any missing evidence selects ordinary CI. Downloaded data is never executed. */
async function restore({ github, context, core, env = process.env, archiveReader = readArchive }) {
  core.setOutput("candidate", "false");
  if (context.eventName !== "push" || context.ref !== "refs/heads/main") return;
  let output;
  try {
    const who = identity(context, env);
    const baseSha = context.payload.before;
    assert(SHA.test(baseSha), "Push comparison is missing");
    output = directory(env);
    fs.rmSync(output, { recursive: true, force: true });
    const api = github.rest.actions;
    const repo = context.repo;
    const { data: current } = await api.getWorkflowRun({ ...repo, run_id: who.runId });
    assert(
      current.id === who.runId &&
        current.path === WORKFLOW &&
        current.event === "push" &&
        current.head_branch === "main" &&
        current.head_sha === who.headSha &&
        current.repository?.full_name === who.repository &&
        current.head_repository?.full_name === who.repository &&
        positive(current.workflow_id),
      "Current workflow identity differs",
    );
    const { data } = await api.listWorkflowRuns({
      ...repo,
      workflow_id: current.workflow_id,
      event: "merge_group",
      head_sha: who.headSha,
      status: "success",
      per_page: 20,
    });
    const source = data.workflow_runs.find((run) => matchesRun(run, current, who));
    assert(source, "No successful exact-commit queue run");
    const artifacts = await github.paginate(api.listWorkflowRunArtifacts, {
      ...repo,
      run_id: source.id,
      per_page: 100,
    });
    const download = async (name, filename, limit) => {
      const matching = artifacts.filter((artifact) => artifact.name === name && !artifact.expired);
      assert(
        matching.length === 1 && positive(matching[0].id),
        `Missing or ambiguous artifact ${name}`,
      );
      const artifact = matching[0];
      assert(
        artifact.size_in_bytes > 0 && artifact.size_in_bytes <= MAX_REPORT,
        `Artifact ${name} is too large`,
      );
      const response = await api.downloadArtifact({
        ...repo,
        artifact_id: artifact.id,
        archive_format: "zip",
      });
      const bytes = Buffer.from(response.data);
      assert(bytes.length > 0 && bytes.length <= MAX_REPORT, `Archive ${name} is too large`);
      if (artifact.digest != null) {
        assert(/^sha256:[a-f0-9]{64}$/.test(artifact.digest), "Unsupported artifact digest");
        assert(
          `sha256:${createHash("sha256").update(bytes).digest("hex")}` === artifact.digest,
          "Artifact digest differs",
        );
      }
      const raw = await archiveReader(bytes, filename, limit, env);
      assert(Buffer.byteLength(raw) <= limit, "Artifact member is too large");
      return JSON.parse(raw.toString());
    };
    const receipt = await download(
      `ci-queue-qualification-attempt-${source.run_attempt}`,
      "receipt.json",
      64 * 1024,
    );
    const expected = {
      schemaVersion: 1,
      repository: who.repository,
      workflow: WORKFLOW,
      workflowSha: who.workflowSha,
      runId: source.id,
      runAttempt: source.run_attempt,
      headSha: who.headSha,
      baseSha,
    };
    assert(
      Object.keys(receipt).length === Object.keys(expected).length &&
        Object.entries(expected).every(([key, value]) => receipt[key] === value),
      "Qualification receipt differs",
    );
    const staged = new Map();
    const transfer = await download(
      "thread-transfer-results",
      "thread-transfer-result.json",
      64 * 1024,
    );
    validateResult(transfer);
    staged.set("thread-transfer-result.json", transfer);
    for (const suite of ["web", "server"]) {
      for (const shard of [1, 2, 3]) {
        const filename = `vitest-${suite}-${shard}.json`;
        const report = await download(
          `vitest-${suite}-${shard}-attempt-${source.run_attempt}`,
          filename,
          MAX_REPORT,
        );
        validateVitest(report);
        staged.set(filename, report);
      }
    }
    // Recheck the attempt after downloads, in case the queue run was rerun meanwhile.
    const { data: latest } = await api.getWorkflowRun({ ...repo, run_id: source.id });
    assert(
      matchesRun(latest, current, who) && latest.run_attempt === source.run_attempt,
      "Source run changed during reuse",
    );
    fs.mkdirSync(output, { recursive: true });
    for (const [filename, value] of staged)
      fs.writeFileSync(path.join(output, filename), JSON.stringify(value) + "\n");
    core.setOutput("source_run_id", String(source.id));
    core.setOutput("source_url", `https://github.com/${who.repository}/actions/runs/${source.id}`);
    core.setOutput("candidate", "true");
  } catch (error) {
    try {
      if (output) fs.rmSync(output, { recursive: true, force: true });
    } catch {
      // A filesystem failure must still leave the candidate output false.
    }
    core.info(
      `Running full CI: ${error instanceof Error ? error.message : "queue qualification unavailable"}`,
    );
  }
}

module.exports = { writeReceipt, restore, readArchive };
