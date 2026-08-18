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
import type { ScientThreadQueueItem, ScientThreadQueueItemId } from "@t3tools/contracts";
import { GripVertical, ListOrdered, Paperclip, Pencil, Send, Trash2, X, Zap } from "lucide-react";
import { useCallback } from "react";

import { cn } from "~/lib/utils";

import { Button } from "../../components/ui/button";

/**
 * Queued-message panel rendered above the composer. Rows can be dragged to
 * reorder, explicitly edited in the composer, dispatched (steer while busy,
 * send while idle), or deleted. Scient-owned; see
 * `docs/internals/scient-thread-queue.md`.
 */

function SortableQueueRow(props: {
  readonly id: ScientThreadQueueItemId;
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
    style: {
      transform: CSS.Translate.toString(transform),
      transition: transition ?? undefined,
    },
    isDragging,
  });
}

function QueueRow(props: {
  readonly item: ScientThreadQueueItem;
  readonly position: number;
  readonly threadBusy: boolean;
  readonly dispatching: boolean;
  readonly editing: boolean;
  readonly onSend: (item: ScientThreadQueueItem) => void;
  readonly onEdit: (item: ScientThreadQueueItem) => void;
  readonly onCancelEdit: () => void;
  readonly onDelete: (item: ScientThreadQueueItem) => void;
}) {
  const { item, threadBusy } = props;
  return (
    <SortableQueueRow id={item.queueItemId}>
      {({ listeners, setNodeRef, style, isDragging }) => (
        <div
          ref={setNodeRef}
          style={style}
          className={cn(
            "flex items-start gap-2 rounded-lg border bg-background/70 px-2.5 py-2",
            props.editing && "border-primary/50 bg-primary/5",
            isDragging && "opacity-70 shadow-md",
          )}
          data-testid={`thread-queue-row-${item.queueItemId}`}
        >
          <button
            type="button"
            className="mt-0.5 shrink-0 cursor-grab touch-none rounded-sm p-1 text-muted-foreground hover:bg-muted hover:text-foreground active:cursor-grabbing"
            aria-label="Reorder queued message"
            {...listeners}
          >
            <GripVertical className="size-4" aria-hidden="true" />
          </button>
          <div className="min-w-0 flex-1">
            <div className="flex items-start gap-2">
              <span className="mt-0.5 shrink-0 text-xs font-medium tabular-nums text-muted-foreground">
                {props.position}
              </span>
              <p className="line-clamp-2 min-w-0 whitespace-pre-wrap break-words text-sm leading-5 text-foreground">
                {item.text}
              </p>
            </div>
            <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 pl-5 text-[11px] text-muted-foreground">
              {item.attachments.length > 0 && (
                <span className="inline-flex items-center gap-1">
                  <Paperclip className="size-3" aria-hidden="true" />
                  {item.attachments.length === 1
                    ? "1 attachment"
                    : `${item.attachments.length} attachments`}
                </span>
              )}
              {props.editing && (
                <span className="font-medium text-primary">Editing in composer</span>
              )}
            </div>
          </div>
          <div className="flex shrink-0 flex-wrap items-center justify-end gap-1">
            <Button
              type="button"
              size="compact"
              variant={threadBusy ? "outline" : "default"}
              disabled={props.dispatching || props.editing}
              title={
                props.editing
                  ? "Finish or cancel the edit before sending this message"
                  : threadBusy
                    ? "Send this message into the running turn"
                    : "Send this message now"
              }
              aria-label={
                props.editing ? "Finish editing before sending" : threadBusy ? "Steer" : "Send"
              }
              onClick={() => props.onSend(item)}
            >
              {threadBusy ? <Zap aria-hidden="true" /> : <Send aria-hidden="true" />}
              <span>{threadBusy ? "Steer" : "Send"}</span>
            </Button>
            {props.editing ? (
              <Button
                type="button"
                size="compact"
                variant="ghost-muted"
                onClick={props.onCancelEdit}
              >
                <X aria-hidden="true" />
                <span>Cancel</span>
              </Button>
            ) : (
              <Button
                type="button"
                size="compact"
                variant="outline"
                disabled={props.dispatching}
                title="Load this message into the composer"
                aria-label="Edit queued message"
                onClick={() => props.onEdit(item)}
              >
                <Pencil aria-hidden="true" />
                <span>Edit</span>
              </Button>
            )}
            <Button
              type="button"
              size="icon-xs"
              variant="ghost-muted"
              className="shrink-0"
              disabled={props.dispatching}
              title="Delete this queued message"
              aria-label="Delete queued message"
              onClick={() => props.onDelete(item)}
            >
              <Trash2 aria-hidden="true" />
            </Button>
          </div>
        </div>
      )}
    </SortableQueueRow>
  );
}

export function ThreadQueueStrip(props: {
  readonly items: ReadonlyArray<ScientThreadQueueItem>;
  readonly error: string | null;
  readonly threadBusy: boolean;
  readonly dispatchingItemId: ScientThreadQueueItemId | null;
  readonly editingItemId: ScientThreadQueueItemId | null;
  readonly onSend: (item: ScientThreadQueueItem) => void;
  readonly onEdit: (item: ScientThreadQueueItem) => void;
  readonly onCancelEdit: () => void;
  readonly onDelete: (item: ScientThreadQueueItem) => void;
  readonly onReorder: (queueItemIds: ReadonlyArray<ScientThreadQueueItemId>) => void;
}) {
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }));

  const handleDragEnd = useCallback(
    (event: DragEndEvent) => {
      const activeId = String(event.active.id);
      const overId = event.over === null ? null : String(event.over.id);
      if (overId === null || activeId === overId) return;
      const ids = props.items.map((item) => item.queueItemId);
      const fromIndex = ids.indexOf(activeId as ScientThreadQueueItemId);
      const toIndex = ids.indexOf(overId as ScientThreadQueueItemId);
      if (fromIndex === -1 || toIndex === -1) return;
      props.onReorder(arrayMove([...ids], fromIndex, toIndex));
    },
    [props.items, props.onReorder],
  );

  if (props.items.length === 0 && props.error === null) return null;

  return (
    <section
      className="mb-2 rounded-xl border border-border/70 bg-muted/20 p-2.5"
      aria-label="Queued messages"
      data-testid="thread-queue-strip"
    >
      <div className="mb-2 flex items-start gap-2 px-0.5">
        <ListOrdered className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 text-sm font-semibold">
            <span>Up next</span>
            <span className="rounded-full bg-background px-1.5 py-0.5 text-xs font-medium text-muted-foreground">
              {props.items.length}
            </span>
          </div>
          <p className="mt-0.5 text-xs text-muted-foreground">
            These messages stay here until you send them.
          </p>
        </div>
        {props.items.length > 1 && (
          <span className="pt-0.5 text-[11px] text-muted-foreground">Drag to reorder</span>
        )}
      </div>
      {props.error !== null && (
        <div
          className="mb-2 rounded-md bg-destructive/10 px-2 py-1.5 text-xs text-destructive"
          role="alert"
        >
          {props.error}
        </div>
      )}
      {props.items.length > 0 && (
        <div className="max-h-64 space-y-1.5 overflow-y-auto pr-0.5">
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
              {props.items.map((item, index) => (
                <QueueRow
                  key={item.queueItemId}
                  item={item}
                  position={index + 1}
                  threadBusy={props.threadBusy}
                  dispatching={props.dispatchingItemId === item.queueItemId}
                  editing={props.editingItemId === item.queueItemId}
                  onSend={props.onSend}
                  onEdit={props.onEdit}
                  onCancelEdit={props.onCancelEdit}
                  onDelete={props.onDelete}
                />
              ))}
            </SortableContext>
          </DndContext>
        </div>
      )}
    </section>
  );
}
