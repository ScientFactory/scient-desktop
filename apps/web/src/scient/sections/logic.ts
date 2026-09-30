import { planPinnedReorder } from "@t3tools/client-runtime/state/thread-sort";
import type {
  ThreadSection,
  ThreadSectionId,
  ThreadSectionProjectRef,
  ThreadSections,
} from "@t3tools/contracts";
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
 * Capitalizes the first letter, unless the first word already mixes case on
 * purpose ("iOS", "mRNA", "macOS"), which is kept as written. The same rule
 * runs as a name is typed and when it is saved, so the field never shows a
 * name that saves differently.
 */
export function capitalizeSectionName(name: string): string {
  const firstWord = name.trimStart().split(/\s/, 1)[0] ?? "";
  const rest = firstWord.slice(1);
  if (rest !== rest.toLocaleLowerCase()) return name;
  const start = name.length - name.trimStart().length;
  return name.slice(0, start) + name.charAt(start).toLocaleUpperCase() + name.slice(start + 1);
}

/** The saved form of a name: whitespace collapsed, then capitalized. */
export function normalizeSectionName(name: string): string {
  return capitalizeSectionName(name.trim().replace(/\s+/g, " "));
}

/** Case- and accent-insensitive: "Research" and "research" are one section. */
function findSectionByName(sections: ThreadSections, name: string): ThreadSection | undefined {
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

/** Names what a new section is for, so threads the user picked are never silently dropped. */
export function newSectionTitle(threadCount: number): string {
  if (threadCount === 1) return "New section for this thread";
  return threadCount > 1 ? `New section for ${threadCount} threads` : "New section";
}

/** What a new section records about where it was made (see `ThreadSection`). */
export interface SectionOrigin {
  /** Environments of the threads filed into it on creation. */
  readonly environmentIds?: readonly string[];
  readonly createdInProjects?: readonly ThreadSectionProjectRef[];
}

/**
 * Appends a section, or returns the existing one with the same name.
 * `changed` is false when the catalog needs no write: the name exists and
 * already records everything in `origin`.
 */
export function catalogWithCreatedSection(
  sections: ThreadSections,
  name: string,
  id: ThreadSectionId,
  origin: SectionOrigin = {},
): {
  readonly catalog: ThreadSection[];
  readonly section: ThreadSection;
  readonly created: boolean;
  readonly changed: boolean;
} {
  const ordered = readThreadSections(sections);
  const existing = findSectionByName(ordered, name);
  if (existing) {
    // Reusing a name still makes the section show where it was asked for.
    const recorded = withSectionOrigin(existing, origin);
    if (recorded === existing) {
      return { catalog: ordered, section: existing, created: false, changed: false };
    }
    const catalog = ordered.map((section) => (section === existing ? recorded : section));
    return { catalog, section: recorded, created: false, changed: true };
  }
  const section = withSectionOrigin(
    { id, name: normalizeSectionName(name), order: ordered.length },
    origin,
  );
  return { catalog: renumber([...ordered, section]), section, created: true, changed: true };
}

/** `section` with `origin` merged in; the same object when nothing is new. */
function withSectionOrigin(section: ThreadSection, origin: SectionOrigin): ThreadSection {
  const environmentIds = mergeEnvironmentIds(section.environmentIds, origin.environmentIds ?? []);
  const createdInProjects = mergeProjectRefs(
    section.createdInProjects,
    origin.createdInProjects ?? [],
  );
  if (environmentIds === null && createdInProjects === null) return section;
  // Recording threads also means the section is no longer empty.
  const { emptySince: _emptySince, ...occupied } = section;
  return {
    ...(environmentIds === null ? section : occupied),
    ...(environmentIds === null ? {} : { environmentIds }),
    ...(createdInProjects === null ? {} : { createdInProjects }),
  };
}

function projectRefKey(ref: ThreadSectionProjectRef): string {
  return `${ref.environmentId}:${ref.projectId}`;
}

/** `recorded` plus any new refs, or null when nothing is new. */
function mergeProjectRefs(
  recorded: readonly ThreadSectionProjectRef[] | undefined,
  seen: readonly ThreadSectionProjectRef[],
): ThreadSectionProjectRef[] | null {
  const merged = [...(recorded ?? [])];
  const keys = new Set(merged.map(projectRefKey));
  for (const ref of seen) {
    if (keys.has(projectRefKey(ref))) continue;
    keys.add(projectRefKey(ref));
    merged.push({ environmentId: ref.environmentId, projectId: ref.projectId });
  }
  return merged.length === (recorded ?? []).length ? null : merged;
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
 * Which environments hold threads in each section, as one client sees them:
 * section id → environment ids.
 */
export type SectionOccupancy = ReadonlyMap<string, ReadonlySet<string>>;

/**
 * Records that `environmentIds` hold threads in `sectionId`. Null when they
 * are all recorded already and no empty stamp needs clearing (or the section is gone).
 */
export function catalogWithEnvironments(
  sections: ThreadSections,
  sectionId: string,
  environmentIds: readonly string[],
): ThreadSection[] | null {
  const ordered = readThreadSections(sections);
  const index = ordered.findIndex((section) => section.id === sectionId);
  if (index < 0) return null;
  const section = ordered[index]!;
  const merged = mergeEnvironmentIds(section.environmentIds, environmentIds);
  if (merged === null && section.emptySince == null) return null;
  const { emptySince: _emptySince, ...occupied } = section;
  ordered[index] = { ...occupied, environmentIds: merged ?? section.environmentIds ?? [] };
  return ordered;
}

/** `recorded` plus any new ids, or null when nothing is new. */
function mergeEnvironmentIds(
  recorded: readonly string[] | undefined,
  seen: Iterable<string>,
): string[] | null {
  const merged = [...(recorded ?? [])];
  for (const id of seen) if (!merged.includes(id)) merged.push(id);
  return merged.length === (recorded ?? []).length ? null : merged;
}

/**
 * One pass of the optional empty-section cleanup. `occupancy` is what this
 * client sees: which environments hold sidebar threads (active, pinned,
 * snoozed or settled) in each section.
 *
 * Seeing a section occupied is always trustworthy: it records those
 * environments on the section and clears its empty stamp. Seeing it empty is
 * not, because no client sees every environment. So a section is judged only
 * when `visibleEnvironmentIds` is given and includes every environment that
 * has held its threads: then it is stamped empty, or removed once stamped at
 * least `afterDays` ago. Pass null to only record occupancy. Null when nothing
 * changes.
 */
export function sweepEmptySections(input: {
  readonly sections: readonly ThreadSection[];
  readonly generalIndex: number;
  readonly occupancy: SectionOccupancy;
  /** Environments whose threads this client fully sees; null records only. */
  readonly visibleEnvironmentIds: ReadonlySet<string> | null;
  readonly now: Date;
  readonly afterDays: number;
}): (SectionLayout & { readonly removed: RemovedSection[] }) | null {
  const ordered = readThreadSections(input.sections);
  const general = clampGeneralIndex(input.generalIndex, ordered.length);
  const cutoff = input.now.getTime() - input.afterDays * 24 * 60 * 60 * 1000;
  const stamp = input.now.toISOString();
  const kept: ThreadSection[] = [];
  const removed: RemovedSection[] = [];
  let changed = false;
  ordered.forEach((original, index) => {
    const seen = input.occupancy.get(original.id);
    const environmentIds = seen ? mergeEnvironmentIds(original.environmentIds, seen) : null;
    let section = environmentIds === null ? original : { ...original, environmentIds };
    if (environmentIds !== null) changed = true;
    if (seen !== undefined && seen.size > 0) {
      if (section.emptySince !== undefined) {
        const { emptySince: _emptySince, ...rest } = section;
        section = rest;
        changed = true;
      }
      kept.push(section);
      return;
    }
    const visible = input.visibleEnvironmentIds;
    const judged =
      visible !== null && (section.environmentIds ?? []).every((id) => visible.has(id));
    if (!judged) {
      kept.push(section);
      return;
    }
    // Unstamped, or a stamp that doesn't parse (hand-edited settings): start the count.
    if (section.emptySince === undefined || Number.isNaN(Date.parse(section.emptySince))) {
      kept.push({ ...section, emptySince: stamp });
      changed = true;
      return;
    }
    if (Date.parse(section.emptySince) <= cutoff) {
      removed.push({ section: original, index, generalIndex: general });
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

/** The group a thread renders in. Unknown ids (a removed section) read as General. */
function sectionGroupIdOf(
  thread: { readonly sectionId?: string | null | undefined },
  knownSectionIds: ReadonlySet<string>,
): string {
  return thread.sectionId != null && knownSectionIds.has(thread.sectionId)
    ? thread.sectionId
    : GENERAL_SECTION_GROUP_ID;
}

/**
 * Which sections a sidebar scoped to one project lists (null: every section,
 * for All projects). A section is listed where it has threads: any
 * unarchived thread of the scope, on any shelf. A section with no threads
 * anywhere is listed in the projects it was created for, so a new section
 * stays in view to be filled; one without that record lists only under All
 * projects. "No threads anywhere" is only concluded when every environment
 * that has held its threads is loaded here; otherwise its threads may simply
 * not be visible yet.
 */
export function sectionIdsInProjectScope(input: {
  readonly sections: readonly ThreadSection[];
  /** The scope's `${environmentId}:${projectId}` keys; null for All projects. */
  readonly scopeProjectKeys: ReadonlySet<string> | null;
  /** Environments whose threads this client currently holds. */
  readonly loadedEnvironmentIds: ReadonlySet<string>;
  /** Every thread this client knows, across projects and shelves. */
  readonly threads: ReadonlyArray<{
    readonly environmentId: string;
    readonly projectId: string | null;
    readonly sectionId?: string | null | undefined;
    readonly archivedAt?: string | null | undefined;
  }>;
}): ReadonlySet<string> | null {
  const scope = input.scopeProjectKeys;
  if (scope === null) return null;
  const inScope = new Set<string>();
  const occupied = new Set<string>();
  for (const thread of input.threads) {
    if (thread.sectionId == null || thread.archivedAt != null) continue;
    occupied.add(thread.sectionId);
    if (scope.has(`${thread.environmentId}:${thread.projectId}`)) inScope.add(thread.sectionId);
  }
  for (const section of input.sections) {
    if (occupied.has(section.id)) continue;
    const allLoaded = (section.environmentIds ?? []).every((id) =>
      input.loadedEnvironmentIds.has(id),
    );
    if (!allLoaded) continue;
    if ((section.createdInProjects ?? []).some((ref) => scope.has(projectRefKey(ref)))) {
      inScope.add(section.id);
    }
  }
  return inScope;
}

/**
 * Applies a new order of the listed groups to the full layout order: hidden
 * sections keep their slots, and the listed ones fill the rest in the new
 * order. Without this, reordering in a project scope would push every hidden
 * section to the end.
 */
export function mergeListedGroupOrder(
  fullOrder: readonly string[],
  listedOrder: readonly string[],
): string[] {
  const listed = new Set(listedOrder);
  const queue = [...listedOrder];
  const merged = fullOrder.map((id) => (listed.has(id) ? queue.shift()! : id));
  return [...merged, ...queue];
}

/**
 * Pinned and active threads grouped by section, with General (threads without
 * a section, including new ones) at its stored position. Every listed section
 * shows, even empty, since each is a drop target; `listedSectionIds` (null:
 * all) hides the rest, see `sectionIdsInProjectScope`. Each group keeps the
 * Status view's order: pinned first, then active. Snoozed and settled threads
 * stay on their own shelves.
 */
export function groupThreadsBySection<
  T extends { readonly sectionId?: string | null | undefined },
>(input: {
  readonly sections: readonly ThreadSection[];
  readonly generalIndex: number;
  readonly pinned: readonly T[];
  readonly active: readonly T[];
  readonly listedSectionIds?: ReadonlySet<string> | null;
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
  const listed = input.listedSectionIds ?? null;
  return sectionLayoutOrder(input.sections, input.generalIndex)
    .filter(
      (id) =>
        id === GENERAL_SECTION_GROUP_ID ||
        listed === null ||
        listed.has(id) ||
        // Never hide a thread the grouping placed.
        members.has(id),
    )
    .map((id) => ({
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
      /** A snoozed row that keeps its pin; it rejoins the pinned rows when dropped. */
      readonly pinned?: boolean;
    }
  | { readonly kind: "shelf"; readonly id: string; readonly shelf: "snoozed" | "settled" };

export type SectionsDropTarget =
  | { readonly kind: "section"; readonly groupId: string; readonly order: readonly string[] }
  | { readonly kind: "settled" };

export type SectionsDropPlacement = "before" | "after";

/** The insertion slot in the list without the lifted row. Headers mean the
 * top of their section; row placement is explicit and independent of drag
 * direction. The slot stays on the dropped row's side of the pin boundary. */
export function sectionsDropIndex(
  items: readonly SectionsListItem[],
  activeIndex: number,
  overIndex: number,
  placement: SectionsDropPlacement = "before",
): number {
  const active = items[activeIndex];
  const over = items[overIndex];
  if (activeIndex === overIndex) return activeIndex;
  const remainingIndex = overIndex - (activeIndex < overIndex ? 1 : 0);
  const index =
    over?.kind === "header"
      ? remainingIndex + 1
      : over?.kind === "thread" && over.groupId !== null
        ? remainingIndex + (placement === "after" ? 1 : 0)
        : overIndex;
  if (active?.kind !== "thread") return index;
  // A drop never changes a pin, and a section lists pinned rows first, so the
  // row lands on its own side of that boundary (where the planner puts it).
  const moved = items.filter((_, position) => position !== activeIndex);
  let header = -1;
  for (let position = index - 1; position >= 0; position -= 1) {
    const item = moved[position]!;
    if (item.kind === "thread") continue;
    header = item.kind === "header" ? position : -1;
    break;
  }
  if (header < 0) return index;
  let firstActive = header + 1;
  for (let row = moved[firstActive]; row?.kind === "thread" && row.lifecycle === "pinned";) {
    firstActive += 1;
    row = moved[firstActive];
  }
  return droppedAsPinned(active) ? Math.min(index, firstActive) : Math.max(index, firstActive);
}

/** Whether a dropped row joins its section's pinned rows (settling clears a pin). */
function droppedAsPinned(item: Extract<SectionsListItem, { kind: "thread" }>): boolean {
  return item.lifecycle === "pinned" || (item.lifecycle === "snoozed" && item.pinned === true);
}

/**
 * A section's full row order after a drop, from the order the list showed:
 * a collapsed section shows only some of its rows (or none), so the dropped
 * row is placed before the shown row it landed above, else after the one it
 * landed below, else at the top. A drop on the section's header is always at
 * the top, whatever the collapsed section still shows.
 */
export function expandSectionDropOrder(input: {
  /** The section's rows as shown, with the dropped row in place. */
  readonly shownOrder: readonly string[];
  /** Every row of the section before the drop, in order. */
  readonly fullOrder: readonly string[];
  readonly droppedId: string;
  readonly onHeader?: boolean;
}): string[] {
  const { droppedId, shownOrder } = input;
  const full = input.fullOrder.filter((id) => id !== droppedId);
  if (input.onHeader === true) return [droppedId, ...full];
  const at = shownOrder.indexOf(droppedId);
  const next = shownOrder[at + 1];
  const previous = at > 0 ? shownOrder[at - 1] : undefined;
  const nextIndex = next === undefined ? -1 : full.indexOf(next);
  const previousIndex = previous === undefined ? -1 : full.indexOf(previous);
  const insertAt = nextIndex >= 0 ? nextIndex : previousIndex >= 0 ? previousIndex + 1 : 0;
  full.splice(insertAt, 0, droppedId);
  return full;
}

/**
 * Where a lifted row lands if dropped over `overId`: the section whose header
 * precedes the slot (with that section's rows in their new order), the settled
 * shelf, or nowhere (the snoozed shelf is never a destination). Over a header,
 * that header's section, at its top (see `sectionsDropIndex`).
 */
export function resolveSectionsDropTarget(
  items: readonly SectionsListItem[],
  activeId: string,
  overId: string,
  placement: SectionsDropPlacement = "before",
): SectionsDropTarget | null {
  const activeIndex = items.findIndex((item) => item.id === activeId);
  const overIndex = items.findIndex((item) => item.id === overId);
  const active = items[activeIndex];
  if (activeIndex === -1 || overIndex === -1 || active?.kind !== "thread") return null;
  const dropIndex = sectionsDropIndex(items, activeIndex, overIndex, placement);
  const moved = items.filter((_, index) => index !== activeIndex);
  moved.splice(dropIndex, 0, active);
  let owner: SectionsListItem | null = null;
  for (let index = dropIndex - 1; index >= 0; index -= 1) {
    const item = moved[index]!;
    if (item.kind !== "thread") {
      owner = item;
      break;
    }
  }
  // Above the first header: the top of the first section.
  const aboveFirstHeader = owner === null;
  if (owner === null) owner = moved.find((item) => item.kind !== "thread") ?? null;
  if (owner === null) return null;
  if (owner.kind === "shelf") return owner.shelf === "settled" ? { kind: "settled" } : null;
  const order: string[] = aboveFirstHeader ? [active.id] : [];
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
      /** Present when the thread changes section; null files it in General. */
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
  /** Whether these threads' servers accept order-key writes (default: yes). */
  readonly canWriteOrderKeys?: (ids: readonly string[], group: "pinned" | "active") => boolean;
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
  // A thread landing alone (an empty or collapsed section) keeps its key:
  // with no neighbours to sit between, a new key would only move it in the
  // Status view.
  const planned =
    orderChanged && orderedIds.length > 1
      ? planPinnedReorder({
          orderedIds,
          keysById: group === "pinned" ? input.pinnedKeysById : input.activeKeysById,
          movedId: source.key,
        })
      : [];
  // Keys are written all or nothing; without them only the move itself remains.
  const writable =
    input.canWriteOrderKeys?.(
      planned.map((assignment) => assignment.id),
      group,
    ) ?? true;
  const assignments = writable ? planned : [];
  if (!sectionChanged && !lifecycleChanged && assignments.length === 0) return { kind: "none" };
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
