import { planPinnedReorder } from "@t3tools/client-runtime/state/thread-sort";
import type { ThreadSection, ThreadSectionId, ThreadSections } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

/**
 * Pure rules for user-defined thread sections: catalog edits, grouping the
 * sidebar by section, and resolving drags in the Sections view. Membership
 * lives on each thread (`sectionId`); the catalog lives in the primary
 * environment's server settings.
 */

export const SidebarViewMode = Schema.Literals(["status", "sections"]);
export type SidebarViewMode = typeof SidebarViewMode.Type;

/** Group id for General: threads without a (known) section. */
export const GENERAL_SECTION_GROUP_ID = "__general__";

// ── Catalog ────────────────────────────────────────────────────────────

/**
 * Sections in display order (names break ties for hand-edited settings), with
 * names normalized. Names saved before capitalization existed, or edited by
 * hand, read capitalized, and every catalog write saves them that way.
 */
export function readThreadSections(sections: ThreadSections): ThreadSection[] {
  return sections
    .map((section) => {
      const name = normalizeSectionName(section.name);
      return name === section.name ? section : { ...section, name };
    })
    .toSorted((left, right) => left.order - right.order || left.name.localeCompare(right.name));
}

/**
 * Collapses whitespace and capitalizes the first letter. A first word that
 * already mixes case on purpose ("iOS", "macOS", "eBay") is kept as typed.
 */
export function normalizeSectionName(name: string): string {
  const collapsed = name.trim().replace(/\s+/g, " ");
  const firstWord = collapsed.split(" ", 1)[0] ?? "";
  const rest = firstWord.slice(1);
  if (rest !== rest.toLocaleLowerCase()) return collapsed;
  return collapsed.charAt(0).toLocaleUpperCase() + collapsed.slice(1);
}

/**
 * Capitalizes a name's first letter as it is typed. Turning the first letter
 * lowercase by hand (for "mRNA") only flips its case, and is kept.
 */
export function capitalizeTypedSectionName(previous: string, next: string): string {
  const first = next.charAt(0);
  const upper = first.toLocaleUpperCase();
  if (first === upper) return next;
  if (previous.length > 0 && previous.charAt(0).toLocaleLowerCase() === first) return next;
  return upper + next.slice(1);
}

/** Case- and accent-insensitive: "Research" and "research" are one section. */
export function findSectionByName(
  sections: ThreadSections,
  name: string,
): ThreadSection | undefined {
  const normalized = normalizeSectionName(name);
  return sections.find(
    (section) => section.name.localeCompare(normalized, undefined, { sensitivity: "base" }) === 0,
  );
}

function renumber(sections: readonly ThreadSection[]): ThreadSection[] {
  return sections.map((section, order) =>
    section.order === order ? section : { ...section, order },
  );
}

/** Appends a section, or returns the existing one with the same name. */
export function catalogWithCreatedSection(
  sections: ThreadSections,
  name: string,
  id: ThreadSectionId,
): {
  readonly catalog: ThreadSection[];
  readonly section: ThreadSection;
  readonly created: boolean;
} {
  const ordered = readThreadSections(sections);
  const existing = findSectionByName(ordered, name);
  if (existing) return { catalog: ordered, section: existing, created: false };
  const section: ThreadSection = {
    id,
    name: normalizeSectionName(name),
    order: ordered.length,
  };
  return { catalog: renumber([...ordered, section]), section, created: true };
}

export type CatalogRenameResult =
  | { readonly kind: "renamed"; readonly catalog: ThreadSection[] }
  | { readonly kind: "unchanged" }
  | { readonly kind: "duplicate"; readonly existing: ThreadSection }
  | { readonly kind: "missing" };

export function catalogWithRenamedSection(
  sections: ThreadSections,
  sectionId: string,
  name: string,
): CatalogRenameResult {
  const ordered = readThreadSections(sections);
  const index = ordered.findIndex((section) => section.id === sectionId);
  if (index < 0) return { kind: "missing" };
  const normalized = normalizeSectionName(name);
  const current = ordered[index]!;
  if (current.name === normalized) return { kind: "unchanged" };
  const existing = findSectionByName(
    ordered.filter((section) => section.id !== sectionId),
    normalized,
  );
  if (existing) return { kind: "duplicate", existing };
  const catalog = [...ordered];
  catalog[index] = { ...current, name: normalized };
  return { kind: "renamed", catalog };
}

/**
 * The catalog plus where General sits among the sections. General is not a
 * catalog entry: it holds every thread without a known section, and its
 * position is stored separately as the number of sections before it.
 */
export interface SectionLayout {
  readonly catalog: ThreadSection[];
  readonly generalIndex: number;
}

function clampGeneralIndex(generalIndex: number, sectionCount: number): number {
  return Math.max(0, Math.min(generalIndex, sectionCount));
}

/** Group ids in display order, General included. */
export function sectionLayoutOrder(
  sections: readonly ThreadSection[],
  generalIndex: number,
): string[] {
  const ids: string[] = sections.map((section) => section.id);
  ids.splice(clampGeneralIndex(generalIndex, ids.length), 0, GENERAL_SECTION_GROUP_ID);
  return ids;
}

export interface RemovedSection {
  readonly section: ThreadSection;
  readonly index: number;
  /** General's position before the removal, restored with the section. */
  readonly generalIndex: number;
}

/** Threads keep the removed id, so restoring the entry brings them back. */
export function catalogWithoutSection(
  sections: ThreadSections,
  generalIndex: number,
  sectionId: string,
): SectionLayout & { readonly removed: RemovedSection | null } {
  const ordered = readThreadSections(sections);
  const general = clampGeneralIndex(generalIndex, ordered.length);
  const index = ordered.findIndex((section) => section.id === sectionId);
  if (index < 0) return { catalog: ordered, generalIndex: general, removed: null };
  return {
    catalog: renumber(ordered.filter((section) => section.id !== sectionId)),
    // General keeps its neighbors when a section above it goes away.
    generalIndex: index < general ? general - 1 : general,
    removed: { section: ordered[index]!, index, generalIndex: general },
  };
}

export function catalogWithRestoredSection(
  sections: ThreadSections,
  removed: RemovedSection,
): SectionLayout {
  const ordered = readThreadSections(sections).filter(
    (section) => section.id !== removed.section.id,
  );
  // A restored section starts a fresh empty-section clock.
  const { emptySince: _emptySince, ...section } = removed.section;
  ordered.splice(Math.min(removed.index, ordered.length), 0, section);
  return {
    catalog: renumber(ordered),
    generalIndex: clampGeneralIndex(removed.generalIndex, ordered.length),
  };
}

/**
 * One pass of the optional empty-section cleanup. `occupied` holds every
 * section id a sidebar thread (active, pinned, snoozed or settled) points to.
 * Empty sections get stamped, occupied ones lose their stamp, and sections
 * stamped at least `afterDays` ago are removed. Null when nothing changes.
 */
export function sweepEmptySections(input: {
  readonly sections: readonly ThreadSection[];
  readonly generalIndex: number;
  readonly occupied: ReadonlySet<string>;
  readonly now: Date;
  readonly afterDays: number;
}): (SectionLayout & { readonly removed: RemovedSection[] }) | null {
  const ordered = readThreadSections(input.sections);
  const general = clampGeneralIndex(input.generalIndex, ordered.length);
  const cutoff = input.now.getTime() - input.afterDays * 24 * 60 * 60 * 1000;
  const kept: ThreadSection[] = [];
  const removed: RemovedSection[] = [];
  let changed = false;
  ordered.forEach((section, index) => {
    if (input.occupied.has(section.id)) {
      if (section.emptySince === undefined) {
        kept.push(section);
      } else {
        const { emptySince: _emptySince, ...rest } = section;
        kept.push(rest);
        changed = true;
      }
      return;
    }
    if (section.emptySince === undefined) {
      kept.push({ ...section, emptySince: input.now.toISOString() });
      changed = true;
      return;
    }
    if (Date.parse(section.emptySince) <= cutoff) {
      removed.push({ section, index, generalIndex: general });
      changed = true;
      return;
    }
    kept.push(section);
  });
  if (!changed) return null;
  return {
    catalog: renumber(kept),
    generalIndex: general - removed.filter((entry) => entry.index < general).length,
    removed,
  };
}

/** Applies a dragged group order (General included) to the catalog. */
export function layoutFromGroupOrder(
  sections: ThreadSections,
  orderedGroupIds: readonly string[],
): SectionLayout {
  const byId = new Map(sections.map((section) => [section.id as string, section]));
  const ordered = orderedGroupIds.flatMap((id) => {
    const section = byId.get(id);
    return section ? [section] : [];
  });
  const generalAt = orderedGroupIds.indexOf(GENERAL_SECTION_GROUP_ID);
  const generalIndex =
    generalAt < 0
      ? ordered.length
      : orderedGroupIds.slice(0, generalAt).filter((id) => byId.has(id)).length;
  // Sections created concurrently elsewhere keep their place at the end.
  const listed = new Set(orderedGroupIds);
  const rest = readThreadSections(sections).filter((section) => !listed.has(section.id));
  return { catalog: renumber([...ordered, ...rest]), generalIndex };
}

// ── Grouping ───────────────────────────────────────────────────────────

export interface SectionGroup<T> {
  /** Section id, or GENERAL_SECTION_GROUP_ID. */
  readonly id: string;
  readonly section: ThreadSection | null;
  readonly threads: readonly T[];
}

/** The group a thread renders in. Unknown ids (a removed section) read as Other. */
export function sectionGroupIdOf(
  thread: { readonly sectionId?: string | null | undefined },
  knownSectionIds: ReadonlySet<string>,
): string {
  return thread.sectionId != null && knownSectionIds.has(thread.sectionId)
    ? thread.sectionId
    : GENERAL_SECTION_GROUP_ID;
}

/**
 * Pinned and active threads grouped by section, with General (threads without
 * a section, including new ones) at its stored position. Every section shows,
 * even empty, since each is a drop target. Each group keeps the Status view's
 * order: pinned first, then active. Snoozed and settled threads stay on their
 * own shelves.
 */
export function groupThreadsBySection<
  T extends { readonly sectionId?: string | null | undefined },
>(input: {
  readonly sections: readonly ThreadSection[];
  readonly generalIndex: number;
  readonly pinned: readonly T[];
  readonly active: readonly T[];
}): SectionGroup<T>[] {
  const known = new Set<string>(input.sections.map((section) => section.id));
  const members = new Map<string, T[]>();
  for (const thread of [...input.pinned, ...input.active]) {
    const groupId = sectionGroupIdOf(thread, known);
    const list = members.get(groupId);
    if (list) list.push(thread);
    else members.set(groupId, [thread]);
  }
  const bySection = new Map(input.sections.map((section) => [section.id as string, section]));
  return sectionLayoutOrder(input.sections, input.generalIndex).map((id) => ({
    id,
    section: bySection.get(id) ?? null,
    threads: members.get(id) ?? [],
  }));
}

// ── Drag and drop ──────────────────────────────────────────────────────

const HEADER_PREFIX = "scient-section-header-";

/** Colon-free, so it can never collide with a scoped thread key. */
export function sectionHeaderItemId(groupId: string): string {
  return `${HEADER_PREFIX}${groupId}`;
}

export function sectionGroupIdFromHeaderItemId(itemId: string): string | null {
  return itemId.startsWith(HEADER_PREFIX) ? itemId.slice(HEADER_PREFIX.length) : null;
}

export type SectionsLifecycle = "pinned" | "active" | "snoozed" | "settled";

export type SectionsListItem =
  | { readonly kind: "header"; readonly id: string; readonly groupId: string }
  | {
      readonly kind: "thread";
      readonly id: string;
      readonly lifecycle: SectionsLifecycle;
      /** The group the row renders in; null on the snoozed and settled shelves. */
      readonly groupId: string | null;
    }
  | { readonly kind: "shelf"; readonly id: string; readonly shelf: "snoozed" | "settled" };

export type SectionsDropTarget =
  | { readonly kind: "section"; readonly groupId: string; readonly order: readonly string[] }
  | { readonly kind: "settled" };

/**
 * Where a lifted row lands if dropped over `overId`: the section whose header
 * precedes the slot (with that section's rows in their new order), the settled
 * shelf, or nowhere (the snoozed shelf is never a destination).
 */
export function resolveSectionsDropTarget(
  items: readonly SectionsListItem[],
  activeId: string,
  overId: string,
): SectionsDropTarget | null {
  const activeIndex = items.findIndex((item) => item.id === activeId);
  const overIndex = items.findIndex((item) => item.id === overId);
  const active = items[activeIndex];
  if (activeIndex === -1 || overIndex === -1 || active?.kind !== "thread") return null;
  const moved = items.filter((_, index) => index !== activeIndex);
  moved.splice(overIndex, 0, active);
  let owner: SectionsListItem | null = null;
  for (let index = overIndex - 1; index >= 0; index -= 1) {
    const item = moved[index]!;
    if (item.kind !== "thread") {
      owner = item;
      break;
    }
  }
  // Above the first header: the top of the first section.
  if (owner === null) owner = moved.find((item) => item.kind !== "thread") ?? null;
  if (owner === null) return null;
  if (owner.kind === "shelf") return owner.shelf === "settled" ? { kind: "settled" } : null;
  const order: string[] = [];
  const start = moved.indexOf(owner);
  for (let index = start + 1; index < moved.length; index += 1) {
    const item = moved[index]!;
    if (item.kind !== "thread") break;
    order.push(item.id);
  }
  return { kind: "section", groupId: owner.groupId, order };
}

export interface SectionsDragSource {
  readonly key: string;
  readonly lifecycle: SectionsLifecycle;
  readonly groupId: string | null;
  /** Snoozed and settled threads can keep a pin beneath the shelf. */
  readonly pinned: boolean;
}

export type SectionsThreadDropPlan =
  | { readonly kind: "none" }
  | { readonly kind: "settle" }
  | {
      readonly kind: "move";
      /** Present when the thread changes section; null files it under Other. */
      readonly sectionId?: ThreadSectionId | null;
      readonly unsettle: boolean;
      readonly unsnooze: boolean;
      /** Which order key the assignments write. */
      readonly group: "pinned" | "active";
      readonly assignments: ReadonlyArray<{ readonly id: string; readonly orderKey: string }>;
    };

/**
 * A drop never changes a thread's pin: within a section pinned rows stay
 * above active ones, so a row lands at its dropped position among the rows
 * of its own kind. Keys follow the Status view's single-write rule, with
 * every other thread's key reserved.
 */
export function planSectionsThreadDrop(input: {
  readonly source: SectionsDragSource;
  readonly target: SectionsDropTarget;
  /** The target group's rows before the drop, in displayed order. */
  readonly targetOrderBefore: readonly string[];
  readonly lifecycleByKey: ReadonlyMap<string, SectionsLifecycle>;
  readonly pinnedKeysById: ReadonlyMap<string, string | null | undefined>;
  readonly activeKeysById: ReadonlyMap<string, string | null | undefined>;
  readonly toSectionId: (groupId: string) => ThreadSectionId | null;
}): SectionsThreadDropPlan {
  const { source, target } = input;
  if (target.kind === "settled") {
    return source.lifecycle === "settled" ? { kind: "none" } : { kind: "settle" };
  }
  const unsettle = source.lifecycle === "settled";
  const unsnooze = source.lifecycle === "snoozed";
  // Settling clears the pin, so an un-settled thread joins the active rows.
  const group = source.pinned && !unsettle ? "pinned" : "active";
  const inGroup = (key: string) => {
    if (key === source.key) return true;
    const lifecycle = input.lifecycleByKey.get(key);
    return group === "pinned" ? lifecycle === "pinned" : lifecycle === "active";
  };
  const orderedIds = target.order.filter(inGroup);
  const previousIds = input.targetOrderBefore.filter(inGroup);
  const sectionChanged = source.groupId !== target.groupId;
  const lifecycleChanged = unsettle || unsnooze;
  const orderChanged =
    orderedIds.length !== previousIds.length ||
    orderedIds.some((key, index) => key !== previousIds[index]);
  if (!sectionChanged && !lifecycleChanged && !orderChanged) return { kind: "none" };
  const assignments = orderChanged
    ? planPinnedReorder({
        orderedIds,
        keysById: group === "pinned" ? input.pinnedKeysById : input.activeKeysById,
        movedId: source.key,
      })
    : [];
  return {
    kind: "move",
    ...(sectionChanged ? { sectionId: input.toSectionId(target.groupId) } : {}),
    unsettle,
    unsnooze,
    group,
    assignments,
  };
}

/** A section's rendered extent (header plus rows), in viewport pixels. */
export interface SectionBlock {
  readonly groupId: string;
  readonly top: number;
  readonly height: number;
}

/**
 * Group order while dragging one section: it lands before the first other
 * section whose middle is below the pointer. Blocks are where sections were
 * when the drag began, so the answer never depends on where they are sliding.
 */
export function resolveSectionDragOrder(
  blocks: readonly SectionBlock[],
  draggedGroupId: string,
  pointerY: number,
): string[] {
  const others = blocks.filter((block) => block.groupId !== draggedGroupId);
  const index = others.filter((block) => block.top + block.height / 2 < pointerY).length;
  const order = others.map((block) => block.groupId);
  order.splice(index, 0, draggedGroupId);
  return order;
}

/** How far each block slides so `order` stacks down from the first block's top. */
export function sectionShifts(
  blocks: readonly SectionBlock[],
  order: readonly string[],
): Map<string, number> {
  const byId = new Map(blocks.map((block) => [block.groupId, block]));
  const shifts = new Map<string, number>();
  let top = blocks[0]?.top ?? 0;
  for (const groupId of order) {
    const block = byId.get(groupId);
    if (!block) continue;
    shifts.set(groupId, top - block.top);
    top += block.height;
  }
  return shifts;
}
