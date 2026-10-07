import type {
  OrchestrationV2AppThread,
  OrchestrationV2ConversationMessage,
  OrchestrationV2Run,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import type { QueueEditItem } from "./editJournal";

/** Snapshot the durable queued policy before cancellation transfers ownership to the draft. */
export function nativeQueueEditItem(
  run: Pick<
    OrchestrationV2Run,
    "id" | "modelSelection" | "runtimeMode" | "interactionMode" | "legacyQueue" | "sourcePlanRef"
  >,
  message: Pick<
    OrchestrationV2ConversationMessage,
    | "id"
    | "text"
    | "attachments"
    | "createdAt"
    | "updatedAt"
    | "context"
    | "composerSnapshot"
    | "selectedScientSkillNames"
  >,
  thread: Pick<OrchestrationV2AppThread, "id" | "runtimeMode" | "interactionMode">,
): QueueEditItem {
  const sourceProposedPlan = run.sourcePlanRef ?? run.legacyQueue?.sourceProposedPlan;
  return {
    queueItemId: run.id,
    threadId: thread.id,
    messageId: message.id,
    text: message.text,
    attachments: message.attachments,
    createdAt: DateTime.formatIso(message.createdAt),
    updatedAt: DateTime.formatIso(message.updatedAt),
    modelSelection: run.modelSelection,
    runtimeMode: run.runtimeMode ?? run.legacyQueue?.runtimeMode ?? thread.runtimeMode,
    interactionMode:
      run.interactionMode ?? run.legacyQueue?.interactionMode ?? thread.interactionMode,
    ...(message.context === undefined ? {} : { context: message.context }),
    ...(message.composerSnapshot === undefined
      ? {}
      : { composerSnapshot: message.composerSnapshot }),
    ...(message.selectedScientSkillNames === undefined
      ? {}
      : { selectedScientSkillNames: message.selectedScientSkillNames }),
    ...(run.legacyQueue?.titleSeed === undefined ? {} : { titleSeed: run.legacyQueue.titleSeed }),
    ...(sourceProposedPlan === undefined ? {} : { sourceProposedPlan }),
  };
}
