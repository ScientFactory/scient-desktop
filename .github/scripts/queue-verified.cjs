// A push to main lands commits the merge queue already checked with this same workflow.
// The workflow's push run skips its work only when every landed commit, walking first
// parents back to the commit main held before, has a successful queue run of it.
const SHA = /^[a-f0-9]{40}$/;
// The main ruleset lands at most this many queue entries in one push (max_entries_to_merge).
const MAX_QUEUE_SEGMENTS = 6;
// Required checks finish before the queue merges, but the run can still read as in progress.
const SETTLE_TRIES = 4;
const SETTLE_DELAY_MS = 10_000;

const assert = (condition, message) => {
  if (!condition) throw new Error(message);
};

async function queueVerified({
  github,
  context,
  core,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
}) {
  core.setOutput("verified", "false");
  try {
    assert(context.eventName === "push" && context.ref === "refs/heads/main", "Not a main push");
    const before = context.payload.before;
    assert(SHA.test(before) && SHA.test(context.sha), "Push comparison is missing");
    const repo = context.repo;
    const repository = `${repo.owner}/${repo.repo}`;
    const api = github.rest.actions;
    const { data: current } = await api.getWorkflowRun({ ...repo, run_id: context.runId });
    assert(current.id === context.runId && current.head_sha === context.sha, "Run differs");
    const queueRuns = async (head) =>
      (
        await api.listWorkflowRuns({
          ...repo,
          workflow_id: current.workflow_id,
          event: "merge_group",
          head_sha: head,
          per_page: 20,
        })
      ).data.workflow_runs.filter(
        (run) =>
          run.head_sha === head &&
          run.event === "merge_group" &&
          run.path === current.path &&
          run.repository?.full_name === repository &&
          run.head_repository?.full_name === repository &&
          run.head_branch?.startsWith("gh-readonly-queue/main/"),
      );
    const landed = [];
    for (let head = context.sha; head !== before;) {
      assert(landed.length < MAX_QUEUE_SEGMENTS, "Push is not covered by queue runs");
      let runs = await queueRuns(head);
      for (let tries = 1; runs.some((run) => run.status !== "completed"); tries++) {
        if (tries >= SETTLE_TRIES) break;
        await sleep(SETTLE_DELAY_MS);
        runs = await queueRuns(head);
      }
      assert(
        runs.some((run) => run.status === "completed" && run.conclusion === "success"),
        `No successful queue run of ${head}`,
      );
      const { data: commit } = await github.rest.git.getCommit({ ...repo, commit_sha: head });
      const parents = (commit.parents ?? []).map((parent) => parent.sha);
      // A queue commit merges one pull request onto the entry before it.
      assert(
        commit.sha === head && parents.length === 2 && parents.every((sha) => SHA.test(sha)),
        `${head} is not a queue merge`,
      );
      landed.push(head);
      head = parents[0];
    }
    assert(landed.length > 0, "Push lands nothing");
    core.setOutput("verified", "true");
    core.info(`The merge queue already ran this check on ${landed.join(", ")}.`);
  } catch (error) {
    core.info(
      `Running the full check: ${error instanceof Error ? error.message : "no queue evidence"}`,
    );
  }
}

module.exports = { queueVerified, MAX_QUEUE_SEGMENTS };
