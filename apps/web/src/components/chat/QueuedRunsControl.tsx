import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { deriveThreadQueueWorkflowState } from "@t3tools/client-runtime/state/thread-workflows";
import type {
  ChatAttachment as ContractChatAttachment,
  EnvironmentId,
  MessageId,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import { CornerUpRightIcon, GripVerticalIcon, ListOrderedIcon, PencilIcon } from "lucide-react";
import { useId, useImperativeHandle, useRef, useState, type Ref } from "react";

import { useAssetUrls } from "../../assets/assetUrls";
import { threadEnvironment } from "../../state/threads";
import { useThreadProjection } from "../../state/entities";
import { useAtomCommand } from "../../state/use-atom-command";
import { isImageAttachment, type ChatMessage } from "../../types";
import { cn } from "~/lib/utils";
import { ComposerBanner } from "./ComposerBanner";
import { Button } from "../ui/button";
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
  const [expanded, setExpanded] = useState(true);
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
        busyRunId !== null
      ) {
        return false;
      }
      if (!repeat) {
        setExpanded(true);
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

  // SCIENT-FORK:START queue-scient-parts
  const scientNotices = (
    <ScientQueueNotices
      parts={scient}
      busy={busyRunId !== null}
      onCancelEdit={props.onCancelEdit}
    />
  );
  if (items.length === 0) {
    return scient.notice === null && !scient.detachedEdit ? null : (
      <ComposerBanner.Attachment>
        <ComposerBanner.Root
          role="region"
          aria-label="Queued messages"
          data-chat-composer-collapsed-controls="true"
          className="relative z-0"
        >
          {scientNotices}
        </ComposerBanner.Root>
      </ComposerBanner.Attachment>
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

  return (
    <ComposerBanner.Attachment>
      <ComposerBanner.Root
        role="region"
        aria-label={`${items.length} queued message${items.length === 1 ? "" : "s"}`}
        aria-live="polite"
        data-chat-composer-collapsed-controls="true"
        className="relative z-0"
      >
        {/* SCIENT-FORK:START queue-scient-parts */}
        {scientNotices}
        {/* SCIENT-FORK:END queue-scient-parts */}
        <ComposerBanner.Row
          render={<button type="button" />}
          aria-label={expanded ? "Collapse queued messages" : "Expand queued messages"}
          aria-expanded={expanded}
          aria-controls={queueListId}
          onPointerDown={(event) => event.preventDefault()}
          onClick={() => setExpanded((value) => !value)}
        >
          <ComposerBanner.Icon>
            <ListOrderedIcon />
          </ComposerBanner.Icon>
          <ComposerBanner.Content className="text-muted-foreground">Queued</ComposerBanner.Content>
          <ComposerBanner.Actions>
            <ComposerBanner.Count>{items.length}</ComposerBanner.Count>
            <ComposerBanner.ToggleIcon expanded={expanded} />
          </ComposerBanner.Actions>
        </ComposerBanner.Row>
        <ComposerBanner.Scroll className={cn("max-h-32", !expanded && "hidden")}>
          <ComposerBanner.Children render={<ol />} id={queueListId}>
            {items.map((item) => {
              // SCIENT-FORK:START queue-scient-preview
              const previewText = queuePreviewText(item.text, item.thumbnails.length > 0);
              // SCIENT-FORK:END queue-scient-preview
              const rowRunId = item.runId;
              const rowServerIndex = item.serverIndex;
              const isEditing = rowRunId !== null && rowRunId === props.editingRunId;
              const rowDraggable =
                rowRunId !== null && rowServerIndex !== null && canReorder && busyRunId === null;
              return (
                <ComposerBanner.Row
                  render={<li />}
                  key={item.key}
                  aria-current={isEditing ? "true" : undefined}
                  className={cn(
                    "relative rounded-sm",
                    isEditing && "bg-accent text-accent-foreground",
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
                      className="pointer-events-none absolute inset-x-0 top-0 h-0.5 rounded bg-primary/70"
                    />
                  ) : null}
                  {item.serverIndex === queued.length - 1 &&
                  dragState?.insertIndex === queued.length ? (
                    <span
                      aria-hidden
                      className="pointer-events-none absolute inset-x-0 bottom-0 h-0.5 rounded bg-primary/70"
                    />
                  ) : null}
                  <ComposerBanner.Icon aria-hidden={false}>
                    {canReorder && rowRunId !== null && rowServerIndex !== null ? (
                      <Button
                        size="icon-xs"
                        variant="ghost-muted"
                        aria-label="Reorder queued message (drag, or press the arrow keys)"
                        className="cursor-grab active:cursor-grabbing disabled:cursor-default"
                        disabled={busyRunId !== null}
                        onPointerDown={() => {
                          dragArmedRunIdRef.current = rowRunId;
                        }}
                        onKeyDown={(event) => {
                          if (busyRunId !== null) return;
                          if (event.key === "ArrowUp" && rowServerIndex > 0) {
                            event.preventDefault();
                            void move(rowRunId, queued[rowServerIndex - 1]?.run.id ?? null);
                          }
                          if (event.key === "ArrowDown" && rowServerIndex < queued.length - 1) {
                            event.preventDefault();
                            void move(rowRunId, queued[rowServerIndex + 2]?.run.id ?? null);
                          }
                        }}
                      >
                        <GripVerticalIcon />
                      </Button>
                    ) : null}
                  </ComposerBanner.Icon>
                  <ComposerBanner.Content className="text-foreground/80">
                    {isEditing ? <span className="sr-only">Editing queued message: </span> : null}
                    {item.thumbnails.length > 0 ? (
                      <span className="flex shrink-0 items-center gap-0.5">
                        {item.thumbnails.map((thumbnail) => (
                          <span
                            key={thumbnail.key}
                            className="size-4 overflow-hidden rounded border border-border/70 bg-background"
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
                    {item.guestName === undefined ? null : (
                      <span className="shrink-0 text-guest-foreground">{item.guestName}</span>
                    )}
                    <Tooltip>
                      <TooltipTrigger render={<span className="min-w-0 flex-1 truncate" />}>
                        {previewText}
                      </TooltipTrigger>
                      <TooltipPopup side="top" className="max-w-96 break-words">
                        {previewText}
                      </TooltipPopup>
                    </Tooltip>
                    {/* SCIENT-FORK:START queue-scient-parts — "Queuing…" only when admission is slow. */}
                    {item.pending ? (
                      <QueueAdmissionStatus
                        messageId={item.key}
                        accepted={"accepted" in item && item.accepted}
                      />
                    ) : null}
                    {/* SCIENT-FORK:END queue-scient-parts */}
                  </ComposerBanner.Content>
                  <ComposerBanner.Actions>
                    {isEditing ? (
                      <Button
                        size="xs"
                        variant="ghost"
                        aria-label="Cancel editing queued message"
                        onClick={props.onCancelEdit}
                      >
                        Cancel
                      </Button>
                    ) : (
                      <>
                        <Tooltip>
                          <TooltipTrigger
                            render={
                              <Button
                                size="icon-xs"
                                variant="ghost-muted"
                                aria-label="Edit queued message"
                                disabled={
                                  item.runId === null || !item.editable || busyRunId !== null
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
                              />
                            }
                          >
                            <PencilIcon />
                          </TooltipTrigger>
                          <TooltipPopup>
                            {`Edit in the composer${item.serverIndex === queued.length - 1 && props.editShortcutLabel ? ` (${props.editShortcutLabel})` : ""}`}
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
                              <ComposerBanner.Dismiss
                                aria-label="Remove queued message"
                                disabled={item.runId === null || busyRunId !== null}
                                onClick={() => {
                                  if (item.runId !== null) void remove(item.runId);
                                }}
                              />
                            }
                          />
                          <TooltipPopup>Remove from queue</TooltipPopup>
                        </Tooltip>
                      </>
                    )}
                  </ComposerBanner.Actions>
                </ComposerBanner.Row>
              );
            })}
          </ComposerBanner.Children>
        </ComposerBanner.Scroll>
      </ComposerBanner.Root>
    </ComposerBanner.Attachment>
  );
}
