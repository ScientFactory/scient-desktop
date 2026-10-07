import {
  DndContext,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import { restrictToFirstScrollableAncestor, restrictToVerticalAxis } from "@dnd-kit/modifiers";
import {
  SortableContext,
  arrayMove,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import type { ScientThreadQueueItem } from "@t3tools/contracts";
import { composerCitationsToPlainText } from "@t3tools/shared/composerCitations";
import { CornerDownRight, GripVertical, Paperclip, Pencil, Trash2 } from "lucide-react";
import { useCallback } from "react";

import { useDelayedStatus } from "~/hooks/useDelayedStatus";
import { cn } from "~/lib/utils";

import { Button } from "../../components/ui/button";

/** Most admissions settle well before this, so their row never says "Queuing…". */
export const QUEUE_ADMISSION_STATUS_DELAY_MS = 700;

export interface PendingQueueMessage {
  readonly id: string;
  readonly text: string;
  readonly attachmentCount: number;
  /** Image attachments, which the queued row shows as thumbnails. */
  readonly imageCount?: number;
  readonly accepted: boolean;
}

export interface QueueStripItem {
  readonly queueItemId: string;
  readonly text: string;
  readonly attachments: ScientThreadQueueItem["attachments"];
  readonly sendRequested?: ScientThreadQueueItem["sendRequested"];
  readonly steerRequested?: ScientThreadQueueItem["steerRequested"];
}

function SortableQueueRow(props: {
  readonly id: string;
  readonly children: (bag: {
    readonly listeners: ReturnType<typeof useSortable>["listeners"];
    readonly setNodeRef: ReturnType<typeof useSortable>["setNodeRef"];
    readonly style: React.CSSProperties;
    readonly isDragging: boolean;
  }) => React.ReactNode;
}) {
  const { listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: props.id,
  });
  return props.children({
    listeners,
    setNodeRef,
    style: { transform: CSS.Translate.toString(transform), transition: transition ?? undefined },
    isDragging,
  });
}

/** Keeps a control's space so the row does not shift when the control appears. */
function GripPlaceholder() {
  return (
    <span aria-hidden="true" className="invisible shrink-0">
      <GripVertical className="size-3" />
    </span>
  );
}

/** A thumbnail's place before its image URL is known, sized like the thumbnail. */
function ThumbnailSlot() {
  return (
    <span
      aria-hidden="true"
      data-thumbnail-slot=""
      className="size-4 shrink-0 rounded border border-border/70 bg-muted"
    />
  );
}

function QueueRow<I extends QueueStripItem>(props: {
  readonly item: I;
  readonly canReorder: boolean;
  readonly gripSlot: boolean;
  readonly threadBusy: boolean;
  readonly dispatching: boolean;
  readonly canSend: boolean;
  readonly canSteer: boolean;
  readonly editing: boolean;
  readonly onCancelEdit?: () => void;
  readonly attachmentUrls?: ReadonlyMap<string, string>;
  readonly onMove: (item: I, direction: -1 | 1) => void;
  readonly onSend: (item: I) => void;
  readonly onSteer: (item: I) => void;
  readonly onEdit: (item: I) => void;
  readonly onDelete: (item: I) => void;
}) {
  return (
    <SortableQueueRow id={props.item.queueItemId}>
      {({ listeners, setNodeRef, style, isDragging }) => (
        <div
          ref={setNodeRef}
          style={style}
          className={cn(
            "flex min-w-0 items-center gap-1.5 border-t border-border/60 px-2.5 py-1.5 first:border-t-0",
            isDragging && "rounded-md bg-background shadow-sm",
            props.editing && "bg-accent text-accent-foreground",
          )}
          data-testid={`thread-queue-row-${props.item.queueItemId}`}
          aria-current={props.editing ? "true" : undefined}
        >
          {props.canReorder && (
            <button
              type="button"
              className="shrink-0 cursor-grab touch-none text-muted-foreground hover:text-foreground active:cursor-grabbing"
              aria-label="Reorder queued message"
              {...listeners}
              disabled={props.dispatching}
              onKeyDown={(event) => {
                if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
                event.preventDefault();
                props.onMove(props.item, event.key === "ArrowUp" ? -1 : 1);
              }}
            >
              <GripVertical className="size-3" aria-hidden="true" />
            </button>
          )}
          {!props.canReorder && props.gripSlot && <GripPlaceholder />}
          {props.item.attachments.length > 0 && (
            <span
              className="inline-flex shrink-0 items-center gap-1 text-[11px] text-muted-foreground"
              role="img"
              aria-label={`${props.item.attachments.length} ${props.item.attachments.length === 1 ? "attachment" : "attachments"}`}
            >
              <Paperclip className="size-3" aria-hidden="true" />
              {props.item.attachments.length}
            </span>
          )}
          {props.attachmentUrls !== undefined &&
            props.item.attachments
              .filter((attachment) => attachment.type === "image")
              .map((attachment, index) => {
                const url =
                  attachment.id === undefined
                    ? undefined
                    : props.attachmentUrls?.get(attachment.id);
                // Keep the thumbnail's place while its URL resolves, so the text does not move.
                return url ? (
                  <img
                    key={attachment.id ?? index}
                    src={url}
                    alt={attachment.name}
                    className="size-4 shrink-0 rounded border border-border/70 object-cover"
                  />
                ) : (
                  <ThumbnailSlot key={attachment.id ?? index} />
                );
              })}
          <span dir="auto" className="min-w-0 flex-1 truncate text-sm text-foreground">
            {props.editing ? <span className="sr-only">Editing queued message: </span> : null}
            {composerCitationsToPlainText(props.item.text)}
          </span>
          {props.threadBusy && props.canSteer && !props.editing && (
            <Button
              type="button"
              size="micro"
              variant="ghost-muted"
              disabled={props.dispatching}
              title="Send this message into the running turn"
              onClick={() => props.onSteer(props.item)}
            >
              <CornerDownRight className="size-3.5 opacity-60" aria-hidden="true" />
              <span className="text-xs leading-none">
                {props.dispatching ? "Sending" : "Steer"}
              </span>
            </Button>
          )}
          {props.canSend && (
            <Button
              type="button"
              size="micro"
              variant="ghost-muted"
              disabled={props.dispatching || props.item.sendRequested}
              onClick={() => props.onSend(props.item)}
            >
              Send
            </Button>
          )}
          {props.editing && props.onCancelEdit ? (
            <Button
              type="button"
              size="micro"
              variant="ghost-muted"
              onClick={props.onCancelEdit}
              aria-label="Cancel editing queued message"
            >
              Cancel
            </Button>
          ) : (
            <>
              <Button
                type="button"
                size="icon-micro"
                variant="ghost-muted"
                className="size-5"
                disabled={props.dispatching}
                title="Edit queued message"
                aria-label="Edit queued message"
                onClick={() => props.onEdit(props.item)}
              >
                <Pencil className="size-3.5 opacity-60" aria-hidden="true" />
              </Button>
              <Button
                type="button"
                size="icon-micro"
                variant="ghost-muted"
                className="size-5"
                disabled={props.dispatching}
                title="Delete queued message"
                aria-label="Delete queued message"
                onClick={() => props.onDelete(props.item)}
              >
                <Trash2 className="size-3.5 opacity-60" aria-hidden="true" />
              </Button>
            </>
          )}
        </div>
      )}
    </SortableQueueRow>
  );
}

/**
 * A follow-up the server has not listed yet. It takes the queued row's shape,
 * with inert placeholders for that row's controls, so nothing moves when the
 * real row replaces it. "Queuing…" appears only if admission is slow.
 */
function PendingQueueRow(props: {
  readonly message: PendingQueueMessage;
  readonly gripSlot: boolean;
  readonly steerSlot: boolean;
  readonly thumbnailSlots: boolean;
}) {
  const { message } = props;
  const status = useDelayedStatus(message.id, message.accepted ? null : "Queuing…", {
    showDelayMs: QUEUE_ADMISSION_STATUS_DELAY_MS,
  });
  return (
    <div
      className="flex min-w-0 items-center gap-1.5 border-t border-border/60 px-2.5 py-1.5 first:border-t-0"
      data-testid={`thread-queue-pending-${message.id}`}
    >
      {props.gripSlot && <GripPlaceholder />}
      {message.attachmentCount > 0 && (
        <span
          className="inline-flex shrink-0 items-center gap-1 text-[11px] text-muted-foreground"
          role="img"
          aria-label={`${message.attachmentCount} ${message.attachmentCount === 1 ? "attachment" : "attachments"}`}
        >
          <Paperclip className="size-3" aria-hidden="true" />
          {message.attachmentCount}
        </span>
      )}
      {props.thumbnailSlots &&
        Array.from({ length: message.imageCount ?? 0 }, (_, index) => (
          <ThumbnailSlot key={index} />
        ))}
      <span dir="auto" className="min-w-0 flex-1 truncate text-sm text-foreground">
        {composerCitationsToPlainText(message.text)}
      </span>
      {status !== null && (
        <span role="status" className="shrink-0 text-xs text-muted-foreground">
          {status}
        </span>
      )}
      {props.steerSlot && (
        <Button
          render={<span aria-hidden="true" />}
          size="micro"
          variant="ghost-muted"
          className="invisible"
        >
          <CornerDownRight className="size-3.5" />
          <span className="text-xs leading-none">Steer</span>
        </Button>
      )}
      <Button
        render={<span aria-hidden="true" />}
        size="icon-micro"
        variant="ghost-muted"
        className="invisible size-5"
      >
        <Pencil className="size-3.5" />
      </Button>
      <Button
        render={<span aria-hidden="true" />}
        size="icon-micro"
        variant="ghost-muted"
        className="invisible size-5"
      >
        <Trash2 className="size-3.5" />
      </Button>
    </div>
  );
}

/** A compact composer extension for messages waiting behind the active turn. */
export function ThreadQueueStrip<I extends QueueStripItem = ScientThreadQueueItem>(props: {
  readonly items: ReadonlyArray<I>;
  readonly pendingMessages?: ReadonlyArray<PendingQueueMessage>;
  readonly canReorder?: boolean;
  readonly canSteer?: boolean;
  readonly editingItemId?: string | null;
  readonly onCancelEdit?: () => void;
  readonly attachmentUrls?: ReadonlyMap<string, string>;
  readonly error: string | null;
  readonly threadBusy: boolean;
  readonly supportsExplicitSend: boolean;
  readonly awaitingCompletion: boolean;
  /**
   * Whether the server accepts Send on this row. Send on any row starts that
   * message and resumes the rest of the queue after it. Absent means every row.
   */
  readonly canSendItem?: (item: I) => boolean;
  readonly paused: boolean;
  readonly dispatchingItemId: string | null;
  readonly onSend: (item: I) => void;
  readonly onSteer: (item: I) => void;
  readonly retryable: boolean;
  readonly onRetry?: () => void;
  readonly onEdit: (item: I) => void;
  readonly onDelete: (item: I) => void;
  readonly onReorder: (queueItemIds: ReadonlyArray<I["queueItemId"]>) => void;
}) {
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }));
  const { canReorder, dispatchingItemId, items, onReorder } = props;
  const handleDragEnd = useCallback(
    (event: DragEndEvent) => {
      if (canReorder === false || dispatchingItemId !== null) return;
      const activeId = String(event.active.id) as I["queueItemId"];
      const overId = event.over === null ? null : (String(event.over.id) as I["queueItemId"]);
      if (overId === null || activeId === overId) return;
      const ids = items.map((item) => item.queueItemId);
      const fromIndex = ids.indexOf(activeId);
      const toIndex = ids.indexOf(overId);
      if (fromIndex === -1 || toIndex === -1) return;
      onReorder(arrayMove([...ids], fromIndex, toIndex));
    },
    [items, onReorder, canReorder, dispatchingItemId],
  );

  const pendingMessages = props.pendingMessages ?? [];
  // Once a pending follow-up becomes a queued row, every row gets a grip; reserve it now.
  const gripSlot = props.items.length + pendingMessages.length > 1 && props.canReorder !== false;
  // Native extraction removes the queued run while its recovered draft remains editable.
  const detachedEdit =
    props.editingItemId != null &&
    props.onCancelEdit !== undefined &&
    !props.items.some((item) => item.queueItemId === props.editingItemId);
  if (
    props.items.length === 0 &&
    pendingMessages.length === 0 &&
    props.error === null &&
    !detachedEdit
  )
    return null;

  return (
    <section
      className="mx-4 -mb-px overflow-hidden rounded-t-xl border border-b-0 border-border/70 bg-background"
      aria-label="Queued messages"
      data-testid="thread-queue-strip"
    >
      {detachedEdit ? (
        <div className="flex items-center gap-2 border-b border-border/60 px-2.5 py-1.5 text-xs text-muted-foreground">
          <span className="flex-1">Editing queued message</span>
          <Button
            type="button"
            size="micro"
            variant="ghost-muted"
            onClick={props.onCancelEdit}
            aria-label="Cancel editing queued message"
          >
            Cancel
          </Button>
        </div>
      ) : null}
      {props.error !== null && (
        <div
          className="flex items-center gap-2 border-b border-destructive/20 bg-destructive/5 px-3 py-1.5 text-xs text-destructive"
          role="alert"
        >
          <span className="min-w-0 flex-1 truncate">{props.error}</span>
          {!props.threadBusy && props.retryable && props.onRetry && (
            <Button
              type="button"
              size="compact"
              variant="outline"
              disabled={props.dispatchingItemId !== null}
              onClick={() => props.onRetry?.()}
            >
              Retry
            </Button>
          )}
        </div>
      )}
      {(props.items.length > 0 || pendingMessages.length > 0) && (
        <div className="max-h-36 overflow-y-auto">
          {props.items.length > 0 && (
            <DndContext
              sensors={sensors}
              collisionDetection={closestCenter}
              modifiers={[restrictToVerticalAxis, restrictToFirstScrollableAncestor]}
              onDragEnd={handleDragEnd}
            >
              <SortableContext
                items={props.items.map((item) => item.queueItemId)}
                strategy={verticalListSortingStrategy}
              >
                {props.items.map((item) => (
                  <QueueRow
                    key={item.queueItemId}
                    item={item}
                    canReorder={props.items.length > 1 && props.canReorder !== false}
                    gripSlot={gripSlot}
                    canSteer={props.canSteer !== false}
                    editing={props.editingItemId === item.queueItemId}
                    {...(props.onCancelEdit === undefined
                      ? {}
                      : { onCancelEdit: props.onCancelEdit })}
                    {...(props.attachmentUrls === undefined
                      ? {}
                      : { attachmentUrls: props.attachmentUrls })}
                    onMove={(selected, direction) => {
                      const ids = props.items.map((row) => row.queueItemId);
                      const from = ids.indexOf(selected.queueItemId);
                      const to = from + direction;
                      if (
                        from < 0 ||
                        to < 0 ||
                        to >= ids.length ||
                        props.dispatchingItemId !== null
                      )
                        return;
                      props.onReorder(arrayMove(ids, from, to));
                    }}
                    threadBusy={props.threadBusy}
                    canSend={
                      props.supportsExplicitSend &&
                      !props.threadBusy &&
                      props.awaitingCompletion &&
                      !props.paused &&
                      !props.items.some((entry) => entry.steerRequested) &&
                      props.canSendItem?.(item) !== false
                    }
                    dispatching={props.dispatchingItemId === item.queueItemId}
                    onSend={props.onSend}
                    onSteer={props.onSteer}
                    onEdit={props.onEdit}
                    onDelete={props.onDelete}
                  />
                ))}
              </SortableContext>
            </DndContext>
          )}
          {pendingMessages.map((message) => (
            <PendingQueueRow
              key={message.id}
              message={message}
              gripSlot={gripSlot}
              steerSlot={props.threadBusy && props.canSteer !== false}
              thumbnailSlots={props.attachmentUrls !== undefined}
            />
          ))}
        </div>
      )}
    </section>
  );
}
