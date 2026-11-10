const assert = require("node:assert/strict");
const test = require("node:test");
const { queueVerified, MAX_QUEUE_SEGMENTS } = require("./queue-verified.cjs");

const REPO = "ScientFactory/scient-desktop";
const PATH = ".github/workflows/documentation.yml";
const sha = (n) => String(n).repeat(40).slice(0, 40);
const BEFORE = sha(0);
const PR = "f".repeat(40);

// main moves BEFORE -> 1 -> ... -> `entries` in one push; each commit has a queue run.
function fixture(entries = 1) {
  const heads = Array.from({ length: entries }, (_, i) => sha(i + 1));
  const commits = new Map(
    heads.map((head, i) => [
      head,
      { sha: head, parents: [{ sha: heads[i - 1] ?? BEFORE }, { sha: PR }] },
    ]),
  );
  const run = (head, fields = {}) => ({
    id: 100,
    head_sha: head,
    event: "merge_group",
    path: PATH,
    status: "completed",
    conclusion: "success",
    head_branch: "gh-readonly-queue/main/pr-1-x",
    repository: { full_name: REPO },
    head_repository: { full_name: REPO },
    ...fields,
  });
  const runs = new Map(heads.map((head) => [head, [run(head)]]));
  const outputs = {};
  const messages = [];
  const f = {
    commits,
    runs,
    run,
    outputs,
    messages,
    head: heads.at(-1),
    context: {
      eventName: "push",
      ref: "refs/heads/main",
      sha: heads.at(-1),
      runId: 7,
      repo: { owner: "ScientFactory", repo: "scient-desktop" },
      payload: { before: BEFORE },
    },
    core: { setOutput: (k, v) => (outputs[k] = v), info: (m) => messages.push(m) },
    sleeps: [],
  };
  f.github = {
    rest: {
      actions: {
        getWorkflowRun: async () => ({
          data: { id: 7, head_sha: f.context.sha, workflow_id: 3, path: PATH },
        }),
        listWorkflowRuns: async ({ head_sha, event, workflow_id }) => {
          assert.equal(event, "merge_group");
          assert.equal(workflow_id, 3);
          return { data: { workflow_runs: structuredClone(f.runs.get(head_sha) ?? []) } };
        },
      },
      git: {
        getCommit: async ({ commit_sha }) => {
          const data = f.commits.get(commit_sha);
          if (!data) throw new Error("Not Found");
          return { data: structuredClone(data) };
        },
      },
    },
  };
  f.verify = () =>
    queueVerified({
      github: f.github,
      context: f.context,
      core: f.core,
      sleep: async (ms) => f.sleeps.push(ms),
    });
  return f;
}

test("a push whose every landed commit passed in the queue is verified", async () => {
  for (const entries of [1, 3, MAX_QUEUE_SEGMENTS]) {
    const f = fixture(entries);
    await f.verify();
    assert.equal(f.outputs.verified, "true", f.messages.join("\n"));
  }
});

for (const [name, change] of [
  ["a pull request event", (f) => (f.context.eventName = "pull_request")],
  ["another branch", (f) => (f.context.ref = "refs/heads/release/stable")],
  ["a missing before", (f) => (f.context.payload.before = "0")],
  ["a commit the queue never ran (administrator merge)", (f) => f.runs.set(f.head, [])],
  ["a failed queue run", (f) => (f.runs.get(f.head)[0].conclusion = "failure")],
  [
    "a queue run of another workflow",
    (f) => (f.runs.get(f.head)[0].path = ".github/workflows/ci.yml"),
  ],
  ["a fork run", (f) => (f.runs.get(f.head)[0].head_repository = { full_name: "x/fork" })],
  ["a run outside the queue", (f) => (f.runs.get(f.head)[0].head_branch = "feature")],
  ["a run of another commit", (f) => (f.runs.get(f.head)[0].head_sha = sha(9))],
  ["a direct commit", (f) => (f.commits.get(f.head).parents = [{ sha: BEFORE }])],
  ["an unknown commit", (f) => f.commits.delete(f.head)],
  ["a history that never reaches before", (f) => (f.commits.get(f.head).parents[0].sha = sha(8))],
  [
    "an API failure",
    (f) =>
      (f.github.rest.actions.listWorkflowRuns = async () => {
        throw new Error("502");
      }),
  ],
]) {
  test(`${name} runs the full check`, async () => {
    const f = fixture();
    change(f);
    await f.verify();
    assert.equal(f.outputs.verified, "false");
  });
}

test("one unchecked commit in a multi-entry push runs the full check", async () => {
  const f = fixture(3);
  f.runs.set(sha(2), []);
  await f.verify();
  assert.equal(f.outputs.verified, "false");
});

test("a push longer than the queue's merge limit runs the full check", async () => {
  const f = fixture(MAX_QUEUE_SEGMENTS + 1);
  await f.verify();
  assert.equal(f.outputs.verified, "false");
});

test("a queue run still finishing is awaited briefly, then treated as missing", async () => {
  const f = fixture();
  let looks = 0;
  const list = f.github.rest.actions.listWorkflowRuns;
  f.github.rest.actions.listWorkflowRuns = async (input) =>
    looks++ < 2
      ? { data: { workflow_runs: [f.run(f.head, { status: "in_progress", conclusion: null })] } }
      : list(input);
  await f.verify();
  assert.equal(f.outputs.verified, "true");
  assert.equal(f.sleeps.length, 2);
  const stuck = fixture();
  stuck.runs.set(stuck.head, [stuck.run(stuck.head, { status: "in_progress", conclusion: null })]);
  await stuck.verify();
  assert.equal(stuck.outputs.verified, "false");
  assert.ok(stuck.sleeps.length > 0 && stuck.sleeps.length < 5);
});
