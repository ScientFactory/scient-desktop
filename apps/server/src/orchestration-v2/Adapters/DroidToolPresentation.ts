import * as Predicate from "effect/Predicate";
import {
  endDroidSubagents,
  makeDroidSubagentTracker,
  observeDroidSubagentToolCall,
  type DroidSubagentEvent,
} from "../../provider/droid/DroidSubagents.ts";
import type { ProviderAdapterV2TurnInput } from "../ProviderAdapter.ts";
import type { AcpAdapterV2SubagentUpdate, AcpAdapterV2ToolPresentation } from "./AcpAdapterV2.ts";

/** Fold Droid's Task/TaskOutput protocol into this native turn's presentation. */
export function makeDroidToolPresentation(
  input: ProviderAdapterV2TurnInput,
): AcpAdapterV2ToolPresentation {
  const tracker = makeDroidSubagentTracker();
  const prompts = new Map<string, string>();
  const project = (event: DroidSubagentEvent): AcpAdapterV2SubagentUpdate => {
    const payload = event.payload;
    const result =
      event.type === "task.started"
        ? null
        : event.type === "task.updated"
          ? (event.payload.error ?? event.payload.description ?? null)
          : (event.payload.summary ?? null);
    return {
      nativeTaskId: payload.taskId,
      prompt: prompts.get(payload.taskId) ?? payload.title,
      title: payload.role ? `${payload.title} [${payload.role}]` : payload.title,
      model: null,
      status: event.type === "task.started" ? "running" : event.payload.status,
      childSessionId: null,
      result,
    };
  };
  return {
    observe: (toolCall) => {
      const rawInput = toolCall.data.rawInput;
      if (
        Predicate.isObject(rawInput) &&
        "prompt" in rawInput &&
        typeof rawInput.prompt === "string"
      )
        prompts.set(toolCall.toolCallId, rawInput.prompt);
      const observation = observeDroidSubagentToolCall(tracker, toolCall, input.attemptId);
      return {
        subagents: observation.events.map(project),
        tool:
          observation.item === "none"
            ? undefined
            : observation.item === "unchanged"
              ? toolCall
              : observation.item,
      };
    },
    finish: (status) =>
      endDroidSubagents(
        tracker,
        status === "completed" ? "turn-ended" : status === "failed" ? "session-ended" : "stop",
      ).map(project),
  };
}
