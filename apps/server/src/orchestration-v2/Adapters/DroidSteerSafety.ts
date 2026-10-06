// SCIENT-FORK:START — native Droid readiness is a lease, never a persisted execution authority.
import * as Data from "effect/Data";
import { mergeToolCallState } from "../../provider/acp/AcpRuntimeModel.ts";
import type { AcpToolCallState } from "../../provider/acp/AcpRuntimeModel.ts";
import {
  makeDroidSubagentTracker,
  observeDroidSubagentToolCall,
  droidSubagentActivity,
} from "../../provider/droid/DroidSubagents.ts";

export class DroidSteerDeferred extends Data.TaggedError("DroidSteerDeferred") {}
export class DroidSteerUncertain extends Data.TaggedError("DroidSteerUncertain")<{
  readonly message: string;
}> {}

export function makeDroidSteerSafety() {
  const tasks = makeDroidSubagentTracker();
  const tools = new Map<string, AcpToolCallState>();
  let epoch = 0;
  let depth = 0;
  let failed = false;
  let consumed = false;
  let returned = false;
  let lease: { id: string; epoch: number } | undefined;
  let serial = 0;
  const invalidate = () => {
    epoch++;
    lease = undefined;
  };
  const ready = () =>
    !failed &&
    !consumed &&
    depth === 0 &&
    (returned
      ? droidSubagentActivity(tasks).background === 0
      : !Array.from(tools.values()).some(
          (tool) =>
            tool.status === "pending" ||
            tool.status === "inProgress" ||
            tool.status === "requiresAction",
        ) && droidSubagentActivity(tasks).open === 0);
  const validate = (id: string) => ready() && lease?.id === id && lease.epoch === epoch;
  return {
    invalidate,
    promptReturned() {
      invalidate();
      returned = true;
    },
    toolIds: () => Array.from(tools.keys()),
    batch(phase: "begin" | "end" | "failed") {
      invalidate();
      if (phase === "begin") depth++;
      else {
        depth = Math.max(0, depth - 1);
        if (phase === "failed") failed = true;
      }
    },
    observe(tool: AcpToolCallState, turnId: string) {
      invalidate();
      const merged = mergeToolCallState(tools.get(tool.toolCallId), tool);
      tools.set(tool.toolCallId, merged);
      observeDroidSubagentToolCall(tasks, merged, turnId);
    },
    reserve(revision: string) {
      if (!ready()) return undefined;
      const id = `${revision}:${++serial}`;
      lease = { id, epoch };
      return id;
    },
    validate,
    consume(id: string) {
      if (!validate(id)) return false;
      consumed = true;
      lease = undefined;
      return true;
    },
    get consumed() {
      return consumed;
    },
  };
}
// SCIENT-FORK:END
