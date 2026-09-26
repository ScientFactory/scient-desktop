import {
  closestCenter,
  DndContext,
  type DragEndEvent,
  type DragOverEvent,
  DragOverlay,
  type DragStartEvent,
  MeasuringStrategy,
  PointerSensor,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import { restrictToFirstScrollableAncestor, restrictToVerticalAxis } from "@dnd-kit/modifiers";
import { SortableContext, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  type AtomCommandResult,
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import { type ScopedThreadRef, type ThreadSection, ThreadSectionId } from "@t3tools/contracts";
import { ChevronRightIcon, EllipsisIcon, PlusIcon } from "lucide-react";
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
import { readEnvironmentSupportsSections, useThreadSectionActions } from "./actions";
import {
  OTHER_SECTION_GROUP_ID,
  type SectionGroup,
  type SectionsDropTarget,
  type SectionsLifecycle,
  type SectionsListItem,
  planSectionsThreadDrop,
  resolveSectionHeaderDrop,
  resolveSectionsDropTarget,
  sectionGroupIdFromHeaderItemId,
  sectionHeaderItemId,
} from "./logic";

type Shell = EnvironmentThreadShell;

const keyOf = (thread: Shell) => scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id));

/** The subset of a sortable bag a thread row applies to its root. */
export type SectionsRowSortable = Pick<
  ReturnType<typeof useSortable>,
  "listeners" | "setNodeRef" | "transform" | "transition" | "isDragging"
>;

export interface SidebarSectionsViewProps {
  readonly groups: readonly SectionGroup<Shell>[];
  /** Label Other as "Other" only once sections exist. */
  readonly hasSections: boolean;
  readonly collapsedGroupIds: ReadonlySet<string>;
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
  readonly onNewThreadInSection: (section: ThreadSection) => void;
  readonly renamingSectionId: string | null;
  readonly onRenamingSectionChange: (sectionId: string | null) => void;
  readonly onRenameSection: (sectionId: string, name: string) => void;
  /** Inline "New section" row; null when not creating. */
  readonly creatingSection: { readonly onSubmit: (name: string) => void } | null;
  readonly onCancelCreateSection: () => void;
}

type DragState =
  | { readonly kind: "thread"; readonly key: string; readonly target: SectionsDropTarget | null }
  | { readonly kind: "section"; readonly groupId: string };

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
      if (collapsedGroupIds.has(group.id)) continue;
      for (const thread of group.threads) {
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
    props.showSnoozedShelf,
    settledThreads,
    shelfMarkerId,
    snoozedThreads,
  ]);

  // A held layout expires on its own; writes finishing release it sooner.
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
    return held.ids.map((id) => byId.get(id)!);
  }, [canonicalItems, held]);
  const holding = items !== canonicalItems;

  // While a section header is lifted, its rows fold away so headers move as blocks.
  const visibleItems = useMemo(
    () => (drag?.kind === "section" ? items.filter((item) => item.kind !== "thread") : items),
    [drag, items],
  );
  const sortableIds = useMemo(() => visibleItems.map((item) => item.id), [visibleItems]);

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

  const handleDragStart = useCallback((event: DragStartEvent) => {
    const id = String(event.active.id);
    const groupId = sectionGroupIdFromHeaderItemId(id);
    setDrag(
      groupId !== null ? { kind: "section", groupId } : { kind: "thread", key: id, target: null },
    );
  }, []);

  const handleDragOver = useCallback(
    (event: DragOverEvent) => {
      const activeId = String(event.active.id);
      if (sectionGroupIdFromHeaderItemId(activeId) !== null) return;
      const target = event.over
        ? resolveSectionsDropTarget(items, activeId, String(event.over.id))
        : null;
      setDrag((current) =>
        current?.kind === "thread" && current.key === activeId ? { ...current, target } : current,
      );
    },
    [items],
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
    (activeGroupId: string, overId: string) => {
      // Past the last header (over a shelf) means the end of the list.
      const overGroupId = sectionGroupIdFromHeaderItemId(overId) ?? OTHER_SECTION_GROUP_ID;
      const orderedGroupIds = groups.map((group) => group.id);
      const next = resolveSectionHeaderDrop(orderedGroupIds, activeGroupId, overGroupId);
      if (next === null) return;
      const nextHeaderIds = new Set(next.map(sectionHeaderItemId));
      // Hold the full layout in the new section order.
      const blocks = new Map<string, string[]>();
      let current: string | null = null;
      const tail: string[] = [];
      for (const item of items) {
        if (item.kind === "header") current = item.groupId;
        else if (item.kind === "shelf") current = null;
        if (current !== null && nextHeaderIds.has(sectionHeaderItemId(current))) {
          const block = blocks.get(current) ?? [];
          block.push(item.id);
          blocks.set(current, block);
        } else {
          tail.push(item.id);
        }
      }
      setHeld({
        ids: [...next.flatMap((id) => blocks.get(id) ?? []), ...tail],
        expiresAt: Date.now() + HELD_LAYOUT_MS,
      });
      onReorderSections(next);
    },
    [groups, items, onReorderSections],
  );

  const dropThread = useCallback(
    (activeKey: string, overId: string) => {
      const thread = threadByKey.get(activeKey);
      const source = items.find((item) => item.id === activeKey);
      const target = resolveSectionsDropTarget(items, activeKey, overId);
      if (thread === undefined || source?.kind !== "thread" || target === null) return;
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
          groupId === OTHER_SECTION_GROUP_ID ? null : ThreadSectionId.make(groupId),
      });
      const threadRef = scopeThreadRef(thread.environmentId, thread.id);
      if (plan.kind === "none") return;
      if (plan.kind === "settle") {
        onSettleThread(threadRef);
        return;
      }
      if (target.kind === "section") {
        // Show the drop where it landed while the writes travel.
        const overIndex = items.findIndex((item) => item.id === overId);
        const ids = items.map((item) => item.id).filter((id) => id !== activeKey);
        ids.splice(overIndex, 0, activeKey);
        setHeld({ ids, expiresAt: Date.now() + HELD_LAYOUT_MS });
      }
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
        for (const assignment of plan.assignments) {
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
      activeKeysById,
      items,
      lifecycleByKey,
      moveThreadsToSection,
      onSettleThread,
      orderOfGroup,
      pinnedKeysById,
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
      if (current === null || event.over === null) return;
      if (current.kind === "section") dropSection(current.groupId, String(event.over.id));
      else dropThread(current.key, String(event.over.id));
    },
    [drag, dropSection, dropThread],
  );

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

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCenter}
      measuring={{ droppable: { strategy: MeasuringStrategy.Always } }}
      modifiers={[restrictToVerticalAxis, restrictToFirstScrollableAncestor]}
      onDragStart={handleDragStart}
      onDragOver={handleDragOver}
      onDragEnd={handleDragEnd}
      onDragCancel={() => setDrag(null)}
    >
      <SortableContext items={sortableIds} strategy={verticalListSortingStrategy}>
        <ul role="list" className="relative flex flex-1 flex-col gap-px">
          {props.leading}
          {props.creatingSection !== null ? (
            <NewSectionRow
              onSubmit={props.creatingSection.onSubmit}
              onCancel={props.onCancelCreateSection}
            />
          ) : null}
          {visibleItems.map((item) => {
            if (item.kind === "header") {
              const group = groupById.get(item.groupId);
              if (group === undefined) return null;
              return (
                <SectionHeaderRow
                  key={item.id}
                  itemId={item.id}
                  group={group}
                  label={group.section?.name ?? (props.hasSections ? "Other" : "Threads")}
                  collapsed={collapsedGroupIds.has(group.id)}
                  isDropTarget={dragTarget?.kind === "section" && dragTarget.groupId === group.id}
                  hidden={drag?.kind === "section" && drag.groupId === group.id}
                  renaming={group.section !== null && props.renamingSectionId === group.id}
                  onToggle={() => props.onToggleGroup(group.id)}
                  onStartRename={() => props.onRenamingSectionChange(group.id)}
                  onCancelRename={() => props.onRenamingSectionChange(null)}
                  onRename={(name) => props.onRenameSection(group.id, name)}
                  onMenu={(position) => {
                    if (group.section) props.onSectionMenu(group.section, position);
                  }}
                  onNewThread={() => {
                    if (group.section) props.onNewThreadInSection(group.section);
                  }}
                />
              );
            }
            if (item.kind === "shelf") {
              return (
                <Fragment key={item.id}>
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
                    sortable,
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
          <div className="flex h-8 items-center gap-1.5 rounded-md bg-sidebar-row-active px-2 text-xs font-medium text-sidebar-foreground shadow-sm">
            <ChevronRightIcon aria-hidden className="size-3 shrink-0" />
            <span className="truncate">{liftedGroup.section?.name}</span>
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
  hidden: boolean;
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
  const { attributes, listeners, setNodeRef, transform, transition } = useSortable({
    id: props.itemId,
    disabled: { draggable: !isUserSection || props.renaming },
  });
  const runningCount = props.collapsed
    ? group.threads.filter((thread) => thread.session?.status === "running").length
    : 0;
  const openMenu = (event: { clientX: number; clientY: number; preventDefault: () => void }) => {
    event.preventDefault();
    props.onMenu({ x: event.clientX, y: event.clientY });
  };
  return (
    <li
      ref={setNodeRef}
      data-thread-selection-safe
      data-testid={`sidebar-thread-section-${group.id}`}
      className={cn("list-none pt-1.5 first:pt-0", props.hidden && "opacity-0")}
      style={{ transform: CSS.Translate.toString(transform), transition }}
    >
      <div
        className={cn(
          "group/section-header flex h-7 items-center gap-1 rounded-md pr-1 pl-2 text-xs font-medium text-sidebar-muted-foreground",
          !props.renaming && "hover:bg-sidebar-row-hover hover:text-sidebar-foreground",
          props.isDropTarget && "bg-primary/5 text-primary",
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
            className="flex h-full min-w-0 flex-1 cursor-pointer items-center gap-1.5 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
            {...attributes}
            {...listeners}
          >
            <ChevronRightIcon
              aria-hidden
              className={cn(
                "size-3 shrink-0 transition-transform",
                !props.collapsed && "rotate-90",
              )}
            />
            <span className="min-w-0 truncate">{props.label}</span>
            {runningCount > 0 ? (
              <span
                aria-label={`${runningCount} working`}
                className="size-1.5 shrink-0 rounded-full bg-primary"
              />
            ) : null}
          </button>
        )}
        {props.renaming ? null : (
          <span className="relative flex h-5 shrink-0 items-center justify-end">
            <span
              className={cn(
                "px-1 text-2xs tabular-nums opacity-70",
                isUserSection &&
                  "group-focus-within/section-header:opacity-0 group-hover/section-header:opacity-0",
              )}
            >
              {group.threads.length}
            </span>
            {isUserSection ? (
              <span className="pointer-events-none absolute right-0 flex items-center opacity-0 group-focus-within/section-header:pointer-events-auto group-focus-within/section-header:opacity-100 group-hover/section-header:pointer-events-auto group-hover/section-header:opacity-100">
                <HeaderIconButton label="New thread in section" onClick={props.onNewThread}>
                  <PlusIcon className="size-3.5" />
                </HeaderIconButton>
                <HeaderIconButton
                  label="Section actions"
                  onClick={(event) => {
                    const rect = event.currentTarget.getBoundingClientRect();
                    props.onMenu({ x: rect.left, y: rect.bottom + 4 });
                  }}
                >
                  <EllipsisIcon className="size-3.5" />
                </HeaderIconButton>
              </span>
            ) : null}
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
            className="inline-flex size-5 cursor-pointer items-center justify-center rounded text-sidebar-muted-foreground hover:bg-sidebar-row-active hover:text-sidebar-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
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
      onChange={(event) => setName(event.currentTarget.value)}
      onKeyDown={onKeyDown}
      onBlur={() => finish(true)}
      className="h-6 min-w-0 flex-1 rounded border border-ring bg-background px-1.5 text-xs font-medium text-foreground outline-none"
    />
  );
}

function NewSectionRow(props: { onSubmit: (name: string) => void; onCancel: () => void }) {
  return (
    <li className="list-none pb-1.5" data-testid="sidebar-new-section-row">
      <div className="flex h-7 items-center gap-1.5 px-2">
        <ChevronRightIcon aria-hidden className="size-3 shrink-0 rotate-90 opacity-60" />
        <SectionNameInput
          initialName=""
          ariaLabel="New section name"
          placeholder="Section name"
          onSubmit={props.onSubmit}
          onCancel={props.onCancel}
        />
      </div>
    </li>
  );
}

/** Whether every thread's server accepts section writes. */
export function threadsSupportSections(threads: readonly Shell[]): boolean {
  return threads.every((thread) => readEnvironmentSupportsSections(thread.environmentId));
}
