import type { EnvironmentServerConfig } from "@t3tools/client-runtime/connection";
import { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import { expect, it } from "vite-plus/test";

import { makeThreadFixture } from "../../test-fixtures";
import { planStatusThreadDrop, statusDropOrderReleased } from "./statusAutomaticPlacement";
import { automaticPlacementThreads } from "../sections/placementThreads";

const now = "2026-10-25T12:00:00.000Z";
const local = EnvironmentId.make("local");
const remote = EnvironmentId.make("remote");

it("builds the complete manual inbox with each environment's lifecycle capabilities", () => {
  const thread = (id: string, patch: Parameters<typeof makeThreadFixture>[0] = {}) =>
    makeThreadFixture({ id: ThreadId.make(id), environmentId: local, ...patch });
  const configs = new Map([
    [local, { environment: { capabilities: { threadSettlement: true, threadSnooze: true } } }],
  ]) as unknown as ReadonlyMap<EnvironmentId, EnvironmentServerConfig>;
  const threads = [
    thread("later", { activeOrderKey: "b0", projectId: ProjectId.make("other-project") }),
    thread("first", { activeOrderKey: "a0" }),
    thread("pinned", { pinnedAt: now }),
    thread("settled", { settledOverride: "settled" }),
    thread("snoozed", { snoozedUntil: "2026-10-26T12:00:00.000Z", snoozedAt: now }),
    thread("woke", { snoozedUntil: now, snoozedAt: "2026-10-24T12:00:00.000Z" }),
    thread("old-server", {
      environmentId: remote,
      settledOverride: "settled",
      snoozedUntil: "2026-10-26T12:00:00.000Z",
    }),
    thread("archived", { archivedAt: now }),
    thread("child", {
      lineage: {
        rootThreadId: ThreadId.make("first"),
        parentThreadId: ThreadId.make("first"),
        relationshipToParent: "subagent",
      },
    }),
  ];
  expect(automaticPlacementThreads(threads, configs, now).map((thread) => thread.id)).toEqual([
    "old-server",
    "woke",
    "first",
    "later",
  ]);
});

const input = () => ({
  activeKey: "a",
  activeSection: "active" as const,
  pinnedOrder: [],
  pinnedKeysById: new Map<string, string>(),
  activeOrder: ["a", "b", "x", "hidden", "y"],
  canonicalActiveOrder: ["x", "hidden", "a", "y", "b"],
  activeKeysById: new Map([
    ["x", "d"],
    ["hidden", "g"],
    ["a", "n"],
    ["y", "t"],
    ["b", "x"],
  ]),
  target: { section: "active" as const, pinnedOrder: [], activeOrder: ["b", "a", "x", "y"] },
});

it("saves only the dragged row between canonical neighbours, retaining hidden manual positions", () => {
  const plan = planStatusThreadDrop(input());
  expect(plan.kind).toBe("move-active");
  if (plan.kind !== "move-active") throw Error("Missing drop");
  expect(plan.order).toEqual(["b", "a", "x", "y"]);
  expect(plan.assignments).toHaveLength(1);
  expect(plan.assignments[0]!.id).toBe("a");
  const keys = new Map(input().activeKeysById);
  for (const assignment of plan.assignments) keys.set(assignment.id, assignment.orderKey);
  expect([...keys.keys()].toSorted((a, b) => keys.get(a)!.localeCompare(keys.get(b)!))).toEqual([
    "x",
    "hidden",
    "y",
    "b",
    "a",
  ]);
});

it("accepts a visual manual exception with no key change, while enforcing reorder support", () => {
  const base = input();
  const drop = {
    ...base,
    target: { ...base.target, activeOrder: ["b", "x", "hidden", "a", "y"] },
  };
  expect(planStatusThreadDrop(drop)).toMatchObject({ kind: "move-active", assignments: [] });
  expect(planStatusThreadDrop({ ...drop, activeReorderableKeys: new Set(["b"]) })).toEqual({
    kind: "none",
  });
  expect(
    planStatusThreadDrop({ ...base, target: { ...base.target, activeOrder: base.activeOrder } }),
  ).toEqual({
    kind: "none",
  });
});

it("restores a shelf row at its displayed drop without saving the promoted rows' order", () => {
  const base = input();
  const plan = planStatusThreadDrop({
    ...base,
    activeKey: "shelf",
    activeSection: "settled",
    target: { ...base.target, activeOrder: ["a", "shelf", "b", "x", "y"] },
  });
  expect(plan).toMatchObject({
    kind: "move-active",
    unsettle: true,
    assignments: [{ id: "shelf" }],
  });
});

it("waits for hidden order writes too, and releases a drop superseded by another client or deletion", () => {
  const input = {
    destinationKeys: ["visible"],
    before: new Map([
      ["visible", "d"],
      ["hidden", "g"],
    ]),
    assigned: new Map([
      ["visible", "m"],
      ["hidden", "t"],
    ]),
    current: new Map([
      ["visible", "m"],
      ["hidden", "g"],
    ]),
  };
  expect(statusDropOrderReleased(input)).toBe(false);
  expect(
    statusDropOrderReleased({
      ...input,
      current: new Map(input.assigned),
      presentationPending: true,
      membershipChanged: true,
    }),
  ).toBe(false);
  expect(statusDropOrderReleased({ ...input, current: new Map(input.assigned) })).toBe(true);
  expect(
    statusDropOrderReleased({
      ...input,
      current: new Map([
        ["visible", "m"],
        ["hidden", "x"],
      ]),
    }),
  ).toBe(true);
  expect(statusDropOrderReleased({ ...input, current: new Map([["visible", "m"]]) })).toBe(true);
});
