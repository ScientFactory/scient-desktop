import { assert, it } from "@effect/vitest";

import { OmpWaitRows } from "./OmpWaitRows.ts";

const task = (id: string, status = "running") => ({
  id,
  type: "task",
  status,
  label: id,
  agentUrlId: id,
});
const build = (status = "running") => ({
  id: "bg-1",
  type: "bash",
  status,
  label: "pnpm build",
  intent: "build",
});
const waiting = (...jobs: object[]) => ({ details: { op: "wait", jobs } });
const idle = (...jobs: object[]) => ({ ...waiting(...jobs), useless: true });

it("shows no rows for idle waits on subagents the timeline already groups", () => {
  const rows = new OmpWaitRows();
  rows.noteSubagent("reviewer", false);
  rows.noteSubagent("tester", false);
  for (const call of ["w1", "w2", "w3"]) {
    assert.isUndefined(rows.title(call, "running", undefined));
    assert.isUndefined(rows.title(call, "running", waiting(task("reviewer"), task("tester"))));
    assert.isUndefined(rows.title(call, "completed", idle(task("reviewer"), task("tester"))));
  }
});

it("shows a subagent's result only when its own row has not settled yet", () => {
  const rows = new OmpWaitRows();
  rows.noteSubagent("reviewer", false);
  assert.strictEqual(
    rows.title("w1", "completed", waiting(task("reviewer", "completed"))),
    "Result from reviewer",
  );
  rows.noteSubagent("reviewer", true);
  assert.isUndefined(rows.title("w2", "completed", waiting(task("reviewer", "completed"))));
});

it("names other waits, settles them, and drops idle repeats until other work happens", () => {
  const rows = new OmpWaitRows();
  assert.strictEqual(rows.title("w1", "running", waiting(build())), "Waiting for build");
  assert.strictEqual(rows.title("w1", "completed", idle(build())), "Waited for build");
  assert.isUndefined(rows.title("w2", "running", waiting(build())));
  assert.isUndefined(rows.title("w2", "completed", idle(build())));
  assert.strictEqual(
    rows.title("w3", "completed", waiting(build("completed"))),
    "Result from build",
  );
  rows.noteActivity();
  assert.strictEqual(rows.title("w4", "running", waiting(build())), "Waiting for build");
});

it("settles a shown row however the wait ends", () => {
  const rows = new OmpWaitRows();
  rows.title("w1", "running", waiting(build()));
  assert.strictEqual(
    rows.title("w1", "completed", { details: { op: "wait", interrupted: true } }),
    "Waited for build",
  );
  rows.title("w2", "running", waiting(build()));
  assert.strictEqual(rows.title("w2", "failed", undefined), "Waited for build");
});

it("keeps messages, failures and results it cannot read visible", () => {
  const rows = new OmpWaitRows();
  assert.strictEqual(
    rows.title("w1", "completed", {
      details: { op: "wait", waited: [{ from: "Reviewer" }, { from: "Tester" }] },
    }),
    "Messages from Reviewer and Tester",
  );
  assert.strictEqual(rows.title("w2", "failed", undefined), "Wait failed");
  assert.strictEqual(
    rows.title("w3", "completed", { content: [{ type: "text", text: "service ended" }] }),
    "Waited for background work",
  );
  assert.isUndefined(rows.title("w4", "completed", { useless: true }));
});
