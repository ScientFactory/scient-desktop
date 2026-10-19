const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { createHash } = require("node:crypto");
const { writeReceipt, restore, readArchive } = require("./ci-queue-reuse.cjs");

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
const JOBS = [
  "check",
  "test_workspaces",
  "compute_changes",
  "compute_native",
  "windows_packaging_changes",
  "windows_packaging",
  "remote_server_packaging",
  "linux_packaging",
  "test",
  "test_web",
  "test_server",
  "transfer-report",
  "rust",
  "mobile_native_changes",
  "mobile_native_static_analysis",
  "release_smoke",
];
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
      for (const shard of [1, 2, 3])
        add(`vitest-${suite}-${shard}-attempt-${run.run_attempt}`, structuredClone(VITEST));
    artifacts.set(run.id, list);
    return run;
  }
  const receiptFor = (run, fields) => ({
    schemaVersion: 2,
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

test("a main push restores all seven reports only after exact queue evidence", async (t) => {
  const f = fixture(t);
  await restore(f.args);
  reused(f);
  assert.equal(f.outputs.source_run_id, "10");
  assert.equal(f.outputs.source_url, `https://github.com/${REPO}/actions/runs/10`);
  const files = fs.readdirSync(path.join(f.temp, "ci-queue-reuse"));
  assert.equal(files.length, 7);
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
  const f = chainFixture(t, 4);
  await restore(f.args);
  reused(f);
});

test("a push longer than the queue's merge limit runs full CI", async (t) => {
  await refused(chainFixture(t, 5));
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
  ["failed queue", "source", "conclusion", "failure"],
  ["unfinished queue", "source", "status", "in_progress"],
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
  assert.equal(fs.readdirSync(path.join(f.temp, "ci-queue-reuse")).length, 7);
});

const queueMismatches = [
  ["another base branch", "context.payload.merge_group", "base_ref", "refs/heads/release"],
  ["another group head", "context.payload.merge_group", "head_sha", OTHER],
  ["a current run outside the queue", "current", "head_branch", "feature"],
  ["a fork PR run", "source", "head_repository", { full_name: "someone/fork" }],
  ["a failed PR run", "source", "conclusion", "failure"],
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
  f.needs.queue_ci = { result: event === "merge_group" ? "success" : "skipped", outputs: {} };
  return f;
}
const written = (f) =>
  JSON.parse(fs.readFileSync(path.join(f.temp, "ci-queue-reuse/receipt.json"), "utf8"));

test("queue receipt requires every lane, including non-required layout and mobile lint", async (t) => {
  const f = receiptFixture(t, "merge_group");
  for (const job of JOBS) {
    f.needs[job].result = "failure";
    await assert.rejects(writeReceipt(f), /CI job|qualification/);
    f.needs[job].result = "success";
  }
  f.needs.mobile_native_static_analysis.result = "skipped";
  await assert.rejects(writeReceipt(f), /mobile_native/);
  f.needs.mobile_native_changes.outputs = { changed: "false" };
  for (const [job, gate, output] of [
    ["compute_native", "compute_changes", "changed"],
    ["windows_packaging", "windows_packaging_changes", "changed"],
    ["remote_server_packaging", "windows_packaging_changes", "changed"],
    ["linux_packaging", "windows_packaging_changes", "linux_changed"],
  ]) {
    f.needs[job].result = "skipped";
    f.needs[gate].outputs = { ...f.needs[gate].outputs, [output]: "true" };
    await assert.rejects(writeReceipt(f), /Native qualification/);
    f.needs[gate].outputs[output] = "false";
  }
  assert.equal(await writeReceipt(f), true);
  assert.deepEqual(written(f), {
    schemaVersion: 2,
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
  });
  f.context.eventName = "push";
  await assert.rejects(writeReceipt(f), /pull request or the main merge queue/);
});

test("a queue run that reused PR qualification records its source", async (t) => {
  const f = receiptFixture(t, "merge_group");
  for (const job of JOBS) f.needs[job].result = "skipped";
  f.needs.test.result = "success";
  f.needs["transfer-report"].result = "success";
  f.needs.queue_ci.outputs = { reused: "true", source_run_id: "10" };
  assert.equal(await writeReceipt(f), true);
  assert.equal(written(f).reusedFrom, 10);
  f.needs.queue_ci.outputs.source_run_id = "";
  await assert.rejects(writeReceipt(f), /source is missing/);
  f.needs.queue_ci.outputs.source_run_id = "10";
  f.needs.test.result = "failure";
  await assert.rejects(writeReceipt(f), /CI job/);
});

test("a same-repository PR receipt records the tested merge, its content and its base", async (t) => {
  const f = receiptFixture(t, "pull_request");
  assert.equal(await writeReceipt(f), true);
  assert.deepEqual(written(f), {
    schemaVersion: 2,
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

test("workflow preserves full fallback, complete evidence, required shard names, and reporting before the reuse marker", () => {
  const workflow = fs.readFileSync(path.join(__dirname, "../workflows/ci.yml"), "utf8");
  const sections = new Map(
    [
      ...workflow
        .split(/^jobs:\n/m)[1]
        .matchAll(/^  ([\w-]+):\n([\s\S]*?)(?=^  [\w-]+:\n|(?![\s\S]))/gm),
    ].map((match) => [match[1], match[2]]),
  );
  const special = new Set(["queue_ci", "qualification", "test_web_reused", "test_server_reused"]);
  assert.deepEqual(
    [...sections.keys()].filter((job) => !special.has(job)).sort(),
    [...JOBS].sort(),
    "Every CI job must participate in qualification and fallback",
  );
  for (const job of JOBS) {
    assert.match(sections.get(job), /needs:[^\n]*queue_ci/, `${job} depends on the probe`);
    if (!["test", "transfer-report"].includes(job))
      assert.match(
        sections.get(job),
        /if:.*!cancelled\(\).*needs\.queue_ci\.outputs\.reused != 'true'/,
        `${job} runs after skipped/failed probe`,
      );
  }
  const receipt = sections.get("qualification");
  for (const job of ["queue_ci", ...JOBS])
    assert.match(receipt, new RegExp(`needs:.*(?:\\[|, )${job}(?:,|\\])`));
  assert.match(receipt, /github.event_name == 'merge_group'/);
  assert.match(
    receipt,
    /github.event_name == 'pull_request' && github.event.pull_request.head.repo.full_name == github.repository/,
  );
  assert.match(receipt, /if: steps.receipt.outputs.result == 'true'/);
  const probe = sections.get("queue_ci");
  assert.match(probe, /github.event_name == 'push'.*refs\/heads\/main/);
  assert.match(probe, /github.event_name == 'merge_group'/);
  assert.match(probe, /source_run_id: \$\{\{ steps.restore.outputs.source_run_id \}\}/);
  assert.equal((probe.match(/uses: actions\/upload-artifact/g) ?? []).length, 7);
  assert.equal((probe.match(/overwrite: true/g) ?? []).length, 7);
  assert.ok(probe.lastIndexOf("uses: actions/upload-artifact") < probe.indexOf("id: complete"));
  assert.ok(!/always\(\)/.test(probe), "failed publication must prevent the reuse marker");
  for (const job of ["test_web", "test_server"]) assert.match(sections.get(job), /overwrite: true/);
  assert.match(sections.get("test_server"), /name: thread-transfer-results[\s\S]*overwrite: true/);
  assert.match(sections.get("test"), /needs.queue_ci.outputs.reused == 'true'/);
  assert.match(sections.get("transfer-report"), /needs.queue_ci.outputs.reused == 'true'/);
  // Required shard checks keep their exact names when a queue entry reuses its PR run.
  for (const job of ["test_web", "test_server"]) {
    const real = sections.get(job);
    const stand = sections.get(`${job}_reused`);
    const name = (section) => section.match(/^    name: (.+)$/m)[1];
    const shards = (section) => section.match(/^ {8}shard: (.+)$/m)[1];
    assert.equal(name(stand), name(real));
    assert.equal(shards(stand), shards(real));
    assert.match(
      stand,
      /if: \$\{\{ !cancelled\(\) && needs.queue_ci.outputs.reused == 'true' && github.event_name == 'merge_group' \}\}/,
    );
    assert.ok(!/uses: |vp run/.test(stand), `${job}_reused only reports the reused shard`);
  }
  // Reuse relies on every change gate comparing the event's base with the tested commit; a live
  // PR file list can change during a run.
  const mobile = sections.get("mobile_native_changes");
  assert.match(
    mobile,
    /BASE_SHA: \$\{\{ github.event.pull_request.base.sha \|\| github.event.merge_group.base_sha \|\| github.event.before \}\}/,
  );
  assert.match(mobile, /fetch-depth: 0/);
  assert.ok(!/gh api|pulls\//.test(mobile), "the mobile gate never reads a live PR file list");
  for (const gate of ["compute-ci-gate.mjs", "windows-packaging-ci-gate.mjs"]) {
    const source = fs.readFileSync(path.join(__dirname, gate), "utf8");
    assert.match(
      source,
      /const base = event\.pull_request\?\.base\.sha \?\? event\.merge_group\?\.base_sha \?\? event\.before;\n\s*const head = process\.env\.GITHUB_SHA;/,
      `${gate} compares the event base with the tested commit`,
    );
  }
});

// The mobile gate's own script, as the workflow runs it.
function mobileGateScript() {
  const workflow = fs.readFileSync(path.join(__dirname, "../workflows/ci.yml"), "utf8");
  const job = workflow.split(/^ {2}mobile_native_changes:\n/m)[1].split(/^ {2}[\w-]+:\n/m)[0];
  const lines = [];
  for (const line of job.split(/^ {8}run: \|\n/m)[1].split("\n")) {
    if (line.trim() !== "" && !line.startsWith(" ".repeat(10))) break;
    lines.push(line.slice(10));
  }
  return lines.join("\n");
}

test("the mobile gate classifies the tested diff, including renames and newline filenames", (t) => {
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
  const commit = (files, parent) => {
    fs.rmSync(env.GIT_INDEX_FILE, { force: true });
    for (const file of files)
      git(["update-index", "--add", "--cacheinfo", `100644,${blob},${file}`]);
    const tree = git(["write-tree"]);
    return git(["commit-tree", tree, ...(parent ? ["-p", parent] : []), "-m", "change"]);
  };
  const script = mobileGateScript();
  const gate = (base, head) => {
    const output = path.join(temp, "output");
    fs.writeFileSync(output, "");
    execFileSync("bash", ["-c", script], {
      cwd: temp,
      env: { ...env, BASE_SHA: base, GITHUB_SHA: head, GITHUB_OUTPUT: output },
      stdio: "pipe",
    });
    return fs.readFileSync(output, "utf8").trim();
  };
  const base = commit(["docs/a.md", "samples/Foo.swift", "apps/mobile/Kept.kt"]);
  const after = (files) => commit(files, base);
  assert.equal(
    gate(base, after(["docs/a.md", "docs/b.md", "samples/Foo.swift", "apps/mobile/Kept.kt"])),
    "changed=false",
  );
  assert.equal(gate(base, base), "changed=false");
  assert.equal(
    gate(
      base,
      after(["docs/a.md", "samples/Foo.swift", "apps/mobile/Kept.kt", "apps/mobile/Bar.swift"]),
    ),
    "changed=true",
  );
  // Renamed into, or out of, the native paths.
  assert.equal(
    gate(base, after(["docs/a.md", "apps/mobile/Foo.swift", "apps/mobile/Kept.kt"])),
    "changed=true",
  );
  assert.equal(
    gate(base, after(["docs/a.md", "samples/Foo.swift", "samples/Kept.kt"])),
    "changed=true",
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
    "changed=true",
  );
  // Anything unresolvable runs the lint.
  assert.equal(gate("not-a-commit", base), "changed=true");
  assert.equal(gate("0".repeat(40), base), "changed=true");
});
