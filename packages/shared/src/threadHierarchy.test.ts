import { describe, expect, it } from "vitest";

import { collectSubagentDescendants, collectSubagentSubtreeRoots } from "./threadHierarchy";

interface Thread {
  readonly id: string;
  readonly parentThreadId?: string | null;
}

describe("thread hierarchy", () => {
  it("collects nested descendants breadth-first without unrelated threads", () => {
    const threads: Thread[] = [
      { id: "root" },
      { id: "child-a", parentThreadId: "root" },
      { id: "other" },
      { id: "grandchild", parentThreadId: "child-a" },
      { id: "child-b", parentThreadId: "root" },
    ];

    expect(collectSubagentDescendants(threads, "root").map((thread) => thread.id)).toEqual([
      "child-a",
      "child-b",
      "grandchild",
    ]);
  });

  it("terminates safely for self-links and cycles without returning the root", () => {
    const threads: Thread[] = [
      { id: "self", parentThreadId: "self" },
      { id: "root", parentThreadId: "cycle" },
      { id: "cycle", parentThreadId: "root" },
    ];

    expect(collectSubagentDescendants(threads, "self")).toEqual([]);
    expect(collectSubagentDescendants(threads, "root").map((thread) => thread.id)).toEqual([
      "cycle",
    ]);
  });

  it("chooses natural roots, orphan roots, and one deterministic root per cycle", () => {
    const threads: Thread[] = [
      { id: "child", parentThreadId: "root" },
      { id: "root" },
      { id: "orphan", parentThreadId: "missing" },
      { id: "cycle-a", parentThreadId: "cycle-b" },
      { id: "cycle-b", parentThreadId: "cycle-a" },
    ];

    expect(collectSubagentSubtreeRoots(threads).map((thread) => thread.id)).toEqual([
      "root",
      "orphan",
      "cycle-a",
    ]);
  });
});
