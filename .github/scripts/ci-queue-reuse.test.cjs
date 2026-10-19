const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { createHash } = require("node:crypto");
const { writeReceipt, restore, readArchive } = require("./ci-queue-reuse.cjs");

const HEAD = "a".repeat(40);
const BASE = "b".repeat(40);
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

function fixture(t) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "ci-reuse-test-"));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const env = {
    RUNNER_TEMP: temp,
    GITHUB_RUN_ATTEMPT: "1",
    GITHUB_SHA: HEAD,
    GITHUB_WORKFLOW_SHA: HEAD,
    GITHUB_WORKFLOW_REF: `${REPO}/${WORKFLOW}@refs/heads/main`,
  };
  const context = {
    repo: { owner: "ScientFactory", repo: "scient-desktop" },
    workflow: "CI",
    runId: 20,
    sha: HEAD,
    ref: "refs/heads/main",
    eventName: "push",
    payload: { before: BASE },
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
    head_sha: HEAD,
    repository: { full_name: REPO },
    head_repository: { full_name: REPO },
    run_attempt: 1,
  };
  const current = { ...common, id: 20, event: "push", head_branch: "main" };
  const source = {
    ...common,
    id: 10,
    event: "merge_group",
    head_branch: "gh-readonly-queue/main/pr-1",
    status: "completed",
    conclusion: "success",
  };
  const receipt = {
    schemaVersion: 1,
    repository: REPO,
    workflow: WORKFLOW,
    workflowSha: HEAD,
    runId: 10,
    runAttempt: 1,
    headSha: HEAD,
    baseSha: BASE,
  };
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
  const transfer = {
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
  const vitest = {
    success: true,
    numFailedTests: 0,
    numFailedTestSuites: 0,
    numTotalTests: 1,
    testResults: [{ status: "passed" }],
  };
  const artifacts = [];
  const payloads = new Map();
  function add(name, value) {
    const id = artifacts.length + 1;
    artifacts.push({ id, name, expired: false, size_in_bytes: 100 });
    payloads.set(id, value);
  }
  add("ci-queue-qualification-attempt-1", receipt);
  add("thread-transfer-results", transfer);
  for (const suite of ["web", "server"])
    for (const shard of [1, 2, 3])
      add(`vitest-${suite}-${shard}-attempt-1`, structuredClone(vitest));
  const actions = {
    getWorkflowRun: async ({ run_id }) => ({ data: run_id === 20 ? current : source }),
    listWorkflowRuns: async (input) => {
      assert.equal(input.head_sha, HEAD);
      assert.equal(input.event, "merge_group");
      return { data: { workflow_runs: [source] } };
    },
    listWorkflowRunArtifacts: () => {},
    downloadArtifact: async ({ artifact_id }) => ({
      data: Buffer.from(JSON.stringify(payloads.get(artifact_id))),
    }),
  };
  const github = {
    rest: { actions },
    paginate: async (method, input) => {
      assert.equal(method, actions.listWorkflowRunArtifacts);
      assert.equal(input.run_id, 10);
      return artifacts;
    },
  };
  const args = { github, context, core, env, archiveReader: (bytes) => bytes };
  return {
    ...args,
    args,
    temp,
    outputs,
    messages,
    source,
    current,
    receipt,
    transfer,
    artifacts,
    payloads,
    actions,
  };
}

test("restores all seven reports only after exact queue evidence and successful validation", async (t) => {
  const f = fixture(t);
  await restore(f.args);
  assert.equal(f.outputs.candidate, "true");
  assert.equal(f.outputs.source_run_id, "10");
  assert.equal(f.outputs.source_url, `https://github.com/${REPO}/actions/runs/10`);
  const files = fs.readdirSync(path.join(f.temp, "ci-queue-reuse"));
  assert.equal(files.length, 7);
  assert.deepEqual(
    JSON.parse(fs.readFileSync(path.join(f.temp, "ci-queue-reuse/thread-transfer-result.json"))),
    f.transfer,
  );
});

const mismatchCases = [
  ["PR event", "context", "eventName", "pull_request"],
  ["other branch", "context", "ref", "refs/heads/feature"],
  ["different push base", "context.payload", "before", "c".repeat(40)],
  ["different source head", "source", "head_sha", BASE],
  ["other workflow", "source", "workflow_id", 8],
  ["other workflow path", "source", "path", ".github/workflows/other.yml"],
  ["fork source", "source", "head_repository", { full_name: "someone/fork" }],
  ["other repository", "source", "repository", { full_name: "someone/fork" }],
  ["other queue", "source", "head_branch", "gh-readonly-queue/release/pr-1"],
  ["PR source", "source", "event", "pull_request"],
  ["failed queue", "source", "conclusion", "failure"],
  ["unfinished queue", "source", "status", "in_progress"],
  ["old proof schema", "receipt", "schemaVersion", 0],
  ["old workflow source", "receipt", "workflowSha", BASE],
  ["wrong receipt run", "receipt", "runId", 11],
  ["wrong receipt attempt", "receipt", "runAttempt", 2],
  ["expired proof", "artifacts.0", "expired", true],
  ["invalid transfer", "transfer", "unexpected", "data"],
  ["wrong digest", "artifacts.0", "digest", `sha256:${"0".repeat(64)}`],
  ["oversized artifact", "artifacts.0", "size_in_bytes", 100_000_000],
].map(([name, target, key, value]) => [
  name,
  (f) => {
    target.split(".").reduce((object, part) => object[part], f)[key] = value;
  },
]);
const fail = () => {
  throw new Error("unavailable");
};
for (const [name, change] of [
  ...mismatchCases,
  ["old queue without proof", (f) => f.artifacts.shift()],
  ["ambiguous proof", (f) => f.artifacts.push({ ...f.artifacts[0] })],
  ["missing shard", (f) => f.artifacts.pop()],
  ["failed tests", (f) => Object.assign(f.payloads.get(8), { numFailedTests: 1 })],
  [
    "failed suite",
    (f) => Object.assign(f.payloads.get(8), { testResults: [{ status: "failed" }] }),
  ],
  ["false test success", (f) => Object.assign(f.payloads.get(8), { success: false })],
  ["API failure", (f) => Object.assign(f.actions, { listWorkflowRuns: fail })],
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
]) {
  test(`${name} selects full CI and leaves no partial reports`, async (t) => {
    const f = fixture(t);
    change(f);
    await restore(f.args);
    assert.equal(f.outputs.candidate, "false");
    assert.equal(fs.existsSync(path.join(f.temp, "ci-queue-reuse")), false);
    assert.equal(f.outputs.source_run_id, undefined);
  });
}

test("checks a supplied artifact digest", async (t) => {
  const f = fixture(t);
  for (const artifact of f.artifacts)
    artifact.digest = `sha256:${createHash("sha256")
      .update(JSON.stringify(f.payloads.get(artifact.id)))
      .digest("hex")}`;
  await restore(f.args);
  assert.equal(f.outputs.candidate, "true");
});

function queueFixture(t) {
  const f = fixture(t);
  f.context.eventName = "merge_group";
  f.context.payload = {
    merge_group: { base_ref: "refs/heads/main", base_sha: BASE, head_sha: HEAD },
  };
  f.needs = Object.fromEntries(JOBS.map((job) => [job, { result: "success" }]));
  return f;
}

test("queue receipt requires every lane, including non-required layout and mobile lint", (t) => {
  const f = queueFixture(t);
  for (const job of JOBS) {
    f.needs[job].result = "failure";
    assert.throws(() => writeReceipt(f), /CI job|qualification/);
    f.needs[job].result = "success";
  }
  f.needs.mobile_native_static_analysis.result = "skipped";
  assert.throws(() => writeReceipt(f), /mobile_native/);
  f.needs.mobile_native_changes.outputs = { changed: "false" };
  for (const [job, gate, output] of [
    ["compute_native", "compute_changes", "changed"],
    ["windows_packaging", "windows_packaging_changes", "changed"],
    ["remote_server_packaging", "windows_packaging_changes", "changed"],
    ["linux_packaging", "windows_packaging_changes", "linux_changed"],
  ]) {
    f.needs[job].result = "skipped";
    f.needs[gate].outputs = { ...f.needs[gate].outputs, [output]: "true" };
    assert.throws(() => writeReceipt(f), /Native qualification/);
    f.needs[gate].outputs[output] = "false";
  }
  writeReceipt(f);
  const receipt = JSON.parse(fs.readFileSync(path.join(f.temp, "ci-queue-reuse/receipt.json")));
  assert.equal(receipt.headSha, HEAD);
  assert.equal(receipt.baseSha, BASE);
  f.context.eventName = "push";
  assert.throws(() => writeReceipt(f), /main merge queue/);
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

test("workflow preserves full fallback, complete evidence, and reporting before the reuse marker", () => {
  const workflow = fs.readFileSync(path.join(__dirname, "../workflows/ci.yml"), "utf8");
  const sections = new Map(
    [
      ...workflow
        .split(/^jobs:\n/m)[1]
        .matchAll(/^  ([\w-]+):\n([\s\S]*?)(?=^  [\w-]+:\n|(?![\s\S]))/gm),
    ].map((match) => [match[1], match[2]]),
  );
  assert.deepEqual(
    [...sections.keys()].filter((job) => !["queue_ci", "queue_qualification"].includes(job)).sort(),
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
  const receipt = sections.get("queue_qualification");
  for (const job of JOBS) assert.match(receipt, new RegExp(`needs:.*(?:\\[|, )${job}(?:,|\\])`));
  assert.match(receipt, /github.event_name == 'merge_group'/);
  const probe = sections.get("queue_ci");
  assert.match(probe, /github.event_name == 'push'.*refs\/heads\/main/);
  assert.equal((probe.match(/uses: actions\/upload-artifact/g) ?? []).length, 7);
  assert.equal((probe.match(/overwrite: true/g) ?? []).length, 7);
  assert.ok(probe.lastIndexOf("uses: actions/upload-artifact") < probe.indexOf("id: complete"));
  assert.ok(!/always\(\)/.test(probe), "failed publication must prevent the reuse marker");
  for (const job of ["test_web", "test_server"]) assert.match(sections.get(job), /overwrite: true/);
  assert.match(sections.get("test_server"), /name: thread-transfer-results[\s\S]*overwrite: true/);
  assert.match(sections.get("test"), /needs.queue_ci.outputs.reused == 'true'/);
  assert.match(sections.get("transfer-report"), /needs.queue_ci.outputs.reused == 'true'/);
});
