import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { deriveThreadQueueWorkflowState } from "@t3tools/client-runtime/state/thread-workflows";
import type {
  ChatAttachment as ContractChatAttachment,
  EnvironmentId,
  MessageId,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import {
  ChevronDownIcon,
  CornerUpRightIcon,
  GripVerticalIcon,
  ListOrderedIcon,
  PencilIcon,
  XIcon,
} from "lucide-react";
import { useId, useImperativeHandle, useRef, useState, type Ref } from "react";

import { useAssetUrls } from "../../assets/assetUrls";
import { threadEnvironment } from "../../state/threads";
import { useThreadProjection } from "../../state/entities";
import { useAtomCommand } from "../../state/use-atom-command";
import { isImageAttachment, type ChatMessage } from "../../types";
import { cn } from "~/lib/utils";
import { Button, InlineButton } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
// SCIENT-FORK:START queue-scient-parts
import { queuePreviewText } from "~/scient/threadQueue/queuePreviewText";
import {
  QueueAdmissionStatus,
  ScientQueueNotices,
  useScientQueueParts,
} from "../../scient/threadQueue/useScientQueueParts";
// SCIENT-FORK:END queue-scient-parts

export interface EditQueuedRunRequest {
  readonly runId: RunId;
  readonly messageId: MessageId;
  readonly text: string;
  readonly attachments: ReadonlyArray<ContractChatAttachment>;
}

interface QueuedRowThumbnail {
  readonly key: string;
  readonly name: string;
  readonly url: string | null;
}

const QUEUED_RUN_DRAG_TYPE = "application/x-t3code-queued-run";
// A longer queue shows its first messages and a button that shows the rest.
const QUEUE_VISIBLE_ROWS = 3;

export interface QueuedRunsControlHandle {
  steerNext: (repeat: boolean) => boolean;
  editLatest: (repeat: boolean) => boolean;
}

type ThreadQueueProjection = Parameters<typeof deriveThreadQueueWorkflowState>[0];

function queuedImageResources(projection: ThreadQueueProjection | undefined) {
  if (!projection) return [];
  return deriveThreadQueueWorkflowState(projection).queuedRuns.flatMap(({ attachments }) =>
    attachments.flatMap((attachment) =>
      attachment.type === "image"
        ? [{ _tag: "attachment" as const, attachmentId: attachment.id }]
        : [],
    ),
  );
}

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
      // SCIENT-FORK:START queue-scient-parts — an admission preview and its acceptance.
      readonly queueAdmission?: { readonly accepted: boolean };
      // SCIENT-FORK:END queue-scient-parts
    }
  >;
  readonly editingRunId: RunId | null;
  /** Set while something else holds the composer, such as an open question. */
  readonly editBlockedReason: string | null;
  readonly onEditQueuedRun: (request: EditQueuedRunRequest) => void;
  readonly onCancelEdit: () => void;
  // SCIENT-FORK:START queue-scient-parts
  readonly error?: string | null;
  // SCIENT-FORK:END queue-scient-parts
}) {
  const projection = useThreadProjection(
    scopeThreadRef(props.environmentId, props.threadId),
  )?.projection;
  const reorder = useAtomCommand(threadEnvironment.reorderQueuedRun);
  const promote = useAtomCommand(threadEnvironment.promoteQueuedRun);
  const resume = useAtomCommand(threadEnvironment.resumeThreadQueue);
  const cancel = useAtomCommand(threadEnvironment.cancelQueuedRun);
  const [showAll, setShowAll] = useState(false);
  const queueListId = useId();
  const [busyRunId, setBusyRunId] = useState<RunId | null>(null);
  const [dragState, setDragState] = useState<{
    readonly runId: RunId;
    readonly insertIndex: number | null;
  } | null>(null);
  // Arm from the grip to prevent accidental text drags from reordering queued runs.
  const dragArmedRunIdRef = useRef<RunId | null>(null);
  // Run-only acknowledgements can resurrect pending rows after cancellation or startup.
  const acknowledgedMessageIds = new Set((projection?.messages ?? []).map((message) => message.id));
  const queuedImageAttachmentResources = queuedImageResources(projection);
  const queuedImageAttachmentUrls = useAssetUrls(
    props.environmentId,
    queuedImageAttachmentResources,
  );
  const workflow = projection ? deriveThreadQueueWorkflowState(projection) : null;
  const queued = workflow?.queuedRuns ?? [];
  const activeRun = workflow?.activeRun ?? null;
  const canReorder = workflow?.canReorder === true;
  const canSend = workflow?.canSendNow === true || workflow?.canPromoteToSteer === true;
  // SCIENT-FORK:START queue-scient-parts
  const scient = useScientQueueParts({
    environmentId: props.environmentId,
    threadId: props.threadId,
    projection,
    workflow,
    editingRunId: props.editingRunId,
    error: props.error,
    setBusyRunId,
  });
  // SCIENT-FORK:END queue-scient-parts
  const queuedImageUrlById = new Map(
    queuedImageAttachmentUrls.flatMap((url, index) => {
      const resource = queuedImageAttachmentResources[index];
      return url && resource ? [[resource.attachmentId, url] as const] : [];
    }),
  );
  const optimisticQueued = props.optimisticMessages.filter(
    (message) =>
      // SCIENT-FORK:START queue-scient-parts — a send predicted to queue previews here too.
      (message.inputIntent === "queued_turn" || message.queueAdmission !== undefined) &&
      // SCIENT-FORK:END queue-scient-parts
      !acknowledgedMessageIds.has(message.id),
  );
  const items = [
    ...queued.map(({ run, text, attachments, context }, serverIndex) => ({
      key: run.id,
      runId: run.id,
      messageId: run.userMessageId,
      serverIndex,
      text,
      // A guest's message keeps the guest's words; the owner can cancel it, not rewrite it.
      editable: context?.guest === undefined,
      guestName: context?.guest?.name,
      attachments,
      thumbnails: attachments
        .filter((attachment) => attachment.type === "image")
        .map<QueuedRowThumbnail>((attachment) => ({
          key: attachment.id,
          name: attachment.name,
          url: queuedImageUrlById.get(attachment.id) ?? null,
        })),
      pending: false,
    })),
    ...optimisticQueued.map((message) => ({
      key: message.id,
      runId: null,
      messageId: null,
      serverIndex: null,
      text: message.text,
      editable: true,
      guestName: undefined,
      attachments: [] as ReadonlyArray<ContractChatAttachment>,
      thumbnails: (message.attachments ?? [])
        .filter(isImageAttachment)
        .map<QueuedRowThumbnail>((attachment) => ({
          key: attachment.id,
          name: attachment.name,
          url: attachment.previewUrl ?? null,
        })),
      pending: true,
      // SCIENT-FORK:START queue-scient-parts
      accepted: message.queueAdmission?.accepted === true,
      // SCIENT-FORK:END queue-scient-parts
    })),
  ];

  // SCIENT-FORK:START queue-scient-parts — queue commands run one at a time and report failures.
  const move = (runId: RunId, beforeRunId: RunId | null) =>
    scient.perform(runId, () =>
      reorder({
        environmentId: props.environmentId,
        input: { threadId: props.threadId, runId, beforeRunId },
      }),
    );
  // SCIENT-FORK:END queue-scient-parts

  const completeDrag = (runId: RunId, insertIndex: number | null) => {
    setDragState(null);
    dragArmedRunIdRef.current = null;
    if (insertIndex === null || busyRunId !== null) return;
    const draggedIndex = queued.findIndex(({ run }) => run.id === runId);
    if (draggedIndex === -1) return;
    if (insertIndex === draggedIndex || insertIndex === draggedIndex + 1) return;
    void move(runId, queued[insertIndex]?.run.id ?? null);
  };

  // SCIENT-FORK:START queue-scient-parts
  const sendQueuedMessage = async (queuedRunId: RunId) => {
    if (!canSend || scient.sendRefused(queuedRunId)) return;
    if (workflow?.canSendNow) {
      await scient.perform(queuedRunId, () =>
        resume({
          environmentId: props.environmentId,
          input: { threadId: props.threadId, runId: queuedRunId },
        }),
      );
    } else if (activeRun !== null) {
      await scient.perform(queuedRunId, () =>
        promote({
          environmentId: props.environmentId,
          input: { threadId: props.threadId, queuedRunId, targetRunId: activeRun.id },
        }),
      );
    }
  };
  // SCIENT-FORK:END queue-scient-parts

  useImperativeHandle(ref, () => ({
    steerNext(repeat) {
      const next = queued[0];
      // SCIENT-FORK:START queue-scient-parts
      if (!next || !canSend || scient.sendRefused(next.run.id)) return false;
      if (!repeat && !scient.isBusy()) void sendQueuedMessage(next.run.id);
      // SCIENT-FORK:END queue-scient-parts
      return true;
    },
    // Leave the key to caret navigation while editing.
    editLatest(repeat) {
      const latest = queued.at(-1);
      if (
        !latest ||
        latest.context?.guest !== undefined ||
        props.editingRunId !== null ||
        props.editBlockedReason !== null ||
        busyRunId !== null
      ) {
        return false;
      }
      if (!repeat) {
        setShowAll(true);
        props.onEditQueuedRun({
          runId: latest.run.id,
          messageId: latest.run.userMessageId,
          text: latest.text,
          attachments: latest.attachments,
        });
      }
      return true;
    },
  }));

  // SCIENT-FORK:START queue-scient-parts — notices and the detached-edit row lead the queue; the
  // variable sizes their ComposerBanner rows outside a composer banner.
  const scientNotices =
    scient.notice === null && !scient.detachedEdit ? null : (
      <div className="flex flex-col gap-1 text-xs [--composer-banner-icon-column:--spacing(6)]">
        <ScientQueueNotices
          parts={scient}
          busy={busyRunId !== null}
          onCancelEdit={props.onCancelEdit}
        />
      </div>
    );
  if (items.length === 0) {
    return scientNotices === null ? null : (
      <section
        aria-label="Queued messages"
        data-thread-queue="true"
        className="mx-auto flex w-full max-w-(--chat-content-max-width) flex-col gap-2 pb-4"
      >
        {scientNotices}
      </section>
    );
  }

  const remove = (runId: RunId) =>
    scient.perform(runId, () =>
      cancel({
        environmentId: props.environmentId,
        input: { threadId: props.threadId, runId },
      }),
    );
  // SCIENT-FORK:END queue-scient-parts

  const collapsible = items.length > QUEUE_VISIBLE_ROWS;
  const visibleItems = collapsible && !showAll ? items.slice(0, QUEUE_VISIBLE_ROWS - 1) : items;

  return (
    <section
      aria-label={`Up next: ${items.length} queued message${items.length === 1 ? "" : "s"}`}
      data-thread-queue="true"
      className="mx-auto flex w-full max-w-(--chat-content-max-width) flex-col gap-2 pb-4"
    >
      <h3 className="flex min-h-5 items-center gap-1.5 px-1 text-xs font-normal text-muted-foreground [&_svg]:size-3.5">
        <ListOrderedIcon aria-hidden />
        Up next
        <span className="tabular-nums" aria-live="polite">
          · {items.length} queued
        </span>
      </h3>
      {/* SCIENT-FORK:START queue-scient-parts */}
      {scientNotices}
      {/* SCIENT-FORK:END queue-scient-parts */}
      <ol className="flex flex-col items-end gap-3" id={queueListId}>
        {visibleItems.map((item, position) => {
          // SCIENT-FORK:START queue-scient-preview
          const previewText = queuePreviewText(item.text, item.thumbnails.length > 0);
          // SCIENT-FORK:END queue-scient-preview
          const rowRunId = item.runId;
          const rowServerIndex = item.serverIndex;
          const isEditing = rowRunId !== null && rowRunId === props.editingRunId;
          const rowDraggable =
            rowRunId !== null && rowServerIndex !== null && canReorder && busyRunId === null;
          return (
            <li
              key={item.key}
              aria-label={`Queued message ${position + 1} of ${items.length}, not sent`}
              aria-posinset={position + 1}
              aria-setsize={items.length}
              aria-current={isEditing ? "true" : undefined}
              className={cn(
                "group/queued relative flex w-full flex-col items-end gap-1 transition-opacity duration-150 ease-out starting:opacity-0 motion-reduce:transition-none",
                dragState !== null && dragState.runId === item.runId && "opacity-50",
              )}
              draggable={rowDraggable}
              onDragStart={(event) => {
                if (item.runId === null || dragArmedRunIdRef.current !== item.runId) {
                  event.preventDefault();
                  return;
                }
                event.dataTransfer.setData(QUEUED_RUN_DRAG_TYPE, item.runId);
                event.dataTransfer.effectAllowed = "move";
                setDragState({ runId: item.runId, insertIndex: null });
              }}
              onDragEnd={() => {
                dragArmedRunIdRef.current = null;
                setDragState(null);
              }}
              onDragOver={(event) => {
                if (dragState === null || item.serverIndex === null) return;
                event.preventDefault();
                event.dataTransfer.dropEffect = "move";
                const rect = event.currentTarget.getBoundingClientRect();
                const insertIndex =
                  event.clientY < rect.top + rect.height / 2
                    ? item.serverIndex
                    : item.serverIndex + 1;
                if (dragState.insertIndex !== insertIndex) {
                  setDragState({ runId: dragState.runId, insertIndex });
                }
              }}
              onDrop={(event) => {
                if (dragState === null) return;
                event.preventDefault();
                completeDrag(dragState.runId, dragState.insertIndex);
              }}
            >
              {item.serverIndex !== null && dragState?.insertIndex === item.serverIndex ? (
                <span
                  aria-hidden
                  className="pointer-events-none absolute inset-x-0 -top-1.5 h-0.5 rounded bg-primary/70"
                />
              ) : null}
              {item.serverIndex === queued.length - 1 &&
              dragState?.insertIndex === queued.length ? (
                <span
                  aria-hidden
                  className="pointer-events-none absolute inset-x-0 -bottom-1.5 h-0.5 rounded bg-primary/70"
                />
              ) : null}
              {/* Dashed and unfilled: a turn that has not been sent yet. */}
              <div
                className={cn(
                  "flex min-w-0 max-w-[80%] flex-col gap-2 rounded-2xl border border-dashed px-3 py-2 text-sm",
                  isEditing
                    ? "border-primary/60 text-foreground"
                    : "border-muted-foreground/40 text-muted-foreground",
                )}
              >
                {item.thumbnails.length > 0 ? (
                  <span className="flex flex-wrap items-center gap-1">
                    {item.thumbnails.map((thumbnail) => (
                      <span
                        key={thumbnail.key}
                        className="size-8 overflow-hidden rounded-md border border-border/70 bg-background"
                      >
                        {thumbnail.url ? (
                          <img
                            src={thumbnail.url}
                            alt={thumbnail.name}
                            className="size-full object-cover"
                          />
                        ) : (
                          <span
                            aria-label={thumbnail.name}
                            className="block size-full bg-muted/60"
                          />
                        )}
                      </span>
                    ))}
                  </span>
                ) : null}
                {/* In full, like a sent turn: a queued message is read before it is sent. */}
                {previewText ? (
                  <p className="whitespace-pre-wrap wrap-anywhere">
                    {item.guestName === undefined ? null : (
                      <span className="text-guest-foreground">{item.guestName} </span>
                    )}
                    {previewText}
                  </p>
                ) : null}
              </div>
              <div className="flex items-center gap-0.5 pe-1 text-xs text-muted-foreground">
                {items.length > 1 && canReorder && rowRunId !== null && rowServerIndex !== null ? (
                  <Button
                    size="icon-xs"
                    variant="ghost-muted"
                    aria-label={`Reorder queued message ${position + 1} of ${items.length} (drag, or press the arrow keys)`}
                    className="group/grip cursor-grab active:cursor-grabbing"
                    // Not `disabled`: that drops keyboard focus mid-move and breaks repeated arrow presses.
                    aria-disabled={busyRunId !== null || undefined}
                    onPointerDown={() => {
                      if (busyRunId === null) dragArmedRunIdRef.current = rowRunId;
                    }}
                    onKeyDown={(event) => {
                      if (busyRunId !== null) return;
                      if (event.key === "ArrowUp" && rowServerIndex > 0) {
                        event.preventDefault();
                        void move(rowRunId, queued[rowServerIndex - 1]?.run.id ?? null);
                      }
                      if (event.key === "ArrowDown" && rowServerIndex < queued.length - 1) {
                        event.preventDefault();
                        // Moving into the collapsed rows would unmount the focused grip.
                        if (rowServerIndex + 1 >= visibleItems.length) setShowAll(true);
                        void move(rowRunId, queued[rowServerIndex + 2]?.run.id ?? null);
                      }
                    }}
                  >
                    <span className="text-xs font-medium tabular-nums group-hover/queued:hidden group-focus-visible/grip:hidden">
                      {position + 1}
                    </span>
                    <GripVerticalIcon className="hidden group-hover/queued:block group-focus-visible/grip:block" />
                  </Button>
                ) : items.length > 1 ? (
                  <span className="px-1.5 font-medium tabular-nums">{position + 1}</span>
                ) : null}
                {/* SCIENT-FORK:START queue-scient-parts — "Queuing…" only when admission is slow. */}
                {item.pending ? (
                  <span className="px-1 empty:hidden">
                    <QueueAdmissionStatus
                      messageId={item.key}
                      accepted={"accepted" in item && item.accepted}
                    />
                  </span>
                ) : null}
                {/* SCIENT-FORK:END queue-scient-parts */}
                {isEditing ? (
                  <>
                    <span className="px-1 text-foreground">Editing in the composer</span>
                    <Button
                      size="xs"
                      variant="ghost"
                      aria-label="Cancel editing queued message"
                      onClick={props.onCancelEdit}
                    >
                      Cancel
                    </Button>
                  </>
                ) : (
                  <>
                    <Tooltip>
                      {/* The span keeps the tooltip, and its reason, on a disabled button. */}
                      <TooltipTrigger render={<span className="flex shrink-0" />}>
                        <Button
                          size="icon-xs"
                          variant="ghost-muted"
                          aria-label="Edit queued message"
                          disabled={
                            item.runId === null ||
                            !item.editable ||
                            busyRunId !== null ||
                            props.editBlockedReason !== null
                          }
                          onClick={() => {
                            if (item.runId !== null && item.messageId !== null) {
                              props.onEditQueuedRun({
                                runId: item.runId,
                                messageId: item.messageId,
                                text: item.text,
                                attachments: item.attachments,
                              });
                            }
                          }}
                        >
                          <PencilIcon />
                        </Button>
                      </TooltipTrigger>
                      <TooltipPopup>
                        {props.editBlockedReason ??
                          `Edit in the composer${item.serverIndex === queued.length - 1 && props.editShortcutLabel ? ` (${props.editShortcutLabel})` : ""}`}
                      </TooltipPopup>
                    </Tooltip>
                    <Tooltip>
                      <TooltipTrigger
                        render={
                          // SCIENT-FORK:START queue-scient-parts — a refused held Send stays hidden.
                          <span
                            className="flex shrink-0"
                            hidden={item.runId !== null && scient.sendRefused(item.runId)}
                          />
                          // SCIENT-FORK:END queue-scient-parts
                        }
                      >
                        <Button
                          size="xs"
                          variant="ghost-muted"
                          disabled={item.runId === null || busyRunId !== null || !canSend}
                          onClick={() => {
                            if (item.runId !== null) {
                              void sendQueuedMessage(item.runId);
                            }
                          }}
                        >
                          <CornerUpRightIcon />
                          {workflow?.canSendNow ? "Send now" : "Steer"}
                        </Button>
                      </TooltipTrigger>
                      <TooltipPopup>
                        {`${workflow?.canSendNow ? "Start a turn with this message" : "Send as a steer instead"}${item.serverIndex === 0 && props.steerShortcutLabel ? ` (${props.steerShortcutLabel})` : ""}`}
                      </TooltipPopup>
                    </Tooltip>
                    <Tooltip>
                      <TooltipTrigger
                        render={
                          <Button
                            size="icon-xs"
                            variant="ghost-muted"
                            aria-label="Remove queued message"
                            disabled={item.runId === null || busyRunId !== null}
                            onClick={() => {
                              if (item.runId !== null) void remove(item.runId);
                            }}
                          />
                        }
                      >
                        <XIcon />
                      </TooltipTrigger>
                      <TooltipPopup>Remove from queue</TooltipPopup>
                    </Tooltip>
                  </>
                )}
              </div>
            </li>
          );
        })}
      </ol>
      {collapsible ? (
        <div className="self-end pe-1 text-xs pointer-coarse:[&_[data-slot=inline-button]]:relative pointer-coarse:[&_[data-slot=inline-button]]:after:absolute pointer-coarse:[&_[data-slot=inline-button]]:after:-inset-x-1.5 pointer-coarse:[&_[data-slot=inline-button]]:after:-inset-y-3.5">
          <InlineButton
            tone="muted"
            aria-expanded={showAll}
            aria-controls={queueListId}
            // Keep the composer focused; keyboard activation still works.
            onPointerDown={(event) => event.preventDefault()}
            onClick={() => setShowAll((value) => !value)}
          >
            {showAll ? "Show fewer" : `Show all ${items.length} queued`}
            <ChevronDownIcon
              aria-hidden
              className={cn(
                "size-3.5 transition-transform duration-150 motion-reduce:transition-none",
                showAll && "rotate-180",
              )}
            />
          </InlineButton>
        </div>
      ) : null}
    </section>
  );
}
