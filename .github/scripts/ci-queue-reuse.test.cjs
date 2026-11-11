const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { createHash } = require("node:crypto");
const { writeReceipt, restore, readArchive, SHARDS } = require("./ci-queue-reuse.cjs");

// HEAD is the pushed main commit or the queue commit; BASE is main before it.
const HEAD = "a".repeat(40);
const BASE = "b".repeat(40);
const MID = "c".repeat(40);
const PR_HEAD = "d".repeat(40);
const MERGE = "e".repeat(40);
const TREE = "f".repeat(40);
const OTHER = "9".repeat(40);
const REPO = "ScientFactory/scient-desktop";
const WORKFLOW = ".github/workflows/ci.yml";
const { ADVISORY, JOBS } = require("./ci-check.cjs");
const metricNames = [
  "totalWireBytes",
  "threadSnapshotWireBytes",
  "threadSnapshotDecodedBytes",
  "measuredTurnWebSocketWireBytes",
  "measuredTurnWebSocketDecodedBytes",
  "measuredTurnWebSocketMessages",
];
const observed = Object.fromEntries(metricNames.map((name) => [name, 1]));
const ceiling = { ...observed };
delete ceiling.threadSnapshotDecodedBytes;
const TRANSFER = {
  schemaVersion: 1,
  scenario: {
    id: "thread-transfer-v2",
    historyTurns: 1,
    historyCommandToolsPerTurn: 1,
    historyMcpResultBytes: 1,
    measuredCommandTools: 1,
    measuredMcpResultBytes: 1,
  },
  providers: { codex: { observed, ceiling }, claudeAgent: { observed, ceiling } },
};
const VITEST = {
  success: true,
  numFailedTests: 0,
  numFailedTestSuites: 0,
  numTotalTests: 1,
  testResults: [{ status: "passed" }],
};

function fixture(t, event = "push") {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "ci-reuse-test-"));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const env = {
    RUNNER_TEMP: temp,
    GITHUB_RUN_ATTEMPT: "1",
    GITHUB_SHA: HEAD,
    GITHUB_WORKFLOW_SHA: HEAD,
    GITHUB_WORKFLOW_REF: `${REPO}/${WORKFLOW}@refs/heads/main`,
  };
  const queue = event === "merge_group";
  const context = {
    repo: { owner: "ScientFactory", repo: "scient-desktop" },
    workflow: "CI",
    runId: 20,
    sha: HEAD,
    ref: queue ? "refs/heads/gh-readonly-queue/main/pr-1-x" : "refs/heads/main",
    eventName: event,
    payload: queue
      ? { merge_group: { base_ref: "refs/heads/main", base_sha: BASE, head_sha: HEAD } }
      : { before: BASE },
  };
  const outputs = {};
  const messages = [];
  const core = {
    setOutput: (key, value) => {
      outputs[key] = value;
    },
    info: (message) => messages.push(message),
  };
  const common = {
    workflow_id: 9,
    path: WORKFLOW,
    repository: { full_name: REPO },
    head_repository: { full_name: REPO },
    run_attempt: 1,
    status: "completed",
    conclusion: "success",
  };
  const current = {
    ...common,
    id: 20,
    event,
    head_sha: HEAD,
    head_branch: queue ? "gh-readonly-queue/main/pr-1" : "main",
    status: "in_progress",
    conclusion: null,
  };
  const commits = new Map();
  const commit = (sha, tree, parents) =>
    commits.set(sha, { sha, tree: { sha: tree }, parents: parents.map((p) => ({ sha: p })) });
  commit(HEAD, TREE, [BASE, PR_HEAD]);
  commit(MERGE, TREE, [BASE, PR_HEAD]);
  // The PR already contains its base, so merging it changes nothing.
  commit(PR_HEAD, TREE, [BASE]);
  const runs = [];
  const artifacts = new Map();
  const jobs = new Map();
  const payloads = new Map();
  let nextArtifact = 1;
  function addRun(run, receipt) {
    runs.push(run);
    const list = [];
    const add = (name, value) => {
      const id = nextArtifact++;
      list.push({ id, name, expired: false, size_in_bytes: 100 });
      payloads.set(id, value);
    };
    const prefix = run.event === "merge_group" ? "queue" : "pr";
    add(`ci-${prefix}-qualification-attempt-${run.run_attempt}`, receipt);
    add("thread-transfer-results", structuredClone(TRANSFER));
    for (const suite of ["web", "server"])
      for (let shard = 1; shard <= SHARDS[suite]; shard++)
        add(`vitest-${suite}-${shard}-attempt-${run.run_attempt}`, structuredClone(VITEST));
    artifacts.set(run.id, list);
    // `origin` is the attempt a job actually ran in; later attempts carry it with its start time.
    const job = (name) => ({ name, conclusion: "success", origin: run.run_attempt });
    jobs.set(run.id, [
      job("Check"),
      job("Qualification receipt"),
      job("Reuse exact CI"),
      ...Array.from({ length: SHARDS.web }, (_, i) => job(`Test Web ${i + 1}`)),
      ...Array.from({ length: SHARDS.server }, (_, i) => job(`Test Server ${i + 1}`)),
    ]);
    return run;
  }
  const receiptFor = (run, fields) => ({
    schemaVersion: 4,
    overleafWindows: true,
    event: run.event,
    repository: REPO,
    workflow: WORKFLOW,
    workflowSha: run.head_sha,
    runId: run.id,
    runAttempt: run.run_attempt,
    headSha: run.head_sha,
    baseSha: BASE,
    treeSha: TREE,
    reusedFrom: null,
    reports: { web: true, server: true },
    ...fields,
  });
  const queueRun = (id, head) => ({
    ...common,
    id,
    event: "merge_group",
    head_sha: head,
    head_branch: `gh-readonly-queue/main/pr-${id}`,
  });
  const source = queue
    ? { ...common, id: 10, event: "pull_request", head_sha: PR_HEAD, head_branch: "feature" }
    : queueRun(10, HEAD);
  const receipt = queue
    ? receiptFor(source, { headSha: MERGE, workflowSha: MERGE })
    : receiptFor(source, {});
  addRun(source, receipt);
  const actions = {
    getWorkflowRun: async ({ run_id }) => ({
      data: run_id === 20 ? current : runs.find((run) => run.id === run_id),
    }),
    // The API filters by head; returning every run of the event leaves that check to the probe.
    listWorkflowRuns: async (input) => ({
      data: {
        workflow_runs: runs
          .filter((run) => run.event === input.event)
          .toSorted((a, b) => b.id - a.id),
      },
    }),
    listWorkflowRunArtifacts: () => {},
    listJobsForWorkflowRun: () => {},
    listJobsForWorkflowRunAttempt: () => {},
    downloadArtifact: async ({ artifact_id }) => ({
      data: Buffer.from(JSON.stringify(payloads.get(artifact_id))),
    }),
  };
  const git = {
    getCommit: async ({ commit_sha }) => {
      const data = commits.get(commit_sha);
      if (!data) throw new Error("Not Found");
      return { data: structuredClone(data) };
    },
  };
  const github = {
    rest: { actions, git },
    paginate: async (method, input) => {
      const run = runs.find((candidate) => candidate.id === input.run_id);
      const list = jobs.get(input.run_id) ?? [];
      // GitHub numbers every job of the latest attempt with that attempt, carried or not.
      if (method === actions.listJobsForWorkflowRun) {
        assert.equal(input.filter, "latest");
        return list.map(({ origin, ...job }) => ({
          ...job,
          run_attempt: run.run_attempt,
          started_at: `ran-in-${origin ?? run.run_attempt}`,
        }));
      }
      if (method === actions.listJobsForWorkflowRunAttempt) {
        assert.ok(input.attempt_number < run.run_attempt);
        return list.map(({ origin, ...job }) => ({
          ...job,
          run_attempt: input.attempt_number,
          conclusion: (origin ?? 1) <= input.attempt_number ? job.conclusion : "failure",
          started_at: `ran-in-${Math.min(origin ?? 1, input.attempt_number)}`,
        }));
      }
      assert.equal(method, actions.listWorkflowRunArtifacts);
      return artifacts.get(input.run_id) ?? [];
    },
  };
  const args = { github, context, core, env, archiveReader: (bytes) => bytes };
  const report = (runId, name) =>
    payloads.get(artifacts.get(runId).find((artifact) => artifact.name === name).id);
  return {
    ...args,
    args,
    proof: artifacts.get(10)[0],
    temp,
    outputs,
    messages,
    source,
    current,
    receipt,
    commits,
    commit,
    runs,
    artifacts,
    jobs,
    payloads,
    actions,
    git,
    addRun,
    receiptFor,
    queueRun,
    report,
  };
}

const reused = (f) => assert.equal(f.outputs.candidate, "true", f.messages.join("\n"));
async function refused(f) {
  await restore(f.args);
  assert.equal(f.outputs.candidate, "false");
  assert.equal(fs.existsSync(path.join(f.temp, "ci-queue-reuse")), false);
  assert.equal(f.outputs.source_run_id, undefined);
}

test("a main push restores every report only after exact queue evidence", async (t) => {
  const f = fixture(t);
  await restore(f.args);
  reused(f);
  assert.equal(f.outputs.source_run_id, "10");
  assert.equal(f.outputs.source_url, `https://github.com/${REPO}/actions/runs/10`);
  const files = fs.readdirSync(path.join(f.temp, "ci-queue-reuse"));
  assert.equal(files.length, SHARDS.web + SHARDS.server + 1);
  assert.deepEqual(
    JSON.parse(fs.readFileSync(path.join(f.temp, "ci-queue-reuse/thread-transfer-result.json"))),
    TRANSFER,
  );
});

test("a push landing two queue entries reuses when each entry qualified from its parent", async (t) => {
  const f = fixture(t);
  // main moved BASE -> MID (first entry) -> HEAD (second entry) in one push.
  f.commit(HEAD, TREE, [MID, PR_HEAD]);
  f.receipt.baseSha = MID;
  f.commit(MID, OTHER, [BASE, OTHER]);
  const first = f.queueRun(11, MID);
  f.addRun(first, f.receiptFor(first, { treeSha: OTHER, reusedFrom: 7 }));
  await restore(f.args);
  reused(f);
  assert.equal(f.outputs.source_run_id, "10");
});

for (const [name, change] of [
  ["an entry without queue CI", (f) => f.runs.pop()],
  ["an entry qualified from another base", (f) => (f.firstProof().baseSha = OTHER)],
  ["an entry whose content differs", (f) => (f.firstProof().treeSha = TREE)],
  ["a parent that is not the receipt base", (f) => f.commit(MID, OTHER, [OTHER, BASE])],
]) {
  test(`a two-entry push with ${name} runs full CI`, async (t) => {
    const f = fixture(t);
    f.commit(HEAD, TREE, [MID, PR_HEAD]);
    f.receipt.baseSha = MID;
    f.commit(MID, OTHER, [BASE, OTHER]);
    const first = f.queueRun(11, MID);
    f.addRun(first, f.receiptFor(first, { treeSha: OTHER }));
    f.firstProof = () => f.report(11, "ci-queue-qualification-attempt-1");
    change(f);
    await refused(f);
  });
}

// Lands `entries` queue entries in one push: BASE -> ... -> HEAD, each qualified from its parent.
function chainFixture(t, entries) {
  const f = fixture(t);
  const earlier = Array.from({ length: entries - 1 }, (_, index) => String(index + 1).repeat(40));
  f.receipt.baseSha = earlier[0] ?? BASE;
  f.commit(HEAD, TREE, [f.receipt.baseSha, PR_HEAD]);
  earlier.forEach((sha, index) => {
    const parent = earlier[index + 1] ?? BASE;
    f.commit(sha, TREE, [parent, PR_HEAD]);
    const run = f.queueRun(11 + index, sha);
    f.addRun(run, f.receiptFor(run, { baseSha: parent }));
  });
  return f;
}

test("a push of as many entries as the queue merges at once reuses", async (t) => {
  // The ruleset's max_entries_to_merge.
  const f = chainFixture(t, 6);
  await restore(f.args);
  reused(f);
});

test("a push longer than the queue's merge limit runs full CI", async (t) => {
  await refused(chainFixture(t, 7));
});

const pushMismatches = [
  ["PR event", "context", "eventName", "pull_request"],
  ["other branch", "context", "ref", "refs/heads/feature"],
  ["different push base", "context.payload", "before", OTHER],
  ["different source head", "source", "head_sha", BASE],
  ["other workflow", "source", "workflow_id", 8],
  ["other workflow path", "source", "path", ".github/workflows/other.yml"],
  ["fork source", "source", "head_repository", { full_name: "someone/fork" }],
  ["other repository", "source", "repository", { full_name: "someone/fork" }],
  ["other queue", "source", "head_branch", "gh-readonly-queue/release/pr-1"],
  ["PR source", "source", "event", "pull_request"],
  ["cancelled queue", "source", "conclusion", "cancelled"],
  ["timed-out queue", "source", "conclusion", "timed_out"],
  ["queue run not yet started", "source", "status", "queued"],
  ["old proof schema", "receipt", "schemaVersion", 1],
  ["PR proof", "receipt", "event", "pull_request"],
  ["old workflow source", "receipt", "workflowSha", BASE],
  ["wrong receipt run", "receipt", "runId", 11],
  ["wrong receipt attempt", "receipt", "runAttempt", 2],
  ["other content", "receipt", "treeSha", OTHER],
  ["unknown receipt field", "receipt", "extra", true],
  ["invalid reuse source", "receipt", "reusedFrom", 0],
  ["expired proof", "proof", "expired", true],
  ["wrong digest", "proof", "digest", `sha256:${"0".repeat(64)}`],
  ["oversized artifact", "proof", "size_in_bytes", 100_000_000],
];
const fail = () => {
  throw new Error("unavailable");
};
const gate = (f, name) => f.jobs.get(10).find((job) => job.name === name);
function cancelDuringDownloads(f) {
  const download = f.actions.downloadArtifact;
  f.actions.downloadArtifact = async (input) => {
    f.source.conclusion = "cancelled";
    return download(input);
  };
}
const commonFailures = [
  ["missing proof", (f) => f.artifacts.get(10).shift()],
  ["ambiguous proof", (f) => f.artifacts.get(10).push({ ...f.artifacts.get(10)[0] })],
  ["missing shard", (f) => f.artifacts.get(10).pop()],
  ["invalid transfer", (f) => (f.report(10, "thread-transfer-results").unexpected = "data")],
  ["failed tests", (f) => (f.report(10, "vitest-web-1-attempt-1").numFailedTests = 1)],
  [
    "failed suite",
    (f) => (f.report(10, "vitest-web-1-attempt-1").testResults = [{ status: "failed" }]),
  ],
  ["false test success", (f) => (f.report(10, "vitest-server-3-attempt-1").success = false)],
  ["failed Check", (f) => (gate(f, "Check").conclusion = "failure")],
  [
    "unfinished Check",
    (f) => Object.assign(gate(f, "Check"), { status: "in_progress", conclusion: null }),
  ],
  [
    "missing Check",
    (f) =>
      f.jobs.set(
        10,
        f.jobs.get(10).filter((job) => job.name !== "Check"),
      ),
  ],
  ["duplicate Check", (f) => f.jobs.get(10).push({ ...gate(f, "Check") })],
  ["failed receipt job", (f) => (gate(f, "Qualification receipt").conclusion = "failure")],
  [
    "a newer unqualified run of the same head",
    // Its evidence would otherwise qualify, so only its state can refuse it.
    (f) => f.addRun({ ...f.source, id: 15, conclusion: "cancelled" }, { ...f.receipt, runId: 15 }),
  ],
  ["source cancelled during downloads", (f) => cancelDuringDownloads(f)],
  ["run list failure", (f) => Object.assign(f.actions, { listWorkflowRuns: fail })],
  ["commit lookup failure", (f) => Object.assign(f.git, { getCommit: fail })],
  ["download failure", (f) => Object.assign(f.actions, { downloadArtifact: fail })],
  ["archive failure", (f) => Object.assign(f.args, { archiveReader: fail })],
  [
    "source rerun during downloads",
    (f) =>
      Object.assign(f.actions, {
        getWorkflowRun: async ({ run_id }) => ({
          data: run_id === 20 ? f.current : { ...f.source, run_attempt: 2 },
        }),
      }),
  ],
];
const setter = ([name, target, key, value]) => [
  name,
  (f) => {
    target.split(".").reduce((object, part) => object[part], f)[key] = value;
  },
];
for (const [name, change] of [...pushMismatches.map(setter), ...commonFailures]) {
  test(`push: ${name} selects full CI and leaves no partial reports`, async (t) => {
    const f = fixture(t);
    change(f);
    await refused(f);
  });
}

test("checks a supplied artifact digest", async (t) => {
  const f = fixture(t);
  for (const artifact of f.artifacts.get(10))
    artifact.digest = `sha256:${createHash("sha256")
      .update(JSON.stringify(f.payloads.get(artifact.id)))
      .digest("hex")}`;
  await restore(f.args);
  reused(f);
});

test("a queue entry reuses its PR run when that run tested this exact content and base", async (t) => {
  const f = fixture(t, "merge_group");
  await restore(f.args);
  reused(f);
  assert.equal(f.outputs.source_run_id, "10");
  assert.equal(f.outputs.source_event, "pull_request");
  assert.equal(f.outputs.overleaf_windows, "true");
  assert.equal(
    fs.readdirSync(path.join(f.temp, "ci-queue-reuse")).length,
    SHARDS.web + SHARDS.server + 1,
  );
});

const queueMismatches = [
  ["another base branch", "context.payload.merge_group", "base_ref", "refs/heads/release"],
  ["another group head", "context.payload.merge_group", "head_sha", OTHER],
  ["a current run outside the queue", "current", "head_branch", "feature"],
  ["a fork PR run", "source", "head_repository", { full_name: "someone/fork" }],
  ["a cancelled PR run", "source", "conclusion", "cancelled"],
  ["a PR run waiting to start", "source", "status", "waiting"],
  ["a PR run of another head", "source", "head_sha", OTHER],
  ["a queue proof", "receipt", "event", "merge_group"],
  ["a PR run against another base", "receipt", "baseSha", OTHER],
  ["a PR run of other content", "receipt", "treeSha", OTHER],
  ["a PR proof claiming reuse", "receipt", "reusedFrom", 7],
  ["a proof of another run", "receipt", "runId", 11],
  ["a PR run whose workflow came from another commit", "receipt", "workflowSha", OTHER],
];
for (const [name, change] of [
  ...queueMismatches.map(setter),
  ...commonFailures,
  ["something queued ahead", (f) => f.commit(HEAD, TREE, [OTHER, PR_HEAD])],
  ["a queue commit of two PRs", (f) => f.commit(HEAD, TREE, [BASE, PR_HEAD, OTHER])],
  ["a tested merge of other content", (f) => f.commit(MERGE, OTHER, [BASE, PR_HEAD])],
  ["a tested merge on another base", (f) => f.commit(MERGE, TREE, [OTHER, PR_HEAD])],
  ["a tested merge of another head", (f) => f.commit(MERGE, TREE, [BASE, OTHER])],
  ["an unknown tested merge", (f) => f.commits.delete(MERGE)],
  // The merge would combine both sides, so history reads could select the merge commit itself.
  ["a PR that does not contain its base", (f) => f.commit(PR_HEAD, OTHER, [MID])],
]) {
  test(`queue: ${name} selects full CI and leaves no partial reports`, async (t) => {
    const f = fixture(t, "merge_group");
    change(f);
    await refused(f);
  });
}

function receiptFixture(t, event) {
  const f = fixture(t, event);
  if (event === "pull_request") {
    f.context.sha = MERGE;
    f.env.GITHUB_SHA = MERGE;
    f.env.GITHUB_WORKFLOW_SHA = MERGE;
    const repo = { full_name: REPO };
    f.context.payload = {
      pull_request: { base: { ref: "main", sha: BASE, repo }, head: { sha: PR_HEAD, repo } },
    };
  }
  f.needs = Object.fromEntries(JOBS.map((job) => [job, { result: "success" }]));
  f.needs.release_notes.outputs = {};
  for (const reporter of ["test_web_reused", "test_server_reused", "stable_contexts_reused"])
    f.needs[reporter].result = "skipped";
  f.needs.queue_ci = { result: event === "merge_group" ? "success" : "skipped", outputs: {} };
  return f;
}
const written = (f) =>
  JSON.parse(fs.readFileSync(path.join(f.temp, "ci-queue-reuse/receipt.json"), "utf8"));

test("queue receipt requires every lane, including non-required layout and mobile lint", async (t) => {
  const f = receiptFixture(t, "merge_group");
  for (const job of JOBS) {
    const original = f.needs[job].result;
    f.needs[job].result = "failure";
    await assert.rejects(writeReceipt(f), /CI qualification/);
    f.needs[job].result = original;
  }
  f.needs.mobile_native_static_analysis.result = "skipped";
  await assert.rejects(writeReceipt(f), /mobile_native/);
  f.needs.changes.outputs = { mobile_native: "false" };
  for (const [job, gate, output] of [
    ["compute_native", "changes", "compute_changed"],
    ["windows_packaging", "changes", "windows_changed"],
    ["remote_server_packaging", "changes", "windows_changed"],
    ["linux_packaging", "changes", "linux_changed"],
  ]) {
    f.needs[job].result = "skipped";
    f.needs[gate].outputs = { ...f.needs[gate].outputs, [output]: "true" };
    await assert.rejects(writeReceipt(f), /qualification/);
    f.needs[gate].outputs[output] = "false";
  }
  assert.equal(await writeReceipt(f), true);
  assert.deepEqual(written(f), {
    schemaVersion: 4,
    overleafWindows: true,
    event: "merge_group",
    repository: REPO,
    workflow: WORKFLOW,
    workflowSha: HEAD,
    runId: 20,
    runAttempt: 1,
    headSha: HEAD,
    baseSha: BASE,
    treeSha: TREE,
    reusedFrom: null,
    reports: { web: true, server: true },
  });
  f.context.eventName = "push";
  await assert.rejects(writeReceipt(f), /pull request or the main merge queue/);
});

test("a queue run that reused PR qualification records its source", async (t) => {
  const f = receiptFixture(t, "merge_group");
  for (const job of JOBS) f.needs[job].result = "skipped";
  f.needs.release_notes.result = "success";
  f.needs.queue_ci.result = "success";
  for (const job of ["test_web_reused", "test_server_reused", "stable_contexts_reused"])
    f.needs[job].result = "success";
  f.needs.queue_ci.outputs = {
    reused: "true",
    source_run_id: "10",
    web_reports: "true",
    server_reports: "true",
    overleaf_windows: "true",
  };
  assert.equal(await writeReceipt(f), true);
  assert.equal(written(f).reusedFrom, 10);
  // Overleaf Windows was skipped; the verified source pass is what the receipt carries.
  assert.equal(written(f).overleafWindows, true);
  f.needs.queue_ci.outputs.overleaf_windows = "";
  await assert.rejects(writeReceipt(f), /overleaf_windows: skipped/);
  f.needs.overleaf_windows.result = "success";
  assert.equal(await writeReceipt(f), true);
  assert.equal(written(f).overleafWindows, false);
  f.needs.overleaf_windows.result = "skipped";
  f.needs.queue_ci.outputs.overleaf_windows = "true";
  f.needs.queue_ci.outputs.source_run_id = "";
  await assert.rejects(writeReceipt(f), /source is missing/);
  f.needs.queue_ci.outputs.source_run_id = "10";
  f.needs.test.result = "failure";
  await assert.rejects(writeReceipt(f), /CI qualification/);
});

test("a same-repository PR receipt records the tested merge, its content and its base", async (t) => {
  const f = receiptFixture(t, "pull_request");
  assert.equal(await writeReceipt(f), true);
  assert.deepEqual(written(f), {
    schemaVersion: 4,
    overleafWindows: true,
    event: "pull_request",
    repository: REPO,
    workflow: WORKFLOW,
    workflowSha: MERGE,
    runId: 20,
    runAttempt: 1,
    headSha: MERGE,
    baseSha: BASE,
    treeSha: TREE,
    reusedFrom: null,
    reports: { web: true, server: true },
  });
});

test("a PR receipt is never written for a fork, another base branch, or a claimed reuse", async (t) => {
  const f = receiptFixture(t, "pull_request");
  f.context.payload.pull_request.head.repo = { full_name: "someone/fork" };
  await assert.rejects(writeReceipt(f), /Fork/);
  f.context.payload.pull_request.head.repo = { full_name: REPO };
  f.context.payload.pull_request.base.ref = "release";
  await assert.rejects(writeReceipt(f), /into main/);
  f.context.payload.pull_request.base.ref = "main";
  f.needs.queue_ci.outputs = { reused: "true", source_run_id: "10" };
  await assert.rejects(writeReceipt(f), /Only queue runs/);
});

test("a PR whose tested merge does not join its base and head records nothing", async (t) => {
  const f = receiptFixture(t, "pull_request");
  f.commit(MERGE, TREE, [OTHER, PR_HEAD]);
  assert.equal(await writeReceipt(f), false);
  assert.equal(fs.existsSync(path.join(f.temp, "ci-queue-reuse")), false);
});

test("archive reader accepts one exact JSON member and refuses paths, duplicates and oversized output", (t) => {
  const f = fixture(t);
  const zip = (names, value) =>
    execFileSync(
      "python3",
      [
        "-c",
        "import io,json,sys,zipfile; b=io.BytesIO(); z=zipfile.ZipFile(b,'w',zipfile.ZIP_DEFLATED); [z.writestr(n,sys.argv[2]) for n in json.loads(sys.argv[1])]; z.close(); sys.stdout.buffer.write(b.getvalue())",
        JSON.stringify(names),
        value,
      ],
      { maxBuffer: 1024 * 1024, stdio: ["ignore", "pipe", "ignore"] },
    );
  assert.equal(
    readArchive(zip(["receipt.json"], "{}"), "receipt.json", 100, f.env).toString(),
    "{}",
  );
  for (const names of [
    ["../receipt.json"],
    ["receipt.json", "receipt.json"],
    ["receipt.json", "extra.json"],
  ])
    assert.throws(
      () => readArchive(zip(names, "{}"), "receipt.json", 100, f.env),
      /archive members/,
    );
  assert.throws(() =>
    readArchive(zip(["receipt.json"], "x".repeat(100_000)), "receipt.json", 100, f.env),
  );
  assert.throws(() => readArchive(Buffer.from("not a zip"), "receipt.json", 100, f.env));
  assert.equal(fs.readdirSync(f.temp).length, 0);
});

test("workflow preserves complete evidence before reuse and a single always-running gate", () => {
  const workflow = fs.readFileSync(path.join(__dirname, "../workflows/ci.yml"), "utf8");
  const sections = new Map(
    [
      ...workflow
        .split(/^jobs:\n/m)[1]
        .matchAll(/^  ([\w-]+):\n([\s\S]*?)(?=^  [\w-]+:\n|(?![\s\S]))/gm),
    ].map((match) => [match[1], match[2]]),
  );
  assert.deepEqual(
    [...sections.keys()].sort(),
    [...JOBS, ...ADVISORY, "check", "qualification"].sort(),
  );
  const check = sections.get("check");
  assert.match(check, /name: Check/);
  assert.match(check, /if: \$\{\{ always\(\) \}\}/);
  for (const job of [...JOBS, "qualification"])
    assert.match(check, new RegExp(`needs:.*(?:\\[|, )${job}(?:,|\\])`));
  for (const job of ADVISORY)
    assert.doesNotMatch(check, new RegExp(`needs:.*(?:\\[|, )${job}(?:,|\\])`));
  const probe = sections.get("queue_ci");
  assert.match(probe, /github.event_name == 'merge_group'/);
  assert.match(probe, /github.event_name == 'push' && github.ref == 'refs\/heads\/main'/);
  assert.match(probe, /source_run_id: \$\{\{ steps.restore.outputs.source_run_id \}\}/);
  assert.ok(
    probe.indexOf("uses: ./.github/actions/ci-queue-reporting") < probe.indexOf("id: complete"),
  );
  assert.ok(!/always\(\)/.test(probe), "failed publication must prevent the reuse marker");
  assert.match(
    probe,
    /if: steps.restore.outputs.candidate == 'true' && steps.preserve.outcome == 'success'/,
  );
  const reporting = fs.readFileSync(
    path.join(__dirname, "../actions/ci-queue-reporting/action.yml"),
    "utf8",
  );
  // One upload per shard report, plus the transfer measurement.
  const uploads = SHARDS.web + SHARDS.server + 1;
  assert.equal((reporting.match(/uses: actions\/upload-artifact/g) ?? []).length, uploads);
  assert.equal((reporting.match(/overwrite: true/g) ?? []).length, uploads);
  for (const [suite, count] of Object.entries(SHARDS))
    for (let shard = 1; shard <= count; shard++)
      assert.match(reporting, new RegExp(`name: vitest-${suite}-${shard}-attempt-`));
  for (const [job, suite] of [
    ["test_web", "web"],
    ["test_server", "server"],
  ])
    assert.match(
      sections.get(job),
      new RegExp(
        `shard: \\[${Array.from({ length: SHARDS[suite] }, (_, i) => i + 1).join(", ")}\\]`,
      ),
    );
  for (const job of ["test_web", "test_server"]) {
    assert.match(sections.get(job), /overwrite: true/);
    const stand = sections.get(`${job}_reused`);
    assert.ok(!/matrix:/.test(stand), "one reporting job per suite");
    assert.match(
      stand,
      /if: \$\{\{ !cancelled\(\) && needs.queue_ci.outputs.reused == 'true' \}\}/,
    );
  }
  assert.match(
    check,
    /name: Require transfer measurements[\s\S]*needs.test_server.result == 'success' \|\| needs.queue_ci.outputs.server_reports == 'true'/,
  );
  const changes = sections.get("changes");
  assert.equal((changes.match(/uses: actions\/checkout/g) ?? []).length, 1);
  assert.match(changes, /fetch-depth: 0/);
  for (const gate of ["compute-ci-gate.mjs", "windows-packaging-ci-gate.mjs"]) {
    assert.ok(changes.includes(`node .github/scripts/${gate} detect`));
    assert.ok(check.includes(`node .github/scripts/${gate} check`));
  }
});

// The mobile gate's own script, as the workflow runs it.
function mobileGateScript() {
  const action = fs.readFileSync(path.join(__dirname, "../actions/ci-changes/action.yml"), "utf8");
  return action
    .split("      run: |\n")[1]
    .split("\n")
    .filter((line) => line.startsWith("        "))
    .map((line) => line.slice(8))
    .join("\n");
}

test("the mobile gate classifies the tested diff, including renames and unusual filenames", (t) => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "ci-mobile-gate-"));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const env = {
    ...process.env,
    GIT_INDEX_FILE: path.join(temp, "index"),
    GIT_AUTHOR_NAME: "CI",
    GIT_AUTHOR_EMAIL: "ci@example.invalid",
    GIT_COMMITTER_NAME: "CI",
    GIT_COMMITTER_EMAIL: "ci@example.invalid",
  };
  // Plumbing only, so a filename no file system accepts can still be committed.
  const git = (args, input) =>
    execFileSync("git", ["-c", "core.protectNTFS=false", ...args], {
      cwd: temp,
      env,
      input,
      encoding: "utf8",
    }).trim();
  git(["init", "-q"]);
  const blob = git(["hash-object", "-w", "--stdin"], "x\n");
  // Paths are strings or raw bytes; stdin carries bytes that are not valid UTF-8.
  const commit = (files, parent) => {
    fs.rmSync(env.GIT_INDEX_FILE, { force: true });
    const records = files.map((file) =>
      Buffer.concat([Buffer.from(`100644 ${blob}\t`), Buffer.from(file), Buffer.from([0])]),
    );
    git(["update-index", "-z", "--index-info"], Buffer.concat(records));
    const tree = git(["write-tree"]);
    return git(["commit-tree", tree, ...(parent ? ["-p", parent] : []), "-m", "change"]);
  };
  const script = mobileGateScript();
  const root = path.resolve(__dirname, "../..");
  const scripts = path.join(temp, ".github/scripts");
  fs.mkdirSync(scripts, { recursive: true });
  fs.copyFileSync(
    path.join(root, ".github/scripts/ci-changes.cjs"),
    path.join(scripts, "ci-changes.cjs"),
  );
  fs.writeFileSync(path.join(temp, "pnpm-workspace.yaml"), "packages:\n");
  const gate = (base, head) => {
    const output = path.join(temp, "output");
    fs.writeFileSync(output, "");
    // Hosted runners use a UTF-8 locale; the gate must still match raw bytes.
    execFileSync("bash", ["-c", script], {
      cwd: temp,
      env: {
        ...env,
        LC_ALL: "C.UTF-8",
        EVENT_NAME: "merge_group",
        RUNNER_TEMP: temp,
        BASE_SHA: base,
        GITHUB_SHA: head,
        GITHUB_OUTPUT: output,
      },
      stdio: "pipe",
    });
    return fs
      .readFileSync(output, "utf8")
      .trim()
      .split("\n")
      .find((line) => line.startsWith("mobile_native="));
  };
  const base = commit(["docs/a.md", "samples/Foo.swift", "apps/mobile/Kept.kt"]);
  const after = (files) => commit(files, base);
  assert.equal(
    gate(base, after(["docs/a.md", "docs/b.md", "samples/Foo.swift", "apps/mobile/Kept.kt"])),
    "mobile_native=false",
  );
  assert.equal(gate(base, base), "mobile_native=false");
  assert.equal(
    gate(
      base,
      after(["docs/a.md", "samples/Foo.swift", "apps/mobile/Kept.kt", "apps/mobile/Bar.swift"]),
    ),
    "mobile_native=true",
  );
  // Renamed into, or out of, the native paths.
  assert.equal(
    gate(base, after(["docs/a.md", "apps/mobile/Foo.swift", "apps/mobile/Kept.kt"])),
    "mobile_native=true",
  );
  assert.equal(
    gate(base, after(["docs/a.md", "samples/Foo.swift", "samples/Kept.kt"])),
    "mobile_native=true",
  );
  // A newline inside a filename must not split it into two unmatched lines.
  assert.equal(
    gate(
      base,
      after([
        "docs/a.md",
        "samples/Foo.swift",
        "apps/mobile/Kept.kt",
        "apps/mobile/Foo\nBar.swift",
      ]),
    ),
    "mobile_native=true",
  );
  // Nor may a byte that is not valid UTF-8 hide it from the matcher.
  const invalid = Buffer.concat([
    Buffer.from("apps/mobile/Foo"),
    Buffer.from([0xff]),
    Buffer.from("Bar.swift"),
  ]);
  assert.equal(
    gate(base, after(["docs/a.md", "samples/Foo.swift", "apps/mobile/Kept.kt", invalid])),
    "mobile_native=true",
  );
  // Anything unresolvable runs the lint.
  assert.equal(gate("not-a-commit", base), "mobile_native=true");
  assert.equal(gate("0".repeat(40), base), "mobile_native=true");
});

test("a web-only receipt restores the web reports without demanding skipped server evidence", async (t) => {
  const f = fixture(t, "merge_group");
  f.receipt.reports.server = false;
  const list = f.artifacts.get(10);
  f.artifacts.set(
    10,
    list.filter(
      (artifact) =>
        !artifact.name.includes("server") && artifact.name !== "thread-transfer-results",
    ),
  );
  await restore(f);
  reused(f);
  assert.equal(f.outputs.web_reports, "true");
  assert.equal(f.outputs.server_reports, "false");
  assert.equal(fs.readdirSync(path.join(f.temp, "ci-queue-reuse")).length, SHARDS.web);
});

test("a docs-only receipt can reuse without inventing reports from skipped matrices", async (t) => {
  const f = fixture(t, "merge_group");
  f.receipt.reports = { web: false, server: false };
  f.artifacts.set(
    10,
    f.artifacts.get(10).filter((artifact) => artifact.name.startsWith("ci-pr-")),
  );
  await restore(f);
  reused(f);
  assert.deepEqual(fs.readdirSync(path.join(f.temp, "ci-queue-reuse")), []);
});

for (const [name, mutate] of [
  [
    "legacy receipt",
    (f) => {
      f.receipt.schemaVersion = 2;
    },
  ],
  [
    "missing report declaration",
    (f) => {
      delete f.receipt.reports;
    },
  ],
  [
    "nonboolean report declaration",
    (f) => {
      f.receipt.reports.server = "false";
    },
  ],
  [
    "missing last server shard",
    (f) => {
      f.artifacts.set(
        10,
        f.artifacts.get(10).filter((artifact) => artifact.name !== "vitest-server-12-attempt-1"),
      );
    },
  ],
])
  test(`${name} cannot suppress queue CI`, async (t) => {
    const f = fixture(t, "merge_group");
    mutate(f);
    await refused(f);
  });

test("pre-Windows receipts and receipts without successful Windows evidence cannot be reused", async (t) => {
  for (const change of [
    (r) => {
      r.schemaVersion = 3;
    },
    (r) => {
      delete r.overleafWindows;
    },
    (r) => {
      r.overleafWindows = false;
    },
  ]) {
    const f = fixture(t, "merge_group");
    change(f.receipt);
    await restore(f);
    assert.notEqual(f.outputs.reused, "true");
    assert.ok(f.messages.some((message) => message.includes("Qualification receipt differs")));
  }
});

test("a rerun source restores each report from the attempt whose job passed", async (t) => {
  for (const event of ["push", "merge_group"]) {
    const f = fixture(t, event);
    f.source.run_attempt = 2;
    // Attempt 2 reran only the failed web shard 3; every other job kept its attempt-1 pass.
    const failed = f.report(10, "vitest-web-3-attempt-1");
    failed.success = false;
    failed.numFailedTests = 1;
    const id = 1000;
    f.artifacts
      .get(10)
      .push({ id, name: "vitest-web-3-attempt-2", expired: false, size_in_bytes: 100 });
    f.payloads.set(id, structuredClone(f.report(10, "vitest-web-1-attempt-1")));
    f.jobs.get(10).find((job) => job.name === "Test Web 3").origin = 2;
    await restore(f.args);
    reused(f);
    const restored = JSON.parse(
      fs.readFileSync(path.join(f.temp, "ci-queue-reuse/vitest-web-3.json"), "utf8"),
    );
    assert.equal(restored.success, true);
  }
});

for (const [name, mutate] of [
  [
    "a passing job whose attempt left no report",
    (f) => {
      f.jobs.get(10).find((job) => job.name === "Test Server 4").origin = 2;
    },
  ],
  [
    "a shard job missing from the run",
    (f) => {
      f.jobs.set(
        10,
        f.jobs.get(10).filter((job) => job.name !== "Test Web 6"),
      );
    },
  ],
  [
    "a shard job that did not pass",
    (f) => {
      f.jobs.get(10).find((job) => job.name === "Test Web 2").conclusion = "skipped";
    },
  ],
  [
    "two jobs of one name",
    (f) => {
      f.jobs.get(10).push({ name: "Test Server 1", conclusion: "success", origin: 1 });
    },
  ],
  [
    "a receipt job whose attempt left no receipt",
    (f) => {
      f.jobs.get(10).find((job) => job.name === "Qualification receipt").origin = 2;
    },
  ],
  [
    "an attempt history that cannot be read",
    (f) => {
      const paginate = f.github.paginate;
      f.github.paginate = async (method, input) => {
        if (method === f.actions.listJobsForWorkflowRunAttempt) throw new Error("502");
        return paginate(method, input);
      };
    },
  ],
])
  test(`${name} selects full CI`, async (t) => {
    const f = fixture(t, "merge_group");
    f.source.run_attempt = 2;
    mutate(f);
    await refused(f);
  });

test("a receipt from an earlier attempt still qualifies a run that later reran other jobs", async (t) => {
  const f = fixture(t, "merge_group");
  // Attempt 2 reran an advisory job only; the receipt and reports stay attempt 1.
  f.source.run_attempt = 2;
  await restore(f.args);
  reused(f);
});

test("a push whose queue run reused PR CI restores the reports its probe republished", async (t) => {
  for (const probe of ["success", "failure"]) {
    const f = fixture(t);
    f.receipt.reusedFrom = 5;
    // The reused queue run skipped its shards; only its probe job published the reports.
    for (const job of f.jobs.get(10)) if (job.name.startsWith("Test ")) job.conclusion = "skipped";
    f.jobs.get(10).find((job) => job.name === "Reuse exact CI").conclusion = probe;
    if (probe === "success") {
      await restore(f.args);
      reused(f);
    } else await refused(f);
  }
});

// Advisory jobs (ci-check.cjs ADVISORY) can still run, or fail, after the gates passed.
for (const event of ["push", "merge_group"]) {
  for (const [name, state] of [
    ["is still finishing advisory work", { status: "in_progress", conclusion: null }],
    ["failed only in advisory work", { status: "completed", conclusion: "failure" }],
  ]) {
    test(`${event}: a source whose gates passed and that ${name} reuses`, async (t) => {
      const f = fixture(t, event);
      Object.assign(f.source, state);
      await restore(f.args);
      reused(f);
    });
  }
}

test("a source rerun with every job waits for its new gates", async (t) => {
  const f = fixture(t, "merge_group");
  Object.assign(f.source, { run_attempt: 2, status: "in_progress", conclusion: null });
  // Re-run all jobs: the new attempt's gates have not finished yet.
  for (const job of f.jobs.get(10)) job.origin = 2;
  Object.assign(gate(f, "Check"), { status: "queued", conclusion: null });
  await refused(f);
  assert.match(f.messages.join("\n"), /No single successful Check job/);
});

test("a cancelled source names its state as the reason for full CI", async (t) => {
  const f = fixture(t, "merge_group");
  f.source.conclusion = "cancelled";
  await refused(f);
  assert.match(f.messages.join("\n"), /No qualified exact-content pull_request run/);
});

test("an advisory-only rerun keeps the gates and reports of the first attempt", async (t) => {
  const f = fixture(t, "merge_group");
  Object.assign(f.source, { run_attempt: 2, status: "in_progress", conclusion: null });
  // Re-run failed jobs carries every passed job, with its start time, into attempt 2.
  for (const job of f.jobs.get(10)) job.origin = 1;
  await restore(f.args);
  reused(f);
});
