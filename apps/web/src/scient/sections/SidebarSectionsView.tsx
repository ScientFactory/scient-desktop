import {
  closestCenter,
  type CollisionDetection,
  DndContext,
  type DragEndEvent,
  type DragMoveEvent,
  type DragOverEvent,
  DragOverlay,
  type DragStartEvent,
  MeasuringStrategy,
  PointerSensor,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import { restrictToFirstScrollableAncestor, restrictToVerticalAxis } from "@dnd-kit/modifiers";
import {
  SortableContext,
  type SortingStrategy,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  type AtomCommandResult,
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import { type ScopedThreadRef, type ThreadSection, ThreadSectionId } from "@t3tools/contracts";
import { ChevronRightIcon, EllipsisIcon, PlusIcon, SquarePenIcon } from "lucide-react";
import {
  Fragment,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import type { SidebarDropVerb } from "../../components/Sidebar.logic";
import { stackedThreadToast, toastManager } from "../../components/ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../../components/ui/tooltip";
import { useThreadActions } from "../../hooks/useThreadActions";
import { cn } from "../../lib/utils";
import { readEnvironmentSupportsThreadReorder, useThreadSectionActions } from "./actions";
import { FadeTruncate } from "./FadeTruncate";
import {
  GENERAL_SECTION_GROUP_ID,
  type SectionGroup,
  type SectionsDropTarget,
  type SectionsLifecycle,
  type SectionsListItem,
  planSectionsThreadDrop,
  resolveSectionDragOrder,
  resolveSectionsDropTarget,
  type SectionBlock,
  sectionsDropIndex,
  sectionShifts,
  sectionGroupIdFromHeaderItemId,
  sectionHeaderItemId,
  newSectionTitle,
} from "./logic";
import { readTypedSectionName } from "./sectionNameInput";

type Shell = EnvironmentThreadShell;

const keyOf = (thread: Shell) => scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id));

/** The subset of a sortable bag a thread row applies to its root. */
export type SectionsRowSortable = Pick<
  ReturnType<typeof useSortable>,
  "listeners" | "setNodeRef" | "transform" | "transition" | "isDragging"
>;

export interface SidebarSectionsViewProps {
  readonly groups: readonly SectionGroup<Shell>[];
  readonly collapsedGroupIds: ReadonlySet<string>;
  /** The open thread stays visible even inside a collapsed section. */
  readonly routeThreadKey: string | null;
  readonly onToggleGroup: (groupId: string) => void;
  readonly snoozedThreads: readonly Shell[];
  readonly settledThreads: readonly Shell[];
  /** Whether each shelf renders its header (the Status view's rule). */
  readonly showSnoozedShelf: boolean;
  /** Retained keys, including hidden rows, so drops never collide with them. */
  readonly pinnedKeysById: ReadonlyMap<string, string | null | undefined>;
  readonly activeKeysById: ReadonlyMap<string, string | null | undefined>;
  readonly canDragThread: (thread: Shell) => boolean;
  readonly renderThreadRow: (
    thread: Shell,
    lifecycle: SectionsLifecycle,
    sortable: SectionsRowSortable | undefined,
    dropVerb: SidebarDropVerb | null,
  ) => ReactNode;
  /** Renders the shared shelf header; it registers itself under `markerId`. */
  readonly renderShelfHeader: (
    shelf: "snoozed" | "settled",
    state: { readonly dragging: boolean; readonly isDropTarget: boolean },
  ) => ReactNode;
  readonly shelfMarkerId: (shelf: "snoozed" | "settled") => string;
  /** Draft rows and other content above the sections. */
  readonly leading?: ReactNode;
  /** "Show more" for the settled shelf. */
  readonly trailing?: ReactNode;
  readonly onSettleThread: (threadRef: ScopedThreadRef) => void;
  readonly onReorderSections: (orderedIds: readonly string[]) => void;
  readonly onSectionMenu: (section: ThreadSection, position: { x: number; y: number }) => void;
  /** Null starts an ordinary thread from General. */
  readonly onNewThreadInSection: (section: ThreadSection | null) => void;
  readonly renamingSectionId: string | null;
  readonly onRenamingSectionChange: (sectionId: string | null) => void;
  readonly onRenameSection: (sectionId: string, name: string) => void;
  /** Inline name input replacing the "New section" row; null when not creating. */
  readonly creatingSection: {
    readonly onSubmit: (name: string) => void;
    /** Threads the section is being made for (0 from the "New section" row). */
    readonly threadCount: number;
  } | null;
  readonly onStartCreateSection: () => void;
  readonly onCancelCreateSection: () => void;
}

type DragState =
  | { readonly kind: "thread"; readonly key: string; readonly target: SectionsDropTarget | null }
  | {
      readonly kind: "section";
      readonly groupId: string;
      /** Group ids in the order the drop would produce. */
      readonly preview: readonly string[];
      readonly geometry: SectionDragGeometry;
    };

/**
 * Geometry frozen at the start of a section drag. Blocks move by transform
 * only, so nothing reflows under the pointer and targets are judged against
 * where sections were, never against where they are sliding.
 */
type SectionDragGeometry = {
  readonly blocks: readonly SectionBlock[];
  readonly pointerY: number;
  readonly scroller: HTMLElement | null;
  readonly scrollTop: number;
};

const SECTION_SLIDE = "transform 160ms ease";

/**
 * Every header in the Sections view (sections, General and the Settled and
 * Snoozed shelves) sits 4px low in its 32px row: closer to the threads it
 * heads than to the group above, at the same height, so nothing reflows.
 */
export const SECTION_HEADER_OFFSET_CLASS = "pt-2";

function scrollParentOf(element: HTMLElement | null): HTMLElement | null {
  for (let node = element?.parentElement ?? null; node; node = node.parentElement) {
    const overflowY = getComputedStyle(node).overflowY;
    if (overflowY === "auto" || overflowY === "scroll") return node;
  }
  return null;
}

/** Measures each section block from its header to the next one (or the list's end marker). */
function measureSectionBlocks(
  list: HTMLElement,
  groupIds: readonly string[],
): SectionBlock[] | null {
  const tops = groupIds.map(
    (groupId) =>
      list
        .querySelector<HTMLElement>(`[data-section-header="${globalThis.CSS.escape(groupId)}"]`)
        ?.getBoundingClientRect().top,
  );
  const end = list.querySelector<HTMLElement>("[data-sections-end]")?.getBoundingClientRect().top;
  if (end === undefined || tops.some((top) => top === undefined)) return null;
  return groupIds.map((groupId, index) => {
    const top = tops[index]!;
    return { groupId, top, height: (tops[index + 1] ?? end) - top };
  });
}

/** A dropped layout, held until the store reflects it so rows never snap back. */
type HeldLayout = { readonly ids: readonly string[]; readonly expiresAt: number };

const HELD_LAYOUT_MS = 2_000;

export function SidebarSectionsView(props: SidebarSectionsViewProps) {
  const {
    activeKeysById,
    canDragThread,
    collapsedGroupIds,
    groups,
    onReorderSections,
    onSettleThread,
    pinnedKeysById,
    settledThreads,
    shelfMarkerId,
    snoozedThreads,
  } = props;
  const { unsettleThread, unsnoozeThread, reorderActiveThread, reorderPinnedThread } =
    useThreadActions();
  const { moveThreadsToSection } = useThreadSectionActions();
  const [drag, setDrag] = useState<DragState | null>(null);
  const [held, setHeld] = useState<HeldLayout | null>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }));

  const threadByKey = useMemo(() => {
    const map = new Map<string, Shell>();
    for (const thread of [
      ...groups.flatMap((group) => group.threads),
      ...snoozedThreads,
      ...settledThreads,
    ]) {
      map.set(scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id)), thread);
    }
    return map;
  }, [groups, settledThreads, snoozedThreads]);

  // The canonical sortable list: headers own the rows after them; shelves end it.
  const canonicalItems = useMemo((): SectionsListItem[] => {
    const items: SectionsListItem[] = [];
    for (const group of groups) {
      items.push({ kind: "header", id: sectionHeaderItemId(group.id), groupId: group.id });
      const collapsed = collapsedGroupIds.has(group.id);
      for (const thread of group.threads) {
        if (collapsed && keyOf(thread) !== props.routeThreadKey) continue;
        items.push({
          kind: "thread",
          id: keyOf(thread),
          lifecycle: thread.pinnedAt != null ? "pinned" : "active",
          groupId: group.id,
        });
      }
    }
    if (props.showSnoozedShelf) {
      items.push({ kind: "shelf", id: shelfMarkerId("snoozed"), shelf: "snoozed" });
      for (const thread of snoozedThreads) {
        items.push({ kind: "thread", id: keyOf(thread), lifecycle: "snoozed", groupId: null });
      }
    }
    items.push({ kind: "shelf", id: shelfMarkerId("settled"), shelf: "settled" });
    for (const thread of settledThreads) {
      items.push({ kind: "thread", id: keyOf(thread), lifecycle: "settled", groupId: null });
    }
    return items;
  }, [
    collapsedGroupIds,
    groups,
    props.routeThreadKey,
    props.showSnoozedShelf,
    settledThreads,
    shelfMarkerId,
    snoozedThreads,
  ]);

  // A held layout expires on its own, and stops applying (below) as soon as the
  // live order catches up with it.
  useEffect(() => {
    if (held === null) return;
    const timer = setTimeout(
      () => setHeld((current) => (current === held ? null : current)),
      Math.max(0, held.expiresAt - Date.now()),
    );
    return () => clearTimeout(timer);
  }, [held]);

  // The held layout applies only while it still describes the same rows.
  const items = useMemo((): SectionsListItem[] => {
    if (held === null) return canonicalItems;
    const byId = new Map(canonicalItems.map((item) => [item.id, item]));
    if (held.ids.length !== byId.size || held.ids.some((id) => !byId.has(id))) {
      return canonicalItems;
    }
    // Caught up: the live order already matches, so drags are allowed again.
    if (held.ids.every((id, index) => canonicalItems[index]!.id === id)) return canonicalItems;
    return held.ids.map((id) => byId.get(id)!);
  }, [canonicalItems, held]);
  const holding = items !== canonicalItems;

  const sortableIds = useMemo(() => items.map((item) => item.id), [items]);
  // Rows slide to where a drop would land, so over a header the lifted row
  // shows below it, in that header's section (see sectionsDropIndex).
  const sortingStrategy = useCallback<SortingStrategy>(
    (args) =>
      verticalListSortingStrategy(
        args.activeIndex < 0 || args.overIndex < 0 || items[args.activeIndex]?.kind !== "thread"
          ? args
          : { ...args, overIndex: sectionsDropIndex(items, args.activeIndex, args.overIndex) },
      ),
    [items],
  );

  const lifecycleByKey = useMemo(
    () =>
      new Map(
        items.flatMap((item) =>
          item.kind === "thread" ? [[item.id, item.lifecycle] as const] : [],
        ),
      ),
    [items],
  );

  const orderOfGroup = useCallback(
    (groupId: string) =>
      items.flatMap((item) =>
        item.kind === "thread" && item.groupId === groupId ? [item.id] : [],
      ),
    [items],
  );

  const handleDragStart = useCallback(
    (event: DragStartEvent) => {
      const id = String(event.active.id);
      const groupId = sectionGroupIdFromHeaderItemId(id);
      if (groupId === null) {
        setDrag({ kind: "thread", key: id, target: null });
        return;
      }
      const groupIds = groups.map((group) => group.id);
      const list = listRef.current;
      const blocks = list ? measureSectionBlocks(list, groupIds) : null;
      const pointer = event.activatorEvent as PointerEvent | null;
      if (blocks === null || pointer === null || typeof pointer.clientY !== "number") return;
      const scroller = scrollParentOf(list);
      setDrag({
        kind: "section",
        groupId,
        preview: groupIds,
        geometry: {
          blocks,
          pointerY: pointer.clientY,
          scroller,
          scrollTop: scroller?.scrollTop ?? 0,
        },
      });
    },
    [groups],
  );

  const handleDragMove = useCallback((event: DragMoveEvent) => {
    setDrag((current) => {
      if (current?.kind !== "section") return current;
      const { geometry } = current;
      const scrolled = (geometry.scroller?.scrollTop ?? 0) - geometry.scrollTop;
      const pointerY = geometry.pointerY + event.delta.y + scrolled;
      const preview = resolveSectionDragOrder(geometry.blocks, current.groupId, pointerY);
      return preview.every((groupId, position) => groupId === current.preview[position])
        ? current
        : { ...current, preview };
    });
  }, []);

  // Section drags resolve against the frozen geometry, never dnd-kit's targets,
  // so the sortable list leaves every row and header where it is.
  const collisionDetection = useCallback<CollisionDetection>(
    (args) =>
      sectionGroupIdFromHeaderItemId(String(args.active.id)) === null ? closestCenter(args) : [],
    [],
  );

  const reportFailure = useCallback(
    (title: string, result: AtomCommandResult<unknown, unknown>) => {
      if (result._tag !== "Failure" || isAtomCommandInterrupted(result)) return;
      const error = squashAtomCommandFailure(result);
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title,
          description: error instanceof Error ? error.message : "An error occurred.",
        }),
      );
    },
    [],
  );

  const dropSection = useCallback(
    (next: readonly string[]) => {
      const current = groups.map((group) => group.id);
      if (next.every((groupId, index) => groupId === current[index])) return;
      // Hold the full layout in the new group order, shelves last, so the
      // blocks stay where they slid while the catalog write travels.
      const blocks = new Map<string, string[]>();
      let owner: string | null = null;
      const tail: string[] = [];
      for (const item of items) {
        if (item.kind === "header") owner = item.groupId;
        else if (item.kind === "shelf") owner = null;
        if (owner === null) {
          tail.push(item.id);
        } else {
          const block = blocks.get(owner) ?? [];
          block.push(item.id);
          blocks.set(owner, block);
        }
      }
      setHeld({
        ids: [...next.flatMap((groupId) => blocks.get(groupId) ?? []), ...tail],
        expiresAt: Date.now() + HELD_LAYOUT_MS,
      });
      onReorderSections(next);
    },
    [groups, items, onReorderSections],
  );

  /** What dropping the lifted row over `overId` would do; null when nothing. */
  const planThreadDrop = useCallback(
    (activeKey: string, overId: string) => {
      const thread = threadByKey.get(activeKey);
      const source = items.find((item) => item.id === activeKey);
      const target = resolveSectionsDropTarget(items, activeKey, overId);
      if (thread === undefined || source?.kind !== "thread" || target === null) return null;
      const plan = planSectionsThreadDrop({
        source: {
          key: activeKey,
          lifecycle: source.lifecycle,
          groupId: source.groupId,
          pinned: thread.pinnedAt != null,
        },
        target,
        targetOrderBefore: target.kind === "section" ? orderOfGroup(target.groupId) : [],
        lifecycleByKey,
        pinnedKeysById,
        activeKeysById,
        toSectionId: (groupId) =>
          groupId === GENERAL_SECTION_GROUP_ID ? null : ThreadSectionId.make(groupId),
      });
      return plan.kind === "none" ? null : { thread, target, plan };
    },
    [activeKeysById, items, lifecycleByKey, orderOfGroup, pinnedKeysById, threadByKey],
  );

  // Only a drop that changes something highlights its section or shelf.
  const handleDragOver = useCallback(
    (event: DragOverEvent) => {
      const activeId = String(event.active.id);
      if (sectionGroupIdFromHeaderItemId(activeId) !== null) return;
      const target = event.over
        ? (planThreadDrop(activeId, String(event.over.id))?.target ?? null)
        : null;
      setDrag((current) =>
        current?.kind === "thread" && current.key === activeId ? { ...current, target } : current,
      );
    },
    [planThreadDrop],
  );

  const dropThread = useCallback(
    (activeKey: string, overId: string) => {
      const planned = planThreadDrop(activeKey, overId);
      if (planned === null) return;
      const { thread, target, plan } = planned;
      const threadRef = scopeThreadRef(thread.environmentId, thread.id);
      if (plan.kind === "settle") {
        onSettleThread(threadRef);
        return;
      }
      if (target.kind === "section") {
        // Show the drop where it landed while the writes travel.
        const activeIndex = items.findIndex((item) => item.id === activeKey);
        const overIndex = items.findIndex((item) => item.id === overId);
        const ids = items.map((item) => item.id).filter((id) => id !== activeKey);
        ids.splice(sectionsDropIndex(items, activeIndex, overIndex), 0, activeKey);
        setHeld({ ids, expiresAt: Date.now() + HELD_LAYOUT_MS });
      }
      // Order keys are written only where every row's server takes them; the
      // section move does not depend on them.
      const assignments = plan.assignments.every((assignment) => {
        const row = threadByKey.get(assignment.id);
        return (
          row !== undefined && readEnvironmentSupportsThreadReorder(row.environmentId, plan.group)
        );
      })
        ? plan.assignments
        : [];
      const release = () => setHeld(null);
      void (async () => {
        if (plan.unsettle) {
          const result = await unsettleThread(threadRef);
          if (result._tag === "Failure") {
            release();
            return reportFailure("Failed to un-settle thread", result);
          }
        }
        if (plan.unsnooze) {
          const result = await unsnoozeThread(threadRef);
          if (result._tag === "Failure") {
            release();
            return reportFailure("Failed to wake thread", result);
          }
        }
        const moved =
          plan.sectionId !== undefined
            ? moveThreadsToSection([threadRef], plan.sectionId)
            : Promise.resolve(true);
        // Stop on failure; each successful key write remains a valid placement.
        for (const assignment of assignments) {
          const target = threadByKey.get(assignment.id);
          if (target === undefined) continue;
          const result = await (
            plan.group === "pinned" ? reorderPinnedThread : reorderActiveThread
          )(scopeThreadRef(target.environmentId, target.id), assignment.orderKey);
          if (result._tag === "Failure") {
            reportFailure(
              plan.group === "pinned"
                ? "Failed to reorder pinned threads"
                : "Failed to reorder threads",
              result,
            );
            break;
          }
        }
        await moved;
        // Every write has been applied locally by now; show the store's order.
        release();
      })();
    },
    [
      items,
      moveThreadsToSection,
      onSettleThread,
      planThreadDrop,
      reorderActiveThread,
      reorderPinnedThread,
      reportFailure,
      threadByKey,
      unsettleThread,
      unsnoozeThread,
    ],
  );

  const handleDragEnd = useCallback(
    (event: DragEndEvent) => {
      const current = drag;
      setDrag(null);
      if (current === null) return;
      if (current.kind === "section") dropSection(current.preview);
      else if (event.over !== null) dropThread(current.key, String(event.over.id));
    },
    [drag, dropSection, dropThread],
  );
  const handleDragCancel = useCallback(() => setDrag(null), []);

  const dragTarget = drag?.kind === "thread" ? drag.target : null;
  const draggingThreadKey = drag?.kind === "thread" ? drag.key : null;
  const dropVerbFor = (key: string, lifecycle: SectionsLifecycle): SidebarDropVerb | null => {
    if (draggingThreadKey !== key || dragTarget === null) return null;
    if (dragTarget.kind === "settled") return lifecycle === "settled" ? null : "settle";
    if (lifecycle === "settled") return "unsettle";
    if (lifecycle === "snoozed") return "wake";
    return null;
  };

  const groupById = useMemo(() => new Map(groups.map((group) => [group.id, group])), [groups]);
  const liftedGroup = drag?.kind === "section" ? groupById.get(drag.groupId) : undefined;
  const shifts = useMemo(
    () => (drag?.kind === "section" ? sectionShifts(drag.geometry.blocks, drag.preview) : null),
    [drag],
  );
  const shiftedSortable = (
    sortable: SectionsRowSortable,
    groupId: string | null,
  ): SectionsRowSortable => {
    const shift = shifts !== null && groupId !== null ? (shifts.get(groupId) ?? 0) : null;
    if (shift === null) return sortable;
    return {
      ...sortable,
      transform: { x: 0, y: shift, scaleX: 1, scaleY: 1 },
      transition: SECTION_SLIDE,
    };
  };

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={collisionDetection}
      measuring={{ droppable: { strategy: MeasuringStrategy.Always } }}
      modifiers={[restrictToVerticalAxis, restrictToFirstScrollableAncestor]}
      onDragStart={handleDragStart}
      onDragMove={handleDragMove}
      onDragOver={handleDragOver}
      onDragEnd={handleDragEnd}
      onDragCancel={handleDragCancel}
    >
      <SortableContext items={sortableIds} strategy={sortingStrategy}>
        <ul ref={listRef} role="list" className="relative flex flex-1 flex-col gap-px">
          {props.leading}
          {items.map((item, index) => {
            if (item.kind === "header") {
              const group = groupById.get(item.groupId);
              if (group === undefined) return null;
              return (
                <SectionHeaderRow
                  key={item.id}
                  itemId={item.id}
                  group={group}
                  label={group.section?.name ?? "General"}
                  collapsed={collapsedGroupIds.has(group.id)}
                  isDropTarget={dragTarget?.kind === "section" && dragTarget.groupId === group.id}
                  lifted={drag?.kind === "section" && drag.groupId === group.id}
                  shiftY={shifts?.get(group.id) ?? null}
                  renaming={group.section !== null && props.renamingSectionId === group.id}
                  onToggle={() => props.onToggleGroup(group.id)}
                  onStartRename={() => props.onRenamingSectionChange(group.id)}
                  onCancelRename={() => props.onRenamingSectionChange(null)}
                  onRename={(name) => props.onRenameSection(group.id, name)}
                  onMenu={(position) => {
                    if (group.section) props.onSectionMenu(group.section, position);
                  }}
                  onNewThread={() => {
                    props.onNewThreadInSection(group.section);
                  }}
                />
              );
            }
            if (item.kind === "shelf") {
              // New sections join the end of the list, so the row sits after the last one.
              const firstShelf = items.findIndex((entry) => entry.kind === "shelf") === index;
              return (
                <Fragment key={item.id}>
                  {firstShelf ? (
                    props.creatingSection !== null ? (
                      <NewSectionRow
                        threadCount={props.creatingSection.threadCount}
                        onSubmit={props.creatingSection.onSubmit}
                        onCancel={props.onCancelCreateSection}
                      />
                    ) : (
                      <AddSectionRow onClick={props.onStartCreateSection} />
                    )
                  ) : null}
                  {props.renderShelfHeader(item.shelf, {
                    dragging: drag?.kind === "thread",
                    isDropTarget: item.shelf === "settled" && dragTarget?.kind === "settled",
                  })}
                </Fragment>
              );
            }
            const thread = threadByKey.get(item.id);
            if (thread === undefined) return null;
            return (
              <SortableSectionsRow
                key={item.id}
                id={item.id}
                disabled={holding || !canDragThread(thread)}
              >
                {(sortable) =>
                  props.renderThreadRow(
                    thread,
                    item.lifecycle,
                    shiftedSortable(sortable, item.groupId),
                    dropVerbFor(item.id, item.lifecycle),
                  )
                }
              </SortableSectionsRow>
            );
          })}
          {props.trailing}
        </ul>
      </SortableContext>
      <DragOverlay dropAnimation={null}>
        {liftedGroup ? (
          <div className="flex h-8 items-center gap-2 rounded-md bg-sidebar-row-active px-2 text-xs font-medium text-sidebar-foreground/80 shadow-sm">
            <FadeTruncate text={liftedGroup.section?.name ?? "General"} className="shrink" />
            <span aria-hidden className="h-px min-w-6 flex-1 bg-sidebar-foreground/25" />
          </div>
        ) : null}
      </DragOverlay>
    </DndContext>
  );
}

function SortableSectionsRow(props: {
  id: string;
  disabled: boolean;
  children: (sortable: SectionsRowSortable) => ReactNode;
}) {
  const { listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: props.id,
    disabled: { draggable: props.disabled },
  });
  // dnd-kit memoizes each field but not the bag; memoized rows need a stable one.
  const sortable = useMemo(
    () => ({ listeners, setNodeRef, transform, transition, isDragging }),
    [listeners, setNodeRef, transform, transition, isDragging],
  );
  return props.children(sortable);
}

function SectionHeaderRow(props: {
  itemId: string;
  group: SectionGroup<Shell>;
  label: string;
  collapsed: boolean;
  isDropTarget: boolean;
  /** The section being dragged: it slides with its rows and takes the accent. */
  lifted: boolean;
  /** Section-drag slide, in px; null when no section is being dragged. */
  shiftY: number | null;
  renaming: boolean;
  onToggle: () => void;
  onStartRename: () => void;
  onCancelRename: () => void;
  onRename: (name: string) => void;
  onMenu: (position: { x: number; y: number }) => void;
  onNewThread: () => void;
}) {
  const { group } = props;
  const isUserSection = group.section !== null;
  const { listeners, setNodeRef, transform, transition } = useSortable({
    id: props.itemId,
    disabled: { draggable: props.renaming },
  });
  const runningCount = props.collapsed
    ? group.threads.filter((thread) => thread.session?.status === "running").length
    : 0;
  const openMenu = (event: { clientX: number; clientY: number; preventDefault: () => void }) => {
    event.preventDefault();
    props.onMenu({ x: event.clientX, y: event.clientY });
  };
  // Same look as the Snoozed and Settled shelf headers, labelled with the name.
  return (
    <li
      ref={setNodeRef}
      data-thread-selection-safe
      data-testid={`sidebar-thread-section-${group.id}`}
      data-section-header={group.id}
      className={cn("mx-0.5 h-8 list-none", SECTION_HEADER_OFFSET_CLASS)}
      style={
        props.shiftY === null
          ? { transform: CSS.Translate.toString(transform), transition }
          : { transform: `translate3d(0, ${props.shiftY}px, 0)`, transition: SECTION_SLIDE }
      }
    >
      <div
        className={cn(
          "group/section-header flex h-full w-full items-center gap-2 px-2 text-xs font-medium text-sidebar-muted-foreground/60",
          (props.isDropTarget || props.lifted) && "text-primary",
        )}
        onContextMenu={isUserSection ? openMenu : undefined}
      >
        {props.renaming && group.section ? (
          <SectionNameInput
            initialName={group.section.name}
            ariaLabel="Section name"
            onSubmit={props.onRename}
            onCancel={props.onCancelRename}
          />
        ) : (
          <button
            type="button"
            aria-expanded={!props.collapsed}
            onClick={(event) => {
              // The second click of a double-click renames instead.
              if (event.detail <= 1) props.onToggle();
            }}
            onDoubleClick={
              isUserSection
                ? () => {
                    // Undo the first click's toggle, then rename in place.
                    props.onToggle();
                    props.onStartRename();
                  }
                : undefined
            }
            // Wraps so the rule can drop to a clipped second line: it shows
            // only while at least 24px are left beside the name, never as a stub.
            className="flex h-full min-w-0 flex-1 cursor-pointer flex-wrap content-start gap-x-2 overflow-hidden text-left outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
            {...listeners}
          >
            {/* One unit that shrinks as a whole: long names fade out while the
                collapsed count and chevron stay whole beside them. */}
            <span className="flex h-full min-w-0 items-center gap-2">
              <FadeTruncate text={props.label} className="shrink" />
              {props.collapsed ? (
                <span className="-ml-1 shrink-0 tabular-nums">({group.threads.length})</span>
              ) : null}
              {/* Points where the section is: right when collapsed, down when
                  open. Shown on hover while open, always while collapsed. */}
              <ChevronRightIcon
                aria-hidden
                className={cn(
                  "-ml-1 size-3 shrink-0 transition-[rotate,opacity]",
                  !props.collapsed &&
                    "rotate-90 opacity-0 group-focus-within/section-header:opacity-100 group-hover/section-header:opacity-100",
                )}
              />
              {runningCount > 0 ? (
                <span
                  aria-label={`${runningCount} working`}
                  className="size-1.5 shrink-0 rounded-full bg-primary"
                />
              ) : null}
            </span>
            <span aria-hidden className="flex h-full min-w-6 flex-1 items-center">
              <span
                className={cn(
                  "h-px w-full bg-sidebar-border/60",
                  props.isDropTarget && "bg-primary/50",
                )}
              />
            </span>
          </button>
        )}
        {props.renaming ? null : (
          // Always shown, so a section's actions are visible without hovering.
          <span className="flex shrink-0 items-center gap-1.5">
            {/* General can't be renamed or deleted, so it has no section menu. */}
            {isUserSection ? (
              <HeaderIconButton
                label="Section actions"
                onClick={(event) => {
                  const rect = event.currentTarget.getBoundingClientRect();
                  props.onMenu({ x: rect.left, y: rect.bottom + 4 });
                }}
              >
                <EllipsisIcon className="size-3.5" />
              </HeaderIconButton>
            ) : null}
            <HeaderIconButton
              label={isUserSection ? "New thread in section" : "New thread"}
              onClick={props.onNewThread}
            >
              {/* Same glyph as the sidebar's New thread button. */}
              <SquarePenIcon className="size-3.5" />
            </HeaderIconButton>
          </span>
        )}
      </div>
    </li>
  );
}

function HeaderIconButton(props: {
  label: string;
  onClick: (event: ReactMouseEvent<HTMLButtonElement>) => void;
  children: ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            aria-label={props.label}
            onClick={props.onClick}
            className="inline-flex size-5 cursor-pointer items-center justify-center rounded text-(--sidebar-icon-color) hover:bg-sidebar-row-hover hover:text-sidebar-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
          >
            {props.children}
          </button>
        }
      />
      <TooltipPopup side="top">{props.label}</TooltipPopup>
    </Tooltip>
  );
}

function SectionNameInput(props: {
  initialName: string;
  ariaLabel: string;
  placeholder?: string;
  onSubmit: (name: string) => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState(props.initialName);
  const settledRef = useRef(false);
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);
  const finish = (commit: boolean) => {
    if (settledRef.current) return;
    settledRef.current = true;
    const trimmed = name.trim();
    if (commit && trimmed.length > 0) props.onSubmit(trimmed);
    else props.onCancel();
  };
  const onKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter") {
      event.preventDefault();
      finish(true);
    } else if (event.key === "Escape") {
      event.preventDefault();
      finish(false);
    }
  };
  return (
    <input
      ref={inputRef}
      aria-label={props.ariaLabel}
      value={name}
      maxLength={80}
      placeholder={props.placeholder}
      onChange={(event) => setName(readTypedSectionName(event))}
      onKeyDown={onKeyDown}
      onBlur={() => finish(true)}
      className="h-6 min-w-0 flex-1 rounded border border-ring bg-background px-1.5 text-xs font-medium text-foreground outline-none"
    />
  );
}

function AddSectionRow(props: { onClick: () => void }) {
  return (
    <li className="mx-0.5 h-8 list-none" data-sections-end>
      <button
        type="button"
        onClick={props.onClick}
        data-testid="sidebar-add-section"
        className="flex h-full w-full cursor-pointer items-center gap-2 rounded-md px-2 text-left text-xs font-medium text-sidebar-muted-foreground/60 hover:bg-sidebar-row-hover hover:text-sidebar-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
      >
        <PlusIcon aria-hidden className="size-3 shrink-0" />
        New section
      </button>
    </li>
  );
}

function NewSectionRow(props: {
  threadCount: number;
  onSubmit: (name: string) => void;
  onCancel: () => void;
}) {
  return (
    <li className="mx-0.5 h-8 list-none" data-testid="sidebar-new-section-row" data-sections-end>
      <div className="flex h-full items-center px-2">
        <SectionNameInput
          initialName=""
          ariaLabel={newSectionTitle(props.threadCount)}
          placeholder={
            props.threadCount === 0 ? "Section name" : `${newSectionTitle(props.threadCount)}…`
          }
          onSubmit={props.onSubmit}
          onCancel={props.onCancel}
        />
      </div>
    </li>
  );
}
