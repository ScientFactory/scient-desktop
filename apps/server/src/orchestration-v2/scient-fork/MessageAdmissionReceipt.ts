/** The dispatch receipt a client receives for a committed command. */
import type { OrchestrationV2Command } from "@t3tools/contracts";

import type * as Orchestrator from "../Orchestrator.ts";

/** Admission is the committed command's decision, including when its receipt is replayed. */
export function dispatchCommandReceipt(
  command: OrchestrationV2Command,
  result: Orchestrator.OrchestratorV2DispatchResult,
) {
  if (command.type !== "message.dispatch") return { sequence: result.sequence };
  const queued = result.storedEvents.some(
    ({ event }) =>
      event.type === "run.created" &&
      event.payload.userMessageId === command.messageId &&
      event.payload.status === "queued",
  );
  return {
    sequence: result.sequence,
    queued,
    submission: {
      submissionId: command.messageId,
      outcome: queued ? ("queued" as const) : ("sent" as const),
    },
  };
}
