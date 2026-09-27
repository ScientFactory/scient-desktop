import { ThreadSectionId, type ThreadSection } from "@t3tools/contracts";
import { describe, expect, it } from "vitest";

import {
  GENERAL_SECTION_GROUP_ID,
  catalogWithCreatedSection,
  catalogWithEnvironments,
  catalogWithRenamedSection,
  catalogWithRestoredSection,
  catalogWithoutSection,
  groupThreadsBySection,
  layoutFromGroupOrder,
  capitalizeSectionName,
  normalizeSectionName,
  readThreadSections,
  sweepEmptySections,
  planSectionsThreadDrop,
  resolveSectionDragOrder,
  sectionShifts,
  resolveSectionsDropTarget,
  sectionHeaderItemId,
  type SectionsLifecycle,
  type SectionsListItem,
} from "./logic";

const sid = (id: string) => ThreadSectionId.make(id);
const section = (id: string, name: string, order: number): ThreadSection => ({
  id: sid(id),
  name,
  order,
});
const RESEARCH = section("research", "Research", 0);
const PERMA = section("perma", "Perma", 1);

describe("catalog edits", () => {
  it("creates a section at the end, reusing an existing name case-insensitively", () => {
    const created = catalogWithCreatedSection([RESEARCH], "  To   look at ", sid("new"));
    expect(created.created).toBe(true);
    expect(created.section).toEqual({ id: "new", name: "To look at", order: 1 });
    expect(created.catalog.map((entry) => entry.id)).toEqual(["research", "new"]);

    const reused = catalogWithCreatedSection([RESEARCH], "research", sid("other"));
    expect(reused.created).toBe(false);
    expect(reused.section).toBe(RESEARCH);
  });

  it("capitalizes the first letter unless the first word mixes case on purpose", () => {
    expect(normalizeSectionName("  to   look at ")).toBe("To look at");
    expect(normalizeSectionName("research")).toBe("Research");
    expect(normalizeSectionName("iOS builds")).toBe("iOS builds");
    expect(normalizeSectionName("macOS")).toBe("macOS");
    expect(normalizeSectionName("2026 plans")).toBe("2026 plans");
    expect(normalizeSectionName("מחקר")).toBe("מחקר");
  });

  it("capitalizes as typed by the same rule a saved name follows", () => {
    expect(capitalizeSectionName("r")).toBe("R");
    expect(capitalizeSectionName("research notes")).toBe("Research notes");
    // Typing over or pasting keeps a first word that mixes case on purpose.
    expect(capitalizeSectionName("iOS")).toBe("iOS");
    expect(capitalizeSectionName("mRNA assays")).toBe("mRNA assays");
    // An all-lowercase first word is capitalized, as it will be on save.
    expect(capitalizeSectionName("npm tasks")).toBe("Npm tasks");
    // Mid-typing whitespace is kept, unlike on save.
    expect(capitalizeSectionName("to  ")).toBe("To  ");
    expect(capitalizeSectionName("2")).toBe("2");
    expect(capitalizeSectionName("מ")).toBe("מ");
    for (const name of ["iOS", "npm tasks", "mRNA assays", "  hello  world "]) {
      expect(normalizeSectionName(capitalizeSectionName(name))).toBe(normalizeSectionName(name));
    }
  });

  it("reads older lowercase names capitalized, and edits save them that way", () => {
    const hello = section("hello", "hello", 0);
    expect(readThreadSections([PERMA, hello]).map((entry) => entry.name)).toEqual([
      "Hello",
      "Perma",
    ]);
    // Already-normal entries keep their identity.
    expect(readThreadSections([RESEARCH])[0]).toBe(RESEARCH);
    const created = catalogWithCreatedSection([hello], "notes", sid("notes"));
    expect(created.catalog.map((entry) => entry.name)).toEqual(["Hello", "Notes"]);
  });

  it("renames, rejecting a name another section already uses", () => {
    expect(catalogWithRenamedSection([RESEARCH, PERMA], "perma", "PERMA ")).toEqual({
      kind: "renamed",
      catalog: [RESEARCH, { ...PERMA, name: "PERMA" }],
    });
    expect(catalogWithRenamedSection([RESEARCH, PERMA], "perma", "Perma")).toEqual({
      kind: "unchanged",
    });
    expect(catalogWithRenamedSection([RESEARCH, PERMA], "perma", "research").kind).toBe(
      "duplicate",
    );
    expect(catalogWithRenamedSection([RESEARCH], "missing", "x").kind).toBe("missing");
  });

  it("removes and restores a section, keeping General beside the same neighbors", () => {
    const later = section("later", "Later", 2);
    // Layout: Research, Perma, General, Later.
    const removed = catalogWithoutSection([RESEARCH, PERMA, later], 2, "perma");
    expect(removed.catalog.map((entry) => [entry.id, entry.order])).toEqual([
      ["research", 0],
      ["later", 1],
    ]);
    expect(removed.generalIndex).toBe(1);
    const restored = catalogWithRestoredSection(removed.catalog, removed.removed!);
    expect(restored.catalog.map((entry) => entry.id)).toEqual(["research", "perma", "later"]);
    expect(restored.generalIndex).toBe(2);
  });

  it("applies a dragged order that places General among the sections", () => {
    const later = section("later", "Later", 2);
    const layout = layoutFromGroupOrder(
      [RESEARCH, PERMA, later],
      ["perma", GENERAL_SECTION_GROUP_ID, "research"],
    );
    // Sections the drag did not know about keep their place at the end.
    expect(layout.catalog.map((entry) => [entry.id, entry.order])).toEqual([
      ["perma", 0],
      ["research", 1],
      ["later", 2],
    ]);
    expect(layout.generalIndex).toBe(1);
  });
});

describe("groupThreadsBySection", () => {
  const thread = (id: string, sectionId: string | null) => ({ id, sectionId });

  it("files unknown sections under General, keeps pinned rows first and shows empty sections", () => {
    const groups = groupThreadsBySection({
      sections: [RESEARCH, PERMA],
      generalIndex: 0,
      pinned: [thread("p1", "perma")],
      active: [thread("a1", "perma"), thread("a2", "deleted"), thread("a3", null)],
    });
    expect(groups.map((group) => [group.id, group.threads.map((entry) => entry.id)])).toEqual([
      [GENERAL_SECTION_GROUP_ID, ["a2", "a3"]],
      ["research", []],
      ["perma", ["p1", "a1"]],
    ]);
  });

  it("places General at its stored position, clamped to the list", () => {
    const ids = (generalIndex: number) =>
      groupThreadsBySection({
        sections: [RESEARCH, PERMA],
        generalIndex,
        pinned: [],
        active: [],
      }).map((group) => group.id);
    expect(ids(1)).toEqual(["research", GENERAL_SECTION_GROUP_ID, "perma"]);
    expect(ids(9)).toEqual(["research", "perma", GENERAL_SECTION_GROUP_ID]);
  });
});

describe("Sections view drops", () => {
  const header = (groupId: string): SectionsListItem => ({
    kind: "header",
    id: sectionHeaderItemId(groupId),
    groupId,
  });
  const row = (id: string, lifecycle: SectionsLifecycle, groupId: string | null) =>
    ({ kind: "thread", id, lifecycle, groupId }) as const;
  const items: SectionsListItem[] = [
    header("research"),
    row("r-pin", "pinned", "research"),
    row("r1", "active", "research"),
    row("r2", "active", "research"),
    header("perma"),
    row("p1", "active", "perma"),
    header(GENERAL_SECTION_GROUP_ID),
    row("o1", "active", GENERAL_SECTION_GROUP_ID),
    { kind: "shelf", id: "snoozed", shelf: "snoozed" },
    row("z1", "snoozed", null),
    { kind: "shelf", id: "settled", shelf: "settled" },
    row("s1", "settled", null),
  ];
  const lifecycleByKey = new Map(
    items.flatMap((item) => (item.kind === "thread" ? [[item.id, item.lifecycle] as const] : [])),
  );
  const keys = new Map<string, string | null>([
    ["r1", "g"],
    ["r2", "m"],
    ["p1", "t"],
    ["o1", "w"],
  ]);
  const orderOf = (groupId: string) =>
    items.flatMap((item) => (item.kind === "thread" && item.groupId === groupId ? [item.id] : []));
  const plan = (activeId: string, overId: string) => {
    const source = items.find((item) => item.id === activeId);
    if (source?.kind !== "thread") throw new Error("not a row");
    const target = resolveSectionsDropTarget(items, activeId, overId);
    if (target === null) return null;
    return planSectionsThreadDrop({
      source: {
        key: activeId,
        lifecycle: source.lifecycle,
        groupId: source.groupId,
        pinned: source.lifecycle === "pinned",
      },
      target,
      targetOrderBefore: target.kind === "section" ? orderOf(target.groupId) : [],
      lifecycleByKey,
      pinnedKeysById: new Map(),
      activeKeysById: keys,
      toSectionId: (groupId) => (groupId === GENERAL_SECTION_GROUP_ID ? null : sid(groupId)),
    });
  };

  it("resolves the section and new row order under the pointer", () => {
    expect(resolveSectionsDropTarget(items, "o1", "r2")).toEqual({
      kind: "section",
      groupId: "research",
      order: ["r-pin", "r1", "o1", "r2"],
    });
    expect(resolveSectionsDropTarget(items, "r1", "s1")).toEqual({ kind: "settled" });
    expect(resolveSectionsDropTarget(items, "r1", "z1")).toBeNull();
  });

  it("moves a thread into another section at the dropped position", () => {
    expect(plan("o1", "r2")).toEqual({
      kind: "move",
      sectionId: "research",
      unsettle: false,
      unsnooze: false,
      group: "active",
      assignments: [{ id: "o1", orderKey: expect.any(String) }],
    });
    const moved = plan("o1", "r2");
    if (moved?.kind !== "move") throw new Error("expected a move");
    const key = moved.assignments[0]!.orderKey;
    expect(key > "g" && key < "m").toBe(true);
  });

  it("lands a row dropped above the first header at the top of the first section", () => {
    expect(resolveSectionsDropTarget(items, "o1", sectionHeaderItemId("research"))).toEqual({
      kind: "section",
      groupId: "research",
      order: ["o1", "r-pin", "r1", "r2"],
    });
  });

  it("lands a row dragged up onto a header where the list shows it: above that header", () => {
    // Moving up over Perma's header slides the header down, so the gap (and
    // the drop) is at the end of Research, not inside Perma.
    expect(resolveSectionsDropTarget(items, "o1", sectionHeaderItemId("perma"))).toEqual({
      kind: "section",
      groupId: "research",
      order: ["r-pin", "r1", "r2", "o1"],
    });
    // Moving down over it lands at the top of Perma.
    expect(resolveSectionsDropTarget(items, "r2", sectionHeaderItemId("perma"))).toEqual({
      kind: "section",
      groupId: "perma",
      order: ["r2", "p1"],
    });
  });

  it("files a thread in General and reorders within a section", () => {
    expect(plan("p1", "o1")).toMatchObject({ kind: "move", sectionId: null });
    const reorder = plan("r2", "r1");
    expect(reorder).toMatchObject({ kind: "move", group: "active" });
    expect(reorder).not.toHaveProperty("sectionId");
  });

  it("keeps a thread's order key when it lands alone in an empty or collapsed section", () => {
    const moved = planSectionsThreadDrop({
      source: { key: "r1", lifecycle: "active", groupId: "research", pinned: false },
      target: { kind: "section", groupId: "empty", order: ["r1"] },
      targetOrderBefore: [],
      lifecycleByKey,
      pinnedKeysById: new Map(),
      activeKeysById: keys,
      toSectionId: (groupId) => sid(groupId),
    });
    expect(moved).toEqual({
      kind: "move",
      sectionId: "empty",
      unsettle: false,
      unsnooze: false,
      group: "active",
      assignments: [],
    });
  });

  it("ignores a drop back where the row started", () => {
    expect(plan("r1", "r1")).toEqual({ kind: "none" });
  });

  it("keeps pinned rows above active rows without unpinning", () => {
    // An active row dropped above the pin lands first among active rows.
    const dropped = plan("r2", "r-pin");
    expect(dropped).toMatchObject({ kind: "move", group: "active" });
  });

  it("un-settles or wakes a shelved thread dragged into a section", () => {
    expect(plan("s1", "p1")).toMatchObject({
      kind: "move",
      sectionId: "perma",
      unsettle: true,
      unsnooze: false,
      group: "active",
    });
    expect(plan("z1", "p1")).toMatchObject({ kind: "move", unsnooze: true, unsettle: false });
  });

  it("settles a thread dropped on the settled shelf", () => {
    expect(plan("r1", "s1")).toEqual({ kind: "settle" });
    expect(plan("s1", "s1")).toEqual({ kind: "none" });
  });

  it("orders a dragged section by the frozen block middles, General included", () => {
    const blocks = [
      { groupId: GENERAL_SECTION_GROUP_ID, top: 0, height: 100 },
      { groupId: "research", top: 100, height: 200 },
      { groupId: "perma", top: 300, height: 40 },
    ];
    // Perma lifted from the bottom: above General's middle it goes first.
    expect(resolveSectionDragOrder(blocks, "perma", 40)).toEqual([
      "perma",
      GENERAL_SECTION_GROUP_ID,
      "research",
    ]);
    // Past Research's middle (200) but not below it: after General, before Research.
    expect(resolveSectionDragOrder(blocks, "perma", 150)).toEqual([
      GENERAL_SECTION_GROUP_ID,
      "perma",
      "research",
    ]);
    expect(resolveSectionDragOrder(blocks, GENERAL_SECTION_GROUP_ID, 500)).toEqual([
      "research",
      "perma",
      GENERAL_SECTION_GROUP_ID,
    ]);
  });

  it("slides whole blocks so the preview order stacks without gaps", () => {
    const blocks = [
      { groupId: GENERAL_SECTION_GROUP_ID, top: 0, height: 100 },
      { groupId: "research", top: 100, height: 200 },
      { groupId: "perma", top: 300, height: 40 },
    ];
    const shifts = sectionShifts(blocks, ["perma", GENERAL_SECTION_GROUP_ID, "research"]);
    expect(Object.fromEntries(shifts)).toEqual({
      perma: -300,
      [GENERAL_SECTION_GROUP_ID]: 40,
      research: 40,
    });
  });
});

describe("sweepEmptySections", () => {
  const now = new Date("2026-09-27T12:00:00.000Z");
  const daysAgo = (days: number) => new Date(now.getTime() - days * 86_400_000).toISOString();
  /** `occupied`: section id → environments seen holding its threads (default "a"). */
  const sweep = (
    sections: ThreadSection[],
    occupied: string[] | Record<string, string[]>,
    options: { generalIndex?: number; visible?: string[] | null } = {},
  ) =>
    sweepEmptySections({
      sections,
      generalIndex: options.generalIndex ?? 0,
      occupancy: new Map(
        Array.isArray(occupied)
          ? occupied.map((id) => [id, new Set(["a"])])
          : Object.entries(occupied).map(([id, environments]) => [id, new Set(environments)]),
      ),
      visibleEnvironmentIds: options.visible === null ? null : new Set(options.visible ?? ["a"]),
      now,
      afterDays: 7,
    });

  it("stamps a newly empty section and clears the stamp once a thread joins", () => {
    const stamped = sweep([RESEARCH, PERMA], ["perma"]);
    expect(stamped?.removed).toEqual([]);
    expect(stamped?.catalog[0]?.emptySince).toBe(now.toISOString());
    expect(stamped?.catalog[1]?.emptySince).toBeUndefined();

    const cleared = sweep(stamped!.catalog, ["research", "perma"]);
    expect(cleared?.catalog.every((entry) => entry.emptySince === undefined)).toBe(true);
    expect(sweep(cleared!.catalog, ["research", "perma"])).toBeNull();
  });

  it("records the environments holding a section's threads", () => {
    const swept = sweep([RESEARCH], { research: ["b", "a"] });
    expect(swept?.catalog[0]?.environmentIds).toEqual(["b", "a"]);
    // Already recorded: nothing to write.
    expect(sweep(swept!.catalog, { research: ["a"] })).toBeNull();
  });

  it("never judges a section from a client that can't see all its environments", () => {
    // Filed from environment b; this client only sees a, so it can't call it empty.
    const fromB = { ...RESEARCH, environmentIds: ["b"], emptySince: daysAgo(30) };
    expect(sweep([fromB], [], { visible: ["a"] })).toBeNull();
    // A client that sees b as well judges it.
    expect(sweep([fromB], [], { visible: ["a", "b"] })?.removed).toHaveLength(1);
  });

  it("only records when it can't judge, so a brief visit still resets the clock", () => {
    const stale = { ...RESEARCH, emptySince: daysAgo(30) };
    // A thread joins: the record-only pass clears the stamp at once.
    const joined = sweep([stale], ["research"], { visible: null });
    expect(joined?.catalog[0]?.emptySince).toBeUndefined();
    // The thread leaves again: a record-only pass neither stamps nor removes.
    expect(sweep(joined!.catalog, [], { visible: null })).toBeNull();
    // The next judging pass starts a fresh count instead of removing.
    const judged = sweep(joined!.catalog, []);
    expect(judged?.removed).toEqual([]);
    expect(judged?.catalog[0]?.emptySince).toBe(now.toISOString());
  });

  it("removes only sections empty for the whole period, keeping General beside its neighbors", () => {
    const later = section("later", "Later", 2);
    // Layout: Research, Perma, General, Later.
    const swept = sweep(
      [{ ...RESEARCH, emptySince: daysAgo(8) }, { ...PERMA, emptySince: daysAgo(3) }, later],
      ["later"],
      { generalIndex: 2 },
    );
    expect(swept?.removed.map((entry) => entry.section.id)).toEqual(["research"]);
    expect(swept?.catalog.map((entry) => entry.id)).toEqual(["perma", "later"]);
    expect(swept?.generalIndex).toBe(1);
  });

  it("restarts the count for a stamp that doesn't parse", () => {
    const swept = sweep([{ ...RESEARCH, emptySince: "not a date" }], []);
    expect(swept?.removed).toEqual([]);
    expect(swept?.catalog[0]?.emptySince).toBe(now.toISOString());
  });

  it("restores a removed section with a fresh clock and its environments", () => {
    const swept = sweep(
      [{ ...RESEARCH, emptySince: daysAgo(9), environmentIds: ["a"] }, PERMA],
      ["perma"],
    );
    const restored = catalogWithRestoredSection(swept!.catalog, swept!.removed[0]!);
    expect(restored.catalog.map((entry) => entry.id)).toEqual(["research", "perma"]);
    expect(restored.catalog[0]?.emptySince).toBeUndefined();
    expect(restored.catalog[0]?.environmentIds).toEqual(["a"]);
  });
});

describe("catalogWithEnvironments", () => {
  it("clears an old cleanup deadline before filing into an already recorded environment", () => {
    const recorded = catalogWithEnvironments(
      [{ ...RESEARCH, environmentIds: ["remote"], emptySince: "2020-01-01T00:00:00.000Z" }],
      RESEARCH.id,
      ["remote"],
    );
    expect(recorded?.[0]?.emptySince).toBeUndefined();
    expect(recorded?.[0]?.environmentIds).toEqual(["remote"]);
    expect(recorded).not.toBeNull();
  });
  it("adds only environments not yet recorded", () => {
    const recorded = catalogWithEnvironments([RESEARCH, PERMA], "perma", ["a"]);
    expect(recorded?.[1]?.environmentIds).toEqual(["a"]);
    expect(catalogWithEnvironments(recorded!, "perma", ["a"])).toBeNull();
    expect(catalogWithEnvironments(recorded!, "gone", ["a"])).toBeNull();
  });
});
