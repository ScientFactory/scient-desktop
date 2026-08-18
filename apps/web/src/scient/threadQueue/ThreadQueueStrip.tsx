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
import { GripVertical, Pencil, SendHorizontal, Trash2, Zap } from "lucide-react";
import { useCallback } from "react";

import { Button } from "../../components/ui/button";

/**
 * Minimal queued-message strip rendered above the composer. Rows can be
 * dragged to reorder, clicked to edit back into the composer, dispatched
 * (steer while busy, send while idle), or deleted. Scient-owned; see
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
  readonly threadBusy: boolean;
  readonly dispatching: boolean;
  readonly onSend: (item: ScientThreadQueueItem) => void;
  readonly onEdit: (item: ScientThreadQueueItem) => void;
  readonly onDelete: (item: ScientThreadQueueItem) => void;
}) {
  const { item, threadBusy } = props;
  return (
    <SortableQueueRow id={item.queueItemId}>
      {({ listeners, setNodeRef, style, isDragging }) => (
        <div
          ref={setNodeRef}
          style={style}
          className={`flex items-center gap-1 rounded-md border border-border bg-background px-1.5 py-1 ${
            isDragging ? "opacity-70" : ""
          }`}
        >
          <button
            type="button"
            className="shrink-0 cursor-grab touch-none rounded-sm p-0.5 text-muted-foreground hover:bg-muted active:cursor-grabbing"
            aria-label="Reorder queued message"
            {...listeners}
          >
            <GripVertical className="size-3.5" aria-hidden="true" />
          </button>
          <button
            type="button"
            className="min-w-0 flex-1 cursor-text truncate text-left text-xs text-muted-foreground hover:text-foreground"
            title="Edit this queued message"
            onClick={() => props.onEdit(item)}
          >
            {item.text}
          </button>
          <Button
            type="button"
            size="icon-xs"
            variant="ghost"
            className="shrink-0"
            disabled={props.dispatching}
            title={
              threadBusy ? "Steer the running turn with this message" : "Send this message now"
            }
            aria-label={threadBusy ? "Steer queued message" : "Send queued message"}
            onClick={() => props.onSend(item)}
          >
            {threadBusy ? <Zap /> : <SendHorizontal />}
          </Button>
          <Button
            type="button"
            size="icon-xs"
            variant="ghost"
            className="shrink-0"
            title="Edit this queued message"
            aria-label="Edit queued message"
            onClick={() => props.onEdit(item)}
          >
            <Pencil />
          </Button>
          <Button
            type="button"
            size="icon-xs"
            variant="ghost"
            className="shrink-0"
            title="Delete this queued message"
            aria-label="Delete queued message"
            onClick={() => props.onDelete(item)}
          >
            <Trash2 />
          </Button>
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
  readonly onSend: (item: ScientThreadQueueItem) => void;
  readonly onEdit: (item: ScientThreadQueueItem) => void;
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
    <div className="mb-1.5 flex flex-col gap-1" data-testid="thread-queue-strip">
      <div className="px-1 text-[11px] font-medium text-muted-foreground">
        Queued ({props.items.length})
      </div>
      {props.error !== null && (
        <div className="px-1 text-[11px] text-destructive">{props.error}</div>
      )}
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
              threadBusy={props.threadBusy}
              dispatching={props.dispatchingItemId === item.queueItemId}
              onSend={props.onSend}
              onEdit={props.onEdit}
              onDelete={props.onDelete}
            />
          ))}
        </SortableContext>
      </DndContext>
    </div>
  );
}
