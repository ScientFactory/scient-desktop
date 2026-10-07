import {
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { deriveThreadQueueWorkflowState } from "@t3tools/client-runtime/state/thread-workflows";
import { canSendQueueHead, isQueueUsageLimitProven } from "@t3tools/shared/scientQueueHeadSend";
import type { ChatAttachment, EnvironmentId, MessageId, RunId, ThreadId } from "@t3tools/contracts";
import { useImperativeHandle, useMemo, useRef, useState, type Ref } from "react";
import { useAssetUrls } from "../../assets/assetUrls";
import { threadEnvironment } from "../../state/threads";
import { useThreadProjection, useThreadShell } from "../../state/entities";
import { useAtomCommand } from "../../state/use-atom-command";
import type { ChatMessage } from "../../types";
import { ThreadQueueStrip } from "../../scient/threadQueue/ThreadQueueStrip";

export interface EditQueuedRunRequest {
  readonly runId: RunId;
  readonly messageId: MessageId;
  readonly text: string;
  readonly attachments: ReadonlyArray<ChatAttachment>;
}
export interface QueuedRunsControlHandle {
  steerNext: (repeat: boolean) => boolean;
  editLatest: (repeat: boolean) => boolean;
}

/** Native queue state and commands, presented once in Scient's composer strip. */
export function QueuedRunsControl({
  ref,
  ...props
}: {
  readonly ref?: Ref<QueuedRunsControlHandle>;
  readonly steerShortcutLabel?: string | null;
  readonly editShortcutLabel?: string | null;
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly optimisticMessages: ReadonlyArray<
    Pick<ChatMessage, "id" | "inputIntent" | "text" | "attachments"> & {
      readonly queueAdmission?: { readonly accepted: boolean };
    }
  >;
  readonly editingRunId: RunId | null;
  readonly onEditQueuedRun: (request: EditQueuedRunRequest) => void;
  readonly onCancelEdit: () => void;
  readonly error?: string | null;
}) {
  const threadRef = scopeThreadRef(props.environmentId, props.threadId);
  const projection = useThreadProjection(threadRef)?.projection;
  // SCIENT-FORK:START queue-head-send-rule
  const shell = useThreadShell(threadRef);
  // SCIENT-FORK:END queue-head-send-rule
  const reorder = useAtomCommand(threadEnvironment.reorderQueuedRun);
  const promote = useAtomCommand(threadEnvironment.promoteQueuedRun);
  const cancel = useAtomCommand(threadEnvironment.cancelQueuedRun);
  const resume = useAtomCommand(threadEnvironment.resumeThreadQueue);
  const [busyId, setBusyId] = useState<string | null>(null);
  const busyRef = useRef(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const workflow = useMemo(
    () => (projection ? deriveThreadQueueWorkflowState(projection) : null),
    [projection],
  );
  const queued = workflow?.queuedRuns ?? [];
  const failedHead =
    workflow?.isHeld === true &&
    queued[0] !== undefined &&
    projection?.turnItems.some(
      (item) =>
        item.type === "error" &&
        item.runId === queued[0]?.run.id &&
        item.failure.code === "queued_start_failed",
    ) === true;
  // SCIENT-FORK:START queue-head-send-rule — a held queue offers only what queue.resume accepts.
  // A windowed snapshot can miss the session that lifts a usage limit, so the
  // limit hides controls only when the server-computed shell confirms it.
  const heldProjection = workflow?.isHeld === true && projection != null ? projection : null;
  const usageLimited =
    heldProjection !== null &&
    isQueueUsageLimitProven(heldProjection, shell?.runtime?.lastErrorClass);
  const queueResumable = heldProjection !== null && !usageLimited;
  const headSendable =
    heldProjection !== null &&
    queued[0] !== undefined &&
    canSendQueueHead(heldProjection, queued[0].run.id, usageLimited);
  // SCIENT-FORK:END queue-head-send-rule
  const items = queued.map(({ run, text, attachments }) => ({
    queueItemId: run.id,
    runId: run.id,
    messageId: run.userMessageId,
    text,
    attachments,
  }));
  const imageIds = queued.flatMap(({ attachments }) =>
    attachments.filter((item) => item.type === "image").map((item) => item.id),
  );
  const imageUrls = useAssetUrls(
    props.environmentId,
    imageIds.map((attachmentId) => ({ _tag: "attachment" as const, attachmentId })),
  );
  const attachmentUrls = new Map(
    imageIds.flatMap((id, index) => {
      const url = imageUrls[index];
      return url ? [[id, url] as const] : [];
    }),
  );
  // Acknowledged messages retire their optimistic copies even after their run
  // has left the queue; filtering only by queued IDs would resurrect them.
  const acknowledged = new Set((projection?.messages ?? []).map((item) => item.id));
  const pendingMessages = props.optimisticMessages
    .filter(
      (message) =>
        (message.inputIntent === "queued_turn" || message.queueAdmission !== undefined) &&
        !acknowledged.has(message.id),
    )
    .map((message) => ({
      id: message.id,
      text: message.text,
      attachmentCount: message.attachments?.length ?? 0,
      accepted: message.queueAdmission?.accepted === true,
    }));
  const perform = async (
    id: string,
    action: () => Promise<AtomCommandResult<unknown, unknown>>,
  ) => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusyId(id);
    setActionError(null);
    try {
      const result = await action();
      if (result._tag === "Failure") throw squashAtomCommandFailure(result);
    } catch (cause) {
      setActionError(
        cause instanceof Error ? cause.message : "The queued message action failed. Try again.",
      );
    } finally {
      busyRef.current = false;
      setBusyId(null);
    }
  };
  const edit = (item: (typeof items)[number]) =>
    props.onEditQueuedRun({
      runId: item.runId,
      messageId: item.messageId,
      text: item.text,
      attachments: item.attachments,
    });
  const steer = (runId: RunId) => {
    const active = workflow?.activeRun;
    if (!active || !workflow.canPromoteToSteer) return;
    void perform(runId, () =>
      promote({
        environmentId: props.environmentId,
        input: { threadId: props.threadId, queuedRunId: runId, targetRunId: active.id },
      }),
    );
  };
  useImperativeHandle(ref, () => ({
    steerNext(repeat) {
      const first = items[0];
      if (!first || !workflow?.canPromoteToSteer) return false;
      if (!repeat && !busyRef.current) steer(first.runId);
      return true;
    },
    editLatest(repeat) {
      const latest = items.at(-1);
      if (!latest || props.editingRunId !== null || busyRef.current) return false;
      if (!repeat) edit(latest);
      return true;
    },
  }));
  return (
    <ThreadQueueStrip
      items={items}
      pendingMessages={pendingMessages}
      error={
        actionError ??
        props.error ??
        (failedHead
          ? "The queued message could not start. Retry it, or edit or delete the message."
          : null)
      }
      threadBusy={workflow?.activeRun != null}
      supportsExplicitSend={workflow?.isHeld === true && headSendable}
      awaitingCompletion={workflow?.isHeld === true}
      paused={false}
      held={workflow?.isHeld === true}
      // The strip enables dragging only with two queued rows, and reserves the
      // grip while a pending follow-up is about to become the second row.
      canReorder={busyId === null}
      canSteer={workflow?.canPromoteToSteer === true}
      dispatchingItemId={busyId}
      editingItemId={props.editingRunId}
      onCancelEdit={props.onCancelEdit}
      attachmentUrls={attachmentUrls}
      onEdit={(item) => {
        if (!busyRef.current) edit(item);
      }}
      onDelete={(item) => {
        void perform(item.runId, () =>
          cancel({
            environmentId: props.environmentId,
            input: { threadId: props.threadId, runId: item.runId },
          }),
        );
      }}
      onSend={(item) => {
        void perform(item.runId, () =>
          resume({
            environmentId: props.environmentId,
            input: { threadId: props.threadId, runId: item.runId },
          }),
        );
      }}
      onSteer={(item) => steer(item.runId)}
      retryable={failedHead && headSendable}
      onRetry={() => {
        const head = queued[0];
        if (head)
          void perform(head.run.id, () =>
            resume({
              environmentId: props.environmentId,
              input: { threadId: props.threadId, runId: head.run.id },
            }),
          );
      }}
      onResume={
        queueResumable
          ? () => {
              void perform("resume", () =>
                resume({ environmentId: props.environmentId, input: { threadId: props.threadId } }),
              );
            }
          : undefined
      }
      onReorder={(ids) => {
        if (!workflow?.canReorder || busyRef.current) return;
        const movement = resolveNativeQueuedReorder(
          items.map((item) => item.runId),
          ids,
        );
        if (!movement) return;
        const moved = items.find((item) => item.runId === movement.runId);
        if (!moved) return;
        const before = movement.beforeRunId;
        void perform(moved.runId, () =>
          reorder({
            environmentId: props.environmentId,
            input: { threadId: props.threadId, runId: moved.runId, beforeRunId: before },
          }),
        );
      }}
    />
  );
}

/** One sortable drag is one native reorder command, including moves to the tail. */
export function resolveNativeQueuedReorder(
  prior: ReadonlyArray<RunId>,
  next: ReadonlyArray<RunId>,
) {
  if (
    prior.length !== next.length ||
    new Set(next).size !== prior.length ||
    next.some((id) => !prior.includes(id))
  )
    return null;
  if (prior.every((id, index) => id === next[index])) return null;
  for (const runId of prior) {
    const index = next.indexOf(runId);
    const reordered = prior.filter((id) => id !== runId);
    reordered.splice(index, 0, runId);
    if (reordered.every((id, at) => id === next[at]))
      return { runId, beforeRunId: next[index + 1] ?? null };
  }
  return null;
}
