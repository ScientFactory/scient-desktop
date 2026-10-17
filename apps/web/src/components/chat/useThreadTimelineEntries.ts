import type {
  OrchestrationV2ProjectedTurnItem,
  OrchestrationV2ThreadProjection,
} from "@t3tools/contracts";
import {
  codexFeedbackMessage,
  type CodexFeedbackSubmission,
} from "@t3tools/client-runtime/state/threads";
import { useIncrementalTimelineEntries } from "../../hooks/useIncrementalTimelineEntries";
// SCIENT-FORK:START — a queue-admission preview renders in the queue strip, not the timeline.
import {
  optimisticTimelineMessages,
  type OptimisticUserMessage,
} from "../../scient/threadQueue/optimisticQueuePresentation";
// SCIENT-FORK:END

/**
 * The thread's timeline entries and the optimistic messages they show. The
 * derived collections are built here so they keep their identity while their
 * inputs do: the incremental projection compares them to skip rebuilding, and
 * rebuilds during render whenever one changes.
 */
export function useThreadTimelineEntries(input: {
  readonly threadKey: string | null;
  readonly visibleTurnItems: ReadonlyArray<OrchestrationV2ProjectedTurnItem>;
  readonly projection: OrchestrationV2ThreadProjection | null;
  readonly serverAttachmentUrlById: ReadonlyMap<string, string>;
  readonly attachmentPreviewHandoffByMessageId: Readonly<Record<string, ReadonlyArray<string>>>;
  readonly feedbackSubmissions: ReadonlyArray<CodexFeedbackSubmission>;
  readonly optimisticMessages: ReadonlyArray<OptimisticUserMessage>;
}) {
  const {
    threadKey,
    visibleTurnItems,
    projection,
    serverAttachmentUrlById,
    attachmentPreviewHandoffByMessageId,
    feedbackSubmissions,
  } = input;
  const attachmentUrlById = new Map(serverAttachmentUrlById);
  for (const row of visibleTurnItems) {
    if (row.item.type !== "user_message") continue;
    const handoffUrls = attachmentPreviewHandoffByMessageId[row.item.messageId];
    if (handoffUrls === undefined) continue;
    let imageIndex = 0;
    for (const attachment of row.item.attachments) {
      if (attachment.type !== "image") continue;
      const handoffUrl = handoffUrls[imageIndex];
      imageIndex += 1;
      if (handoffUrl !== undefined) attachmentUrlById.set(attachment.id, handoffUrl);
    }
  }
  const anchoredMessages = feedbackSubmissions.flatMap((submission) =>
    submission.status === "interrupted"
      ? []
      : [
          { ...codexFeedbackMessage(submission), runId: null },
          { ...codexFeedbackMessage(submission, "assistant"), runId: null },
        ],
  );
  // SCIENT-FORK:START
  const optimisticMessages = optimisticTimelineMessages(input.optimisticMessages);
  // SCIENT-FORK:END
  const serverEntries = useIncrementalTimelineEntries(threadKey, {
    visibleTurnItems,
    optimisticMessages,
    anchoredMessages,
    attachmentUrlById,
    ...(projection === null
      ? {}
      : { attempts: projection.attempts, nodes: projection.nodes, plans: projection.plans }),
  });
  return { serverEntries, optimisticMessages };
}
