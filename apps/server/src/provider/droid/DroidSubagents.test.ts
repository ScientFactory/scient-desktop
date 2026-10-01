import { TurnId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import type { AcpToolCallState } from "../acp/AcpRuntimeModel.ts";
import {
  droidSubagentActivity,
  endDroidSubagents,
  makeDroidSubagentTracker,
  observeDroidSubagentToolCall,
  type DroidSubagentEvent,
} from "./DroidSubagents.ts";

const TURN = TurnId.make("turn-1");

/** A tool call as the ACP runtime hands it over: its merged state. */
const call = (
  toolCallId: string,
  input: {
    readonly title?: string;
    readonly status?: AcpToolCallState["status"];
    readonly rawInput?: unknown;
    readonly text?: string;
  },
): AcpToolCallState => ({
  toolCallId,
  kind: "other",
  ...(input.title ? { title: input.title } : {}),
  status: input.status ?? "pending",
  data: {
    toolCallId,
    kind: "other",
    ...(input.rawInput !== undefined ? { rawInput: input.rawInput } : {}),
    ...(input.text !== undefined ? { rawOutput: { text: input.text } } : {}),
  },
});
const task = (toolCallId: string, description: string, extra?: Parameters<typeof call>[1]) =>
  call(toolCallId, {
    title: "Task",
    rawInput: { subagent_type: "explorer", description, prompt: "Do it." },
    ...extra,
  });
const brief = (events: ReadonlyArray<DroidSubagentEvent>) =>
  events.map((event) =>
    event.type === "task.updated"
      ? `${event.type} ${event.payload.status}: ${event.payload.error ?? event.payload.description}`
      : event.type === "task.completed"
        ? `${event.type} ${event.payload.status}: ${event.payload.summary}`
        : event.type === "task.progress"
          ? `${event.type} ${event.payload.status}: ${event.payload.summary}`
          : `${event.type}: ${event.payload.title}`,
  );

describe("Droid sub-agents", () => {
  it("leaves calls that are not about a sub-agent alone", () => {
    const tracker = makeDroidSubagentTracker();
    const read = call("read-1", { title: "Read file", rawInput: { file_path: "/a" } });
    expect(observeDroidSubagentToolCall(tracker, read, TURN)).toEqual({
      events: [],
      item: "unchanged",
    });
    expect(droidSubagentActivity(tracker)).toEqual({
      open: 0,
      background: 0,
      announcedWaitMillis: undefined,
    });
  });

  it("keeps Droid's own words when Droid cancels a sub-agent, and ignores the call announced again", () => {
    const tracker = makeDroidSubagentTracker();
    observeDroidSubagentToolCall(tracker, task("t", "Audit the code"), TURN);
    const cancelled = observeDroidSubagentToolCall(
      tracker,
      task("t", "Audit the code", {
        status: "failed",
        text: "Error: Tool execution cancelled by user",
      }),
      TURN,
    );
    expect(brief(cancelled.events)).toEqual([
      "task.updated cancelled: Tool execution cancelled by user",
    ]);
    // Droid 0.231.0 announces the cancelled call again, untitled and without input, and fails it again.
    for (const again of [
      call("t", { title: "Tool call", rawInput: {} }),
      call("t", {
        title: "Tool",
        status: "failed",
        text: "Error: Tool execution cancelled by user",
      }),
    ]) {
      expect(observeDroidSubagentToolCall(tracker, again, TURN)).toEqual({
        events: [],
        item: "none",
      });
    }
    expect(droidSubagentActivity(tracker).open).toBe(0);
  });

  it("reads a background sub-agent's end from whatever status Droid reports", () => {
    for (const [status, expected] of [
      ["completed", "task.completed completed: All good."],
      ["failed", "task.completed failed: All good."],
      ["cancelled", "task.updated cancelled: All good."],
      // A status Scient does not know changes nothing: the sub-agent stays as it was.
      ["rescheduled", undefined],
    ] as const) {
      const tracker = makeDroidSubagentTracker();
      observeDroidSubagentToolCall(tracker, task("t", "Review the host"), TURN);
      observeDroidSubagentToolCall(
        tracker,
        task("t", "Review the host", {
          status: "completed",
          text: "Task launched in background.\ntask_id: droid-1\nsession_id: droid-1",
        }),
        TURN,
      );
      const waited = observeDroidSubagentToolCall(
        tracker,
        call("w", {
          title: "TaskOutput",
          status: "completed",
          rawInput: { task_id: "droid-1", block: true, timeout: 90_000 },
          text: `Task ID: droid-1\nDescription: Review the host\nStatus: ${status}\nDuration: 3s\n\nAll good.`,
        }),
        TURN,
      );
      expect(brief(waited.events), status).toEqual(expected ? [expected] : []);
      expect(waited.item, status).toMatchObject({
        title: "Waited for sub-agent · Review the host",
      });
      const left = expected ? 0 : 1;
      expect(droidSubagentActivity(tracker), status).toMatchObject({
        open: left,
        background: left,
      });
    }
  });

  it("names a wait on a sub-agent it did not see launched from Droid's answer", () => {
    const tracker = makeDroidSubagentTracker();
    const waiting = observeDroidSubagentToolCall(
      tracker,
      call("w", {
        title: "TaskOutput",
        rawInput: { task_id: "earlier", block: true, timeout: 90_000 },
      }),
      TURN,
    );
    expect(waiting.item).toMatchObject({ title: "Waiting for a sub-agent (up to 90 s)" });
    expect(droidSubagentActivity(tracker)).toMatchObject({ open: 0, announcedWaitMillis: 90_000 });
    const failed = observeDroidSubagentToolCall(
      tracker,
      call("w", { title: "Tool", status: "failed", text: "Error: No task with that id." }),
      TURN,
    );
    expect(failed).toMatchObject({
      events: [],
      item: { title: "Waiting for a sub-agent (up to 90 s)", detail: "No task with that id." },
    });
    expect(droidSubagentActivity(tracker).announcedWaitMillis).toBeUndefined();
  });

  it("counts what the idle watchdog must allow for", () => {
    const tracker = makeDroidSubagentTracker();
    observeDroidSubagentToolCall(tracker, task("a", "A"), TURN);
    observeDroidSubagentToolCall(
      tracker,
      call("w1", {
        title: "TaskOutput",
        rawInput: { task_id: "x", block: true, timeout: 600_000 },
      }),
      TURN,
    );
    observeDroidSubagentToolCall(
      tracker,
      call("w2", { title: "TaskOutput", rawInput: { task_id: "y", block: false } }),
      TURN,
    );
    expect(droidSubagentActivity(tracker)).toEqual({
      open: 1,
      background: 0,
      announcedWaitMillis: 600_000,
    });
    // A wait Droid put no limit on has no deadline Scient could hold it to.
    observeDroidSubagentToolCall(
      tracker,
      call("w3", { title: "TaskOutput", rawInput: { task_id: "z", block: true } }),
      TURN,
    );
    expect(droidSubagentActivity(tracker).announcedWaitMillis).toBe("unbounded");
  });

  it("says why the sub-agents still open ended", () => {
    const launch = () => {
      const tracker = makeDroidSubagentTracker();
      observeDroidSubagentToolCall(tracker, task("fg", "Foreground"), TURN);
      observeDroidSubagentToolCall(tracker, task("bg", "Background"), TURN);
      observeDroidSubagentToolCall(
        tracker,
        task("bg", "Background", {
          status: "completed",
          text: "Task launched in background.\ntask_id: droid-bg",
        }),
        TURN,
      );
      return tracker;
    };
    expect(brief(endDroidSubagents(launch(), "stop"))).toEqual([
      "task.updated cancelled: Cancelled when you stopped the turn.",
      "task.updated interrupted: Scient closed this Droid session and can no longer follow this sub-agent.",
    ]);
    expect(brief(endDroidSubagents(launch(), "turn-ended"))).toEqual([
      "task.updated interrupted: The turn ended before Droid reported this sub-agent's result.",
      "task.updated idle: The turn ended. Droid has not reported this sub-agent's result.",
    ]);
    const ended = launch();
    expect(brief(endDroidSubagents(ended, "session-ended"))).toEqual([
      "task.updated interrupted: The Droid session ended.",
      "task.updated interrupted: The Droid session ended.",
    ]);
    // Ended once: nothing is said twice.
    expect(endDroidSubagents(ended, "session-ended")).toEqual([]);
  });
});
