import {
  DndContext,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  arrayMove,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { restrictToFirstScrollableAncestor, restrictToVerticalAxis } from "@dnd-kit/modifiers";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import { scopeThreadRef, scopedThreadKey } from "@t3tools/client-runtime/environment";
import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";

import { orderItemsByPreferredIds, planPinnedReorder } from "../Sidebar.logic";

export type ScientQuickChatSortableBag = Pick<
  ReturnType<typeof useSortable>,
  "listeners" | "setNodeRef" | "transform" | "transition" | "isDragging"
>;

function threadKey(thread: EnvironmentThreadShell): string {
  return scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id));
}

function SortableQuickChatRow(props: {
  readonly id: string;
  readonly children: (bag: ScientQuickChatSortableBag) => ReactNode;
}) {
  const { listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: props.id,
  });
  return props.children({ listeners, setNodeRef, transform, transition, isDragging });
}

/**
 * Scient-owned sortable boundary for pinned Quick Chats. T3 continues to
 * own the actual thread row and server mutation; this component only keeps
 * the split Quick Chat section behaviorally equivalent to T3's pinned list.
 */
export function ScientQuickChatPinnedList(props: {
  readonly threads: readonly EnvironmentThreadShell[];
  readonly reorderableKeys: ReadonlySet<string>;
  readonly onReorder: (thread: EnvironmentThreadShell, orderKey: string) => Promise<boolean>;
  readonly renderRow: (
    thread: EnvironmentThreadShell,
    sortable?: ScientQuickChatSortableBag,
  ) => ReactNode;
}) {
  const { onReorder, renderRow, reorderableKeys, threads } = props;
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }));
  const [optimisticOrder, setOptimisticOrder] = useState<{
    readonly order: readonly string[];
    readonly keysAtDrop: ReadonlyMap<string, string | null>;
    readonly assignedKeys: ReadonlyMap<string, string>;
  } | null>(null);
  const orderedThreads = useMemo(
    () =>
      optimisticOrder === null
        ? threads
        : orderItemsByPreferredIds({
            items: threads,
            preferredIds: optimisticOrder.order,
            getId: threadKey,
          }),
    [optimisticOrder, threads],
  );

  useEffect(() => {
    if (optimisticOrder === null) return;
    const canonical = threads.filter((thread) => reorderableKeys.has(threadKey(thread)));
    const canonicalKeys = canonical.map(threadKey);
    const membershipChanged =
      canonicalKeys.length !== optimisticOrder.order.length ||
      canonicalKeys.some((key) => !optimisticOrder.order.includes(key));
    const foreignKeyLanded = canonical.some((thread, index) => {
      const key = canonicalKeys[index]!;
      const currentOrderKey = thread.pinOrderKey ?? null;
      if (currentOrderKey === optimisticOrder.keysAtDrop.get(key)) return false;
      return currentOrderKey !== optimisticOrder.assignedKeys.get(key);
    });
    const currentOrderKeyByThread = new Map(
      canonical.map((thread, index) => [canonicalKeys[index]!, thread.pinOrderKey ?? null]),
    );
    const allAssignmentsLanded = [...optimisticOrder.assignedKeys].every(
      ([key, orderKey]) => currentOrderKeyByThread.get(key) === orderKey,
    );
    const orderConfirmed =
      !membershipChanged &&
      canonicalKeys.every((key, index) => key === optimisticOrder.order[index]);
    if (membershipChanged || foreignKeyLanded || allAssignmentsLanded || orderConfirmed) {
      setOptimisticOrder(null);
    }
  }, [optimisticOrder, reorderableKeys, threads]);

  const handleDragEnd = useCallback(
    (event: DragEndEvent) => {
      const activeKey = String(event.active.id);
      const overKey = event.over === null ? null : String(event.over.id);
      if (overKey === null || activeKey === overKey) return;
      const reorderable = orderedThreads.filter((thread) => reorderableKeys.has(threadKey(thread)));
      const keys = reorderable.map(threadKey);
      const fromIndex = keys.indexOf(activeKey);
      const toIndex = keys.indexOf(overKey);
      if (fromIndex === -1 || toIndex === -1) return;

      const order = arrayMove([...keys], fromIndex, toIndex);
      const threadByKey = new Map(reorderable.map((thread) => [threadKey(thread), thread]));
      const keysAtDrop = new Map(
        reorderable.map((thread) => [threadKey(thread), thread.pinOrderKey ?? null]),
      );
      const assignments = planPinnedReorder({
        orderedIds: order,
        keysById: keysAtDrop,
        movedId: activeKey,
      });
      if (assignments.length === 0) return;

      setOptimisticOrder({
        order,
        keysAtDrop,
        assignedKeys: new Map(
          assignments.map((assignment) => [assignment.id, assignment.orderKey]),
        ),
      });
      void (async () => {
        for (const assignment of assignments) {
          const thread = threadByKey.get(assignment.id);
          if (thread === undefined) continue;
          if (!(await onReorder(thread, assignment.orderKey))) {
            setOptimisticOrder(null);
            return;
          }
        }
      })();
    },
    [onReorder, orderedThreads, reorderableKeys],
  );

  const sortableKeys = orderedThreads.map(threadKey).filter((key) => reorderableKeys.has(key));

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCenter}
      modifiers={[restrictToVerticalAxis, restrictToFirstScrollableAncestor]}
      onDragEnd={handleDragEnd}
    >
      <SortableContext items={sortableKeys} strategy={verticalListSortingStrategy}>
        {orderedThreads.map((thread) => {
          const key = threadKey(thread);
          if (!reorderableKeys.has(key)) return renderRow(thread);
          return (
            <SortableQuickChatRow key={key} id={key}>
              {(bag) => renderRow(thread, bag)}
            </SortableQuickChatRow>
          );
        })}
      </SortableContext>
    </DndContext>
  );
}
