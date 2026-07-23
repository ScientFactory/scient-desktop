import { afterEach, describe, expect, it } from "vitest";

import type { ActivityItem } from "./activityStore";
import {
  ACTIVITY_RETENTION_MS,
  MAX_ACTIVITY_ITEMS,
  normalizePersistedItems,
  upsertActivityItems,
  useActivityStore,
} from "./activityStore";
import {
  activitySidebarSummary,
  formatActivityRelativeTime,
  groupActivityItems,
  prioritizeActivityItemsForPreview,
  unreadActivityCount,
} from "./activityCenter.logic";

const NOW = Date.parse("2026-07-23T12:00:00.000Z");

afterEach(() => useActivityStore.getState().reset());

function item(overrides: Partial<ActivityItem> = {}): ActivityItem {
  return {
    id: "item-1",
    dedupeKey: "thread:1",
    source: "thread",
    status: "recent",
    tone: "success",
    title: "Finished",
    createdAt: "2026-07-23T11:59:00.000Z",
    updatedAt: "2026-07-23T11:59:00.000Z",
    ...overrides,
  };
}

describe("activityStore", () => {
  it("updates a matching dedupe key instead of creating a duplicate", () => {
    const existing = item({ readAt: "2026-07-23T11:59:30.000Z" });
    const result = upsertActivityItems(
      [existing],
      {
        dedupeKey: existing.dedupeKey,
        source: "thread",
        status: "needs_attention",
        tone: "warning",
        title: "Input needed",
      },
      NOW,
    );

    expect(result.items).toHaveLength(1);
    expect(result.items[0]).toMatchObject({
      id: existing.id,
      status: "needs_attention",
      title: "Input needed",
      readAt: undefined,
    });
  });

  it("preserves read state for progress refreshes when requested", () => {
    const existing = item({ readAt: "2026-07-23T11:59:30.000Z" });
    const result = upsertActivityItems(
      [existing],
      {
        dedupeKey: existing.dedupeKey,
        source: "thread",
        status: "in_progress",
        tone: "info",
        title: "Still running",
        preserveRead: true,
      },
      NOW,
    );

    expect(result.items[0]?.readAt).toBe(existing.readAt);
  });

  it("ignores an out-of-order update that would regress completed work", () => {
    const existing = item({
      status: "recent",
      title: "Finished",
      updatedAt: "2026-07-23T11:59:30.000Z",
    });
    const result = upsertActivityItems(
      [existing],
      {
        dedupeKey: existing.dedupeKey,
        source: "thread",
        status: "in_progress",
        tone: "info",
        title: "Still running",
        occurredAt: "2026-07-23T11:59:00.000Z",
      },
      NOW,
    );

    expect(result.items).toEqual([existing]);
  });

  it("keeps an exact equal-time replay read and rejects equal-time lifecycle regression", () => {
    const existing = item({
      status: "recent",
      updatedAt: "2026-07-23T11:59:30.000Z",
      readAt: "2026-07-23T11:59:45.000Z",
    });
    const replay = upsertActivityItems(
      [existing],
      {
        dedupeKey: existing.dedupeKey,
        source: existing.source,
        status: existing.status,
        tone: existing.tone,
        title: existing.title,
        occurredAt: existing.updatedAt,
      },
      NOW,
    );
    const regression = upsertActivityItems(
      replay.items,
      {
        dedupeKey: existing.dedupeKey,
        source: "thread",
        status: "in_progress",
        tone: "info",
        title: "Still running",
        occurredAt: existing.updatedAt,
      },
      NOW,
    );

    expect(replay.items).toEqual([existing]);
    expect(regression.items).toEqual([existing]);
  });

  it("rejects malformed timestamps and recovers from future clock values", () => {
    const existing = item({ updatedAt: new Date(NOW + 60 * 60 * 1_000).toISOString() });
    const malformed = upsertActivityItems(
      [existing],
      {
        dedupeKey: existing.dedupeKey,
        source: "thread",
        status: "needs_attention",
        tone: "warning",
        title: "Malformed",
        occurredAt: "not-a-date",
      },
      NOW,
    );
    const recovered = upsertActivityItems(
      malformed.items,
      {
        dedupeKey: existing.dedupeKey,
        source: "thread",
        status: "recent",
        tone: "success",
        title: "Recovered",
      },
      NOW,
    );

    expect(malformed.items).toEqual([existing]);
    expect(recovered.items[0]).toMatchObject({
      title: "Recovered",
      updatedAt: new Date(NOW).toISOString(),
    });
  });

  it("normalizes duplicate persisted identities and logical activities", () => {
    const normalized = normalizePersistedItems(
      [
        item({ id: "shared", dedupeKey: "same", updatedAt: "2026-07-23T11:59:50.000Z" }),
        item({ id: "shared", dedupeKey: "same", updatedAt: "2026-07-23T11:59:40.000Z" }),
        item({ id: "shared", dedupeKey: "different", updatedAt: "2026-07-23T11:59:30.000Z" }),
      ],
      NOW,
    );

    expect(normalized.map((entry) => entry.dedupeKey)).toEqual(["same", "different"]);
    expect(new Set(normalized.map((entry) => entry.id)).size).toBe(2);
  });

  it("prunes expired activity and enforces the history bound", () => {
    const expired = item({
      id: "expired",
      dedupeKey: "expired",
      updatedAt: new Date(NOW - ACTIVITY_RETENTION_MS - 1).toISOString(),
    });
    const many = Array.from({ length: MAX_ACTIVITY_ITEMS + 12 }, (_, index) =>
      item({
        id: `item-${index}`,
        dedupeKey: `item-${index}`,
        updatedAt: new Date(NOW - index * 1_000).toISOString(),
      }),
    );
    const result = upsertActivityItems(
      [expired, ...many],
      {
        dedupeKey: "new",
        source: "system",
        status: "recent",
        tone: "info",
        title: "New",
      },
      NOW,
    );

    expect(result.items).toHaveLength(MAX_ACTIVITY_ITEMS);
    expect(result.items.some((entry) => entry.id === "expired")).toBe(false);
    expect(result.items[0]?.dedupeKey).toBe("new");
  });

  it("never clears unresolved attention or progress when clearing read history", () => {
    useActivityStore.setState({
      items: [
        item({
          id: "attention",
          dedupeKey: "attention",
          status: "needs_attention",
          readAt: "read",
        }),
        item({ id: "progress", dedupeKey: "progress", status: "in_progress", readAt: "read" }),
        item({ id: "recent", dedupeKey: "recent", status: "recent", readAt: "read" }),
      ],
    });

    useActivityStore.getState().clearRead();

    expect(useActivityStore.getState().items.map((entry) => entry.id)).toEqual([
      "attention",
      "progress",
    ]);
  });
});

describe("activityCenter logic", () => {
  it("groups items and summarizes attention before progress and unread history", () => {
    const items = [
      item({ id: "attention", status: "needs_attention" }),
      item({ id: "progress", dedupeKey: "progress", status: "in_progress" }),
      item({ id: "recent", dedupeKey: "recent", status: "recent", readAt: "read" }),
    ];
    const groups = groupActivityItems(items);

    expect(groups.needs_attention).toHaveLength(1);
    expect(groups.in_progress).toHaveLength(1);
    expect(groups.recent).toHaveLength(1);
    expect(unreadActivityCount(items)).toBe(2);
    expect(activitySidebarSummary(items)).toBe("1 needs attention");
  });

  it("formats compact relative timestamps", () => {
    expect(formatActivityRelativeTime("2026-07-23T11:59:40.000Z", NOW)).toBe("Now");
    expect(formatActivityRelativeTime("2026-07-23T11:42:00.000Z", NOW)).toBe("18m");
    expect(formatActivityRelativeTime("2026-07-23T09:00:00.000Z", NOW)).toBe("3h");
  });

  it("keeps attention and progress visible ahead of recent history", () => {
    const items = [
      item({ id: "recent", dedupeKey: "recent", status: "recent" }),
      item({ id: "attention", dedupeKey: "attention", status: "needs_attention" }),
      item({ id: "progress", dedupeKey: "progress", status: "in_progress" }),
    ];

    expect(prioritizeActivityItemsForPreview(items, 2).map((entry) => entry.id)).toEqual([
      "attention",
      "progress",
    ]);
  });
});
