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
import { CornerDownRight, GripVertical, Paperclip, Pencil, Trash2 } from "lucide-react";
import { useCallback } from "react";

import { cn } from "~/lib/utils";

import { Button } from "../../components/ui/button";

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
    style: { transform: CSS.Translate.toString(transform), transition: transition ?? undefined },
    isDragging,
  });
}

function QueueRow(props: {
  readonly item: ScientThreadQueueItem;
  readonly canReorder: boolean;
  readonly threadBusy: boolean;
  readonly dispatching: boolean;
  readonly onSteer: (item: ScientThreadQueueItem) => void;
  readonly onEdit: (item: ScientThreadQueueItem) => void;
  readonly onDelete: (item: ScientThreadQueueItem) => void;
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
          )}
          data-testid={`thread-queue-row-${props.item.queueItemId}`}
        >
          {props.canReorder && (
            <button
              type="button"
              className="shrink-0 cursor-grab touch-none text-muted-foreground hover:text-foreground active:cursor-grabbing"
              aria-label="Reorder queued message"
              {...listeners}
            >
              <GripVertical className="size-3" aria-hidden="true" />
            </button>
          )}
          <div className="min-w-0 flex-1">
            <span className="block truncate text-sm text-foreground">{props.item.text}</span>
            {props.item.attachments.length > 0 && (
              <span className="mt-0.5 inline-flex items-center gap-1 text-[11px] text-muted-foreground">
                <Paperclip className="size-3" aria-hidden="true" />
                {props.item.attachments.length}
              </span>
            )}
          </div>
          {props.threadBusy && (
            <Button
              type="button"
              size="compact"
              variant="ghost-muted"
              className="h-4.5 gap-0.5 px-1.5 [&_svg]:-mx-0"
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
        </div>
      )}
    </SortableQueueRow>
  );
}

/** A compact composer extension for messages waiting behind the active turn. */
export function ThreadQueueStrip(props: {
  readonly items: ReadonlyArray<ScientThreadQueueItem>;
  readonly error: string | null;
  readonly threadBusy: boolean;
  readonly dispatchingItemId: ScientThreadQueueItemId | null;
  readonly onSteer: (item: ScientThreadQueueItem) => void;
  readonly retryItemId?: ScientThreadQueueItemId;
  readonly onRetry?: (item: ScientThreadQueueItem) => void;
  readonly onEdit: (item: ScientThreadQueueItem) => void;
  readonly onDelete: (item: ScientThreadQueueItem) => void;
  readonly onReorder: (queueItemIds: ReadonlyArray<ScientThreadQueueItemId>) => void;
}) {
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }));
  const retryItem =
    props.retryItemId === undefined
      ? null
      : (props.items.find((item) => item.queueItemId === props.retryItemId) ?? null);
  const handleDragEnd = useCallback(
    (event: DragEndEvent) => {
      const activeId = String(event.active.id) as ScientThreadQueueItemId;
      const overId =
        event.over === null ? null : (String(event.over.id) as ScientThreadQueueItemId);
      if (overId === null || activeId === overId) return;
      const ids = props.items.map((item) => item.queueItemId);
      const fromIndex = ids.indexOf(activeId);
      const toIndex = ids.indexOf(overId);
      if (fromIndex === -1 || toIndex === -1) return;
      props.onReorder(arrayMove([...ids], fromIndex, toIndex));
    },
    [props.items, props.onReorder],
  );

  if (props.items.length === 0 && props.error === null) return null;

  return (
    <section
      className="mx-4 -mb-px overflow-hidden rounded-t-xl border border-b-0 border-border/70 bg-background"
      aria-label="Queued messages"
      data-testid="thread-queue-strip"
    >
      {props.error !== null && (
        <div
          className="flex items-center gap-2 border-b border-destructive/20 bg-destructive/5 px-3 py-1.5 text-xs text-destructive"
          role="alert"
        >
          <span className="min-w-0 flex-1 truncate">{props.error}</span>
          {!props.threadBusy && retryItem && props.onRetry && (
            <Button
              type="button"
              size="compact"
              variant="outline"
              disabled={props.dispatchingItemId !== null}
              onClick={() => props.onRetry?.(retryItem)}
            >
              Retry
            </Button>
          )}
        </div>
      )}
      {props.items.length > 0 && (
        <div className="max-h-36 overflow-y-auto">
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
                  canReorder={props.items.length > 1}
                  threadBusy={props.threadBusy}
                  dispatching={props.dispatchingItemId === item.queueItemId}
                  onSteer={props.onSteer}
                  onEdit={props.onEdit}
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
