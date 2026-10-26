import {
  settlePromise,
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import type { ThreadQueueWorkflowState } from "@t3tools/client-runtime/state/thread-workflows";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentId, RunId, ThreadId } from "@t3tools/contracts";
import { canSendQueuedRun, isQueueUsageLimitProven } from "@t3tools/shared/scientQueuedRunSend";
import { CircleAlertIcon, PencilIcon } from "lucide-react";
import { useRef, useState } from "react";

import { ComposerBanner } from "../../components/chat/ComposerBanner";
import { Button } from "../../components/ui/button";
import { useDelayedStatus } from "../../hooks/useDelayedStatus";
import { useThreadProjection, useThreadShell } from "../../state/entities";
import { threadEnvironment } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";

type Projection = NonNullable<ReturnType<typeof useThreadProjection>>["projection"];

/** Most admissions settle well before this, so their row never says "Queuing…". */
export const QUEUE_ADMISSION_STATUS_DELAY_MS = 700;

const FAILED_START_NOTICE =
  "The queued message could not start. Retry it, or edit or delete the message.";

/**
 * Scient's additions to upstream's queue control: the held-queue Send rule, the failed-start
 * Retry, readable command failures, and the "Editing queued message" row after extraction.
 */
export function useScientQueueParts(input: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly projection: Projection | undefined;
  readonly workflow: ThreadQueueWorkflowState | null;
  readonly editingRunId: RunId | null;
  readonly error: string | null | undefined;
  readonly setBusyRunId: (runId: RunId | null) => void;
}) {
  const { projection, workflow } = input;
  const shell = useThreadShell(scopeThreadRef(input.environmentId, input.threadId));
  const resume = useAtomCommand(threadEnvironment.resumeThreadQueue);
  const [actionError, setActionError] = useState<string | null>(null);
  const busyRef = useRef(false);
  const queued = workflow?.queuedRuns ?? [];
  const head = queued[0];

  // A held queue offers Send on each message the server accepts; Send starts it and resumes
  // the rest. A usage limit hides Send only when the server-computed shell confirms it,
  // because a windowed snapshot can miss the session that lifted the limit.
  const held = workflow?.isHeld === true && projection !== undefined ? projection : null;
  const usageLimited =
    held !== null && isQueueUsageLimitProven(held, shell?.runtime?.lastErrorClass);
  const sendRefused = (runId: RunId) =>
    held !== null &&
    workflow?.canSendNow === true &&
    !canSendQueuedRun(held, runId, { usageLimited });
  const failedHead =
    held !== null &&
    head !== undefined &&
    held.turnItems.some(
      (item) =>
        item.type === "error" &&
        item.runId === head.run.id &&
        item.failure.code === "queued_start_failed",
    );

  // One queue command at a time; a failed command says why instead of failing silently.
  const perform = async (
    runId: RunId,
    action: () => Promise<AtomCommandResult<unknown, unknown>>,
  ) => {
    if (busyRef.current) return;
    busyRef.current = true;
    input.setBusyRunId(runId);
    setActionError(null);
    const settled = await settlePromise(action);
    const result = settled._tag === "Success" ? settled.value : settled;
    if (result._tag === "Failure") {
      const cause = squashAtomCommandFailure(result);
      setActionError(
        cause instanceof Error ? cause.message : "The queued message action failed. Try again.",
      );
    }
    busyRef.current = false;
    input.setBusyRunId(null);
  };

  const retry =
    failedHead && workflow?.activeRun === null && !sendRefused(head.run.id)
      ? () =>
          void perform(head.run.id, () =>
            resume({
              environmentId: input.environmentId,
              input: { threadId: input.threadId, runId: head.run.id },
            }),
          )
      : null;

  return {
    sendRefused,
    perform,
    isBusy: () => busyRef.current,
    notice: actionError ?? input.error ?? (failedHead ? FAILED_START_NOTICE : null),
    retry,
    // Extraction for an edit removes the queued run while its draft is still open.
    detachedEdit:
      input.editingRunId !== null && !queued.some(({ run }) => run.id === input.editingRunId),
  };
}

/** The notice and edit rows shown above the queued messages. */
export function ScientQueueNotices(props: {
  readonly parts: ReturnType<typeof useScientQueueParts>;
  readonly busy: boolean;
  readonly onCancelEdit: () => void;
}) {
  const { detachedEdit, notice, retry } = props.parts;
  return (
    <>
      {detachedEdit ? (
        <ComposerBanner.Row>
          <ComposerBanner.Icon>
            <PencilIcon />
          </ComposerBanner.Icon>
          <ComposerBanner.Content className="text-muted-foreground">
            Editing queued message
          </ComposerBanner.Content>
          <ComposerBanner.Actions>
            <Button
              size="xs"
              variant="ghost"
              aria-label="Cancel editing queued message"
              onClick={props.onCancelEdit}
            >
              Cancel
            </Button>
          </ComposerBanner.Actions>
        </ComposerBanner.Row>
      ) : null}
      {notice === null ? null : (
        <ComposerBanner.Row role="alert">
          <ComposerBanner.Icon className="text-destructive">
            <CircleAlertIcon />
          </ComposerBanner.Icon>
          <ComposerBanner.Content className="block text-destructive wrap-anywhere">
            {notice}
          </ComposerBanner.Content>
          {retry === null ? null : (
            <ComposerBanner.Actions>
              <Button size="xs" variant="outline" disabled={props.busy} onClick={retry}>
                Retry
              </Button>
            </ComposerBanner.Actions>
          )}
        </ComposerBanner.Row>
      )}
    </>
  );
}

/** A follow-up the server has not accepted yet says "Queuing…", only if admission is slow. */
export function QueueAdmissionStatus(props: {
  readonly messageId: string;
  readonly accepted: boolean;
}) {
  const status = useDelayedStatus(props.messageId, props.accepted ? null : "Queuing…", {
    showDelayMs: QUEUE_ADMISSION_STATUS_DELAY_MS,
  });
  return status === null ? null : (
    <span role="status" className="shrink-0 text-muted-foreground">
      {status}
    </span>
  );
}
