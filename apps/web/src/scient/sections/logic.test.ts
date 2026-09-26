import { ThreadSectionId, type ThreadSection } from "@t3tools/contracts";
import { describe, expect, it } from "vitest";

import {
  GENERAL_SECTION_GROUP_ID,
  catalogWithCreatedSection,
  catalogWithRenamedSection,
  catalogWithRestoredSection,
  catalogWithoutSection,
  groupThreadsBySection,
  layoutFromGroupOrder,
  planSectionsThreadDrop,
  resolveSectionHeaderDrop,
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

  it("files a thread under Other and reorders within a section", () => {
    expect(plan("p1", "o1")).toMatchObject({ kind: "move", sectionId: null });
    const reorder = plan("r2", "r1");
    expect(reorder).toMatchObject({ kind: "move", group: "active" });
    expect(reorder).not.toHaveProperty("sectionId");
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

  it("reorders section headers, General included like any section", () => {
    const ordered = [GENERAL_SECTION_GROUP_ID, "research", "perma"];
    expect(resolveSectionHeaderDrop(ordered, GENERAL_SECTION_GROUP_ID, "perma")).toEqual([
      "research",
      "perma",
      GENERAL_SECTION_GROUP_ID,
    ]);
    expect(resolveSectionHeaderDrop(ordered, "perma", GENERAL_SECTION_GROUP_ID)).toEqual([
      "perma",
      GENERAL_SECTION_GROUP_ID,
      "research",
    ]);
    // Past the last header: the last slot.
    expect(resolveSectionHeaderDrop(ordered, "research", null)).toEqual([
      GENERAL_SECTION_GROUP_ID,
      "perma",
      "research",
    ]);
    expect(resolveSectionHeaderDrop(ordered, "perma", "perma")).toBeNull();
  });
});
