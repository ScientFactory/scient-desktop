import { describe, expect, it } from "vite-plus/test";

import { collapseDockGroups } from "./dockChrome";

describe("collapseDockGroups", () => {
  // Mirrors the real dock: formatting pinned, direction least important.
  const groups = [
    { id: "history", priority: 30, width: 70 },
    { id: "format", priority: 100, width: 160, pinned: true },
    { id: "style", priority: 50, width: 44 },
    { id: "lists", priority: 40, width: 48 },
    { id: "insert", priority: 20, width: 48 },
    { id: "direction", priority: 10, width: 44 },
  ];

  it("keeps every group when they all fit", () => {
    const hidden = collapseDockGroups({ availableWidth: 500, reservedWidth: 80, groups });
    expect([...hidden]).toEqual([]);
  });

  it("collapses the least important group first", () => {
    const hidden = collapseDockGroups({ availableWidth: 480, reservedWidth: 80, groups });
    expect([...hidden]).toEqual(["direction"]);
  });

  it("never collapses the pinned formatting group, even at extreme narrowness", () => {
    const hidden = collapseDockGroups({ availableWidth: 100, reservedWidth: 80, groups });
    expect(hidden.has("format")).toBe(false);
    expect(hidden.size).toBe(5);
  });

  it("breaks priority ties deterministically by id", () => {
    const tied = [
      { id: "b", priority: 10, width: 50 },
      { id: "a", priority: 10, width: 50 },
    ];
    const hidden = collapseDockGroups({ availableWidth: 60, reservedWidth: 0, groups: tied });
    expect([...hidden]).toEqual(["a"]);
  });
});
