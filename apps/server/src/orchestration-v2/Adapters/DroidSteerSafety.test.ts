import { assert, it } from "@effect/vitest";
import { makeDroidSteerSafety } from "./DroidSteerSafety.ts";

it("invalidates ready leases for an open decoded batch, changed native work and intent replacement", () => {
  const safety = makeDroidSteerSafety();
  const lease = safety.reserve("older")!;
  safety.batch("begin");
  assert.isFalse(safety.consume(lease));
  safety.observe({ toolCallId: "next", status: "inProgress", data: {} }, "source");
  safety.batch("end");
  assert.isUndefined(safety.reserve("newer"));
  safety.observe({ toolCallId: "next", status: "completed", data: {} }, "source");
  const ready = safety.reserve("newer")!;
  safety.invalidate();
  assert.isFalse(safety.consume(ready));
  const newest = safety.reserve("newest")!;
  assert.isTrue(safety.consume(newest));
  assert.isFalse(safety.consume(newest));
});

it("allows actual successful return to retire foreground work but retains native background linkage", () => {
  const safety = makeDroidSteerSafety();
  safety.observe({ toolCallId: "run", status: "inProgress", data: {} }, "source");
  safety.observe(
    {
      toolCallId: "task",
      title: "Task",
      status: "completed",
      data: {
        rawInput: { subagent_type: "explorer", description: "Review", prompt: "Review it." },
        rawOutput: { text: "Task launched in background.\ntask_id: t-1\nsession_id: t-1" },
      },
    },
    "source",
  );
  safety.promptReturned();
  assert.isUndefined(safety.reserve("held"));
  for (const [id, taskId, status] of [
    ["unknown", "other", "completed"],
    ["check", "t-1", "running"],
    ["wait", "t-1", "completed"],
  ]) {
    safety.observe(
      {
        toolCallId: id!,
        title: "TaskOutput",
        status: "completed",
        data: {
          rawInput: { task_id: taskId, block: true, timeout: 600000 },
          rawOutput: { text: `Task ID: ${taskId}\nStatus: ${status}\n\nNative result.` },
        },
      },
      "source",
    );
    assert.equal(safety.reserve("held") !== undefined, status === "completed" && taskId === "t-1");
  }
});

it("never treats failed decoding or a fresh prompt controller as the previous native reservation", () => {
  const safety = makeDroidSteerSafety();
  const old = safety.reserve("persisted-revision")!;
  safety.batch("begin");
  safety.batch("failed");
  safety.promptReturned();
  assert.isUndefined(safety.reserve("persisted-revision"));
  assert.isFalse(safety.consume(old));
  const fresh = makeDroidSteerSafety();
  assert.isFalse(fresh.consume(old));
});
