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
// The main ruleset lands at most this many queue entries in one push (max_entries_to_merge).
const MAX_QUEUE_SEGMENTS = 4;
const SCHEMA = 2;
const RECEIPT_KEYS = [
  "schemaVersion",
  "event",
  "repository",
  "workflow",
  "workflowSha",
  "runId",
  "runAttempt",
  "headSha",
  "baseSha",
  "treeSha",
  "reusedFrom",
];
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

async function commitOf(github, repo, sha) {
  const { data } = await github.rest.git.getCommit({ ...repo, commit_sha: sha });
  const parents = (data.parents ?? []).map((parent) => parent.sha);
  assert(
    data.sha === sha && SHA.test(data.tree?.sha ?? "") && parents.every((p) => SHA.test(p)),
    "Commit identity is missing",
  );
  return { tree: data.tree.sha, parents };
}

/**
 * Records what a successful run tested: the exact content (tree) and the comparison base its
 * change gates used. Queue runs and same-repository PR runs write one. A queue run that reused
 * PR qualification records its source instead of its own lanes.
 */
async function writeReceipt({ github, context, core, needs, env = process.env }) {
  const who = identity(context, env);
  let baseSha;
  if (context.eventName === "merge_group") {
    const group = context.payload.merge_group;
    assert(group?.base_ref === "refs/heads/main", "Not the main merge queue");
    assert(group.head_sha === who.headSha && SHA.test(group.base_sha), "Invalid queue comparison");
    baseSha = group.base_sha;
  } else if (context.eventName === "pull_request") {
    const pr = context.payload.pull_request;
    assert(
      pr?.base?.ref === "main" && pr.base.repo?.full_name === who.repository,
      "Not a pull request into main",
    );
    assert(pr.head?.repo?.full_name === who.repository, "Fork pull requests are never reused");
    assert(SHA.test(pr.base.sha) && SHA.test(pr.head.sha), "Invalid pull request comparison");
    baseSha = pr.base.sha;
  } else {
    throw new Error("Not a pull request or the main merge queue");
  }
  let reusedFrom = null;
  if (needs.queue_ci?.outputs?.reused === "true") {
    assert(context.eventName === "merge_group", "Only queue runs reuse qualification");
    assert(needs.queue_ci.result === "success", "Reuse probe did not succeed");
    for (const job of ["test", "transfer-report"])
      assert(needs[job]?.result === "success", "A required CI job did not succeed");
    reusedFrom = Number(needs.queue_ci.outputs.source_run_id);
    assert(positive(reusedFrom), "Reused qualification source is missing");
  } else {
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
  }
  const commit = await commitOf(github, context.repo, who.headSha);
  if (
    context.eventName === "pull_request" &&
    !(
      commit.parents.length === 2 &&
      commit.parents[0] === baseSha &&
      commit.parents[1] === context.payload.pull_request.head.sha
    )
  ) {
    // The gates compared against the event's base; reuse requires the tested merge to join it.
    core.info("The tested merge commit does not join this PR's base and head; nothing recorded.");
    return false;
  }
  const receipt = {
    schemaVersion: SCHEMA,
    event: context.eventName,
    ...who,
    baseSha,
    treeSha: commit.tree,
    reusedFrom,
  };
  fs.mkdirSync(directory(env), { recursive: true });
  fs.writeFileSync(path.join(directory(env), "receipt.json"), JSON.stringify(receipt) + "\n");
  core.info(`Qualified ${who.headSha} (content ${commit.tree}) from ${baseSha}.`);
  return true;
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

function matchesRun(run, current, who, event, headSha) {
  return (
    run.id !== current.id &&
    run.workflow_id === current.workflow_id &&
    run.path === WORKFLOW &&
    run.repository?.full_name === who.repository &&
    run.head_repository?.full_name === who.repository &&
    run.event === event &&
    run.head_sha === headSha &&
    (event !== "merge_group" || run.head_branch?.startsWith("gh-readonly-queue/main/")) &&
    positive(run.id) &&
    positive(run.run_attempt) &&
    run.status === "completed" &&
    run.conclusion === "success"
  );
}

function checkReceipt(receipt, expected) {
  assert(
    receipt !== null &&
      typeof receipt === "object" &&
      Object.keys(receipt).length === RECEIPT_KEYS.length &&
      RECEIPT_KEYS.every((key) => Object.hasOwn(receipt, key)) &&
      Object.entries(expected).every(([key, value]) => receipt[key] === value) &&
      [receipt.headSha, receipt.workflowSha, receipt.baseSha, receipt.treeSha].every((sha) =>
        SHA.test(sha),
      ) &&
      (receipt.reusedFrom === null || positive(receipt.reusedFrom)),
    "Qualification receipt differs",
  );
}

/** The newest successful run of this workflow for one head, with its qualification receipt. */
async function qualifiedRun({ github, repo, current, who, event, headSha, env, archiveReader }) {
  const api = github.rest.actions;
  const { data } = await api.listWorkflowRuns({
    ...repo,
    workflow_id: current.workflow_id,
    event,
    head_sha: headSha,
    status: "success",
    per_page: 20,
  });
  const run = data.workflow_runs.find((candidate) =>
    matchesRun(candidate, current, who, event, headSha),
  );
  assert(run, `No successful exact-content ${event} run`);
  const artifacts = await github.paginate(api.listWorkflowRunArtifacts, {
    ...repo,
    run_id: run.id,
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
  const prefix = event === "merge_group" ? "queue" : "pr";
  const receipt = await download(
    `ci-${prefix}-qualification-attempt-${run.run_attempt}`,
    "receipt.json",
    64 * 1024,
  );
  return { run, receipt, download };
}

/**
 * A main push lands one or more queue entries. Each entry's queue run must have qualified that
 * exact commit from its first parent, back to the commit main held before the push.
 */
async function pushSegments(probe) {
  const { github, repo, who, before } = probe;
  const segments = [];
  for (let head = who.headSha; head !== before;) {
    assert(segments.length < MAX_QUEUE_SEGMENTS, "Push is not covered by queue qualification");
    const segment = await qualifiedRun({ ...probe, event: "merge_group", headSha: head });
    checkReceipt(segment.receipt, {
      schemaVersion: SCHEMA,
      event: "merge_group",
      repository: who.repository,
      workflow: WORKFLOW,
      workflowSha: head,
      runId: segment.run.id,
      runAttempt: segment.run.run_attempt,
      headSha: head,
    });
    const commit = await commitOf(github, repo, head);
    assert(
      commit.tree === segment.receipt.treeSha && commit.parents[0] === segment.receipt.baseSha,
      "Qualification receipt differs",
    );
    segments.push(segment);
    head = segment.receipt.baseSha;
  }
  assert(segments.length > 0, "Push comparison is missing");
  return segments;
}

/**
 * A queue entry merges one PR onto its base. Its passing PR run qualifies it only when that run
 * tested this exact content against this exact base, from a workflow at that tested commit, and
 * the PR head already holds that content. Every change gate compares the event's base with the
 * tested commit, so equal base and content give every gate the same input. Because the merge is
 * then the PR head's tree, a path-limited history read (Compute recipe sealing) follows the PR
 * head, never the merge commit, whose timestamp differs between the PR's test merge and the
 * queue's. Anything else, including a PR from a fork, runs normal CI.
 */
async function queueSegments(probe) {
  const { github, repo, who, context } = probe;
  const group = context.payload.merge_group;
  assert(
    group?.base_ref === "refs/heads/main" &&
      group.head_sha === who.headSha &&
      SHA.test(group.base_sha),
    "Invalid queue comparison",
  );
  const commit = await commitOf(github, repo, who.headSha);
  assert(
    commit.parents.length === 2 && commit.parents[0] === group.base_sha,
    "Queue commit does not merge one pull request onto its base",
  );
  const prHead = commit.parents[1];
  assert(
    (await commitOf(github, repo, prHead)).tree === commit.tree,
    "The pull request does not already contain its queue base",
  );
  const segment = await qualifiedRun({ ...probe, event: "pull_request", headSha: prHead });
  checkReceipt(segment.receipt, {
    schemaVersion: SCHEMA,
    event: "pull_request",
    repository: who.repository,
    workflow: WORKFLOW,
    runId: segment.run.id,
    runAttempt: segment.run.run_attempt,
    baseSha: group.base_sha,
    treeSha: commit.tree,
    reusedFrom: null,
  });
  assert(segment.receipt.workflowSha === segment.receipt.headSha, "Qualification receipt differs");
  const tested = await commitOf(github, repo, segment.receipt.headSha);
  assert(
    tested.tree === commit.tree &&
      tested.parents.length === 2 &&
      tested.parents[0] === group.base_sha &&
      tested.parents[1] === prHead,
    "The PR run tested other content",
  );
  return [segment];
}

/** Any missing evidence selects ordinary CI. Downloaded data is never executed. */
async function restore({ github, context, core, env = process.env, archiveReader = readArchive }) {
  core.setOutput("candidate", "false");
  const push = context.eventName === "push" && context.ref === "refs/heads/main";
  if (!push && context.eventName !== "merge_group") return;
  let output;
  try {
    const who = identity(context, env);
    const before = push ? context.payload.before : undefined;
    if (push) assert(SHA.test(before), "Push comparison is missing");
    output = directory(env);
    fs.rmSync(output, { recursive: true, force: true });
    const api = github.rest.actions;
    const repo = context.repo;
    const { data: current } = await api.getWorkflowRun({ ...repo, run_id: who.runId });
    assert(
      current.id === who.runId &&
        current.path === WORKFLOW &&
        current.event === context.eventName &&
        (push
          ? current.head_branch === "main"
          : current.head_branch?.startsWith("gh-readonly-queue/main/")) &&
        current.head_sha === who.headSha &&
        current.repository?.full_name === who.repository &&
        current.head_repository?.full_name === who.repository &&
        positive(current.workflow_id),
      "Current workflow identity differs",
    );
    const probe = { github, repo, current, who, context, before, env, archiveReader };
    const segments = push ? await pushSegments(probe) : await queueSegments(probe);
    // The newest segment tested the final content; its reports describe this run's tree.
    const [source] = segments;
    if (push)
      assert(source.receipt.workflowSha === who.workflowSha, "Qualification receipt differs");
    const staged = new Map();
    const transfer = await source.download(
      "thread-transfer-results",
      "thread-transfer-result.json",
      64 * 1024,
    );
    validateResult(transfer);
    staged.set("thread-transfer-result.json", transfer);
    for (const suite of ["web", "server"]) {
      for (const shard of [1, 2, 3]) {
        const filename = `vitest-${suite}-${shard}.json`;
        const report = await source.download(
          `vitest-${suite}-${shard}-attempt-${source.run.run_attempt}`,
          filename,
          MAX_REPORT,
        );
        validateVitest(report);
        staged.set(filename, report);
      }
    }
    // Recheck every source after downloads, in case one was rerun meanwhile.
    for (const { run } of segments) {
      const { data: latest } = await api.getWorkflowRun({ ...repo, run_id: run.id });
      assert(
        matchesRun(latest, current, who, run.event, run.head_sha) &&
          latest.run_attempt === run.run_attempt,
        "Source run changed during reuse",
      );
    }
    fs.mkdirSync(output, { recursive: true });
    for (const [filename, value] of staged)
      fs.writeFileSync(path.join(output, filename), JSON.stringify(value) + "\n");
    core.setOutput("source_run_id", String(source.run.id));
    core.setOutput(
      "source_url",
      `https://github.com/${who.repository}/actions/runs/${source.run.id}`,
    );
    core.setOutput("source_event", source.run.event);
    core.setOutput("candidate", "true");
  } catch (error) {
    try {
      if (output) fs.rmSync(output, { recursive: true, force: true });
    } catch {
      // A filesystem failure must still leave the candidate output false.
    }
    core.info(
      `Running full CI: ${error instanceof Error ? error.message : "qualification unavailable"}`,
    );
  }
}

module.exports = { writeReceipt, restore, readArchive };
