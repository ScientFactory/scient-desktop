// FILE: activityStore.ts
// Purpose: Persists deduplicated background activity for the lower-left Activity Center.
// Layer: Notification state

import type { ThreadId } from "@synara/contracts";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

import { createMemoryStorage } from "../lib/storage";
import {
  SETTINGS_SECTION_IDS,
  SETTINGS_TARGETS,
  type SettingsSectionId,
  type SettingsTargetId,
} from "../settingsNavigation";

export type ActivityStatus = "needs_attention" | "in_progress" | "recent";
export type ActivityTone = "error" | "info" | "success" | "warning";
export type ActivitySource =
  | "automation"
  | "maintenance"
  | "provider"
  | "system"
  | "terminal"
  | "thread"
  | "update";

export type ActivityDestination =
  | { readonly type: "thread"; readonly threadId: ThreadId }
  | { readonly type: "connection_diagnostics"; readonly stateStartedAt: string }
  | {
      readonly type: "settings";
      readonly section?: SettingsSectionId | undefined;
      readonly target?: SettingsTargetId | undefined;
    };

export interface ActivityItem {
  readonly id: string;
  readonly dedupeKey: string;
  readonly source: ActivitySource;
  readonly status: ActivityStatus;
  readonly tone: ActivityTone;
  readonly title: string;
  readonly description?: string | undefined;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly readAt?: string | undefined;
  readonly destination?: ActivityDestination | undefined;
}

export interface PublishActivityInput {
  readonly dedupeKey: string;
  readonly source: ActivitySource;
  readonly status: ActivityStatus;
  readonly tone: ActivityTone;
  readonly title: string;
  readonly description?: string | undefined;
  readonly occurredAt?: string | undefined;
  readonly destination?: ActivityDestination | undefined;
  /** Keep an update read when it only refreshes progress; defaults to unread. */
  readonly preserveRead?: boolean | undefined;
}

interface ActivityStore {
  items: ActivityItem[];
  publish: (input: PublishActivityInput) => string;
  markRead: (id: string) => void;
  markAllRead: () => void;
  remove: (dedupeKey: string) => void;
  clearRead: () => void;
  reset: () => void;
}

export const ACTIVITY_STORAGE_KEY = "scient:activity-center:v1";
export const MAX_ACTIVITY_ITEMS = 200;
export const ACTIVITY_RETENTION_MS = 30 * 24 * 60 * 60 * 1_000;
export const ACTIVITY_FUTURE_TOLERANCE_MS = 5 * 60 * 1_000;

let fallbackSequence = 0;
const fallbackStorage = createMemoryStorage();

function createActivityId(nowMs: number): string {
  const randomUuid = globalThis.crypto?.randomUUID?.();
  if (randomUuid) return randomUuid;
  fallbackSequence += 1;
  return `activity:${nowMs}:${fallbackSequence}`;
}

function normalizedOccurredAt(value: string | undefined, nowMs: number): string | null {
  if (!value) return new Date(nowMs).toISOString();
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return null;
  return new Date(parsed > nowMs + ACTIVITY_FUTURE_TOLERANCE_MS ? nowMs : parsed).toISOString();
}

function isExactActivityReplay(existing: ActivityItem, input: PublishActivityInput): boolean {
  return (
    existing.source === input.source &&
    existing.status === input.status &&
    existing.tone === input.tone &&
    existing.title === input.title &&
    existing.description === input.description &&
    JSON.stringify(existing.destination) === JSON.stringify(input.destination)
  );
}

export function upsertActivityItems(
  items: readonly ActivityItem[],
  input: PublishActivityInput,
  nowMs = Date.now(),
): { readonly id: string; readonly items: ActivityItem[] } {
  const existing = items.find((item) => item.dedupeKey === input.dedupeKey);
  const occurredAt = normalizedOccurredAt(input.occurredAt, nowMs);
  if (occurredAt === null) {
    return { id: existing?.id ?? createActivityId(nowMs), items: [...items] };
  }
  const occurredAtMs = Date.parse(occurredAt);
  const existingUpdatedAtMs = existing ? Date.parse(existing.updatedAt) : Number.NEGATIVE_INFINITY;
  const recoverableExistingUpdatedAtMs =
    existingUpdatedAtMs > nowMs + ACTIVITY_FUTURE_TOLERANCE_MS
      ? Number.NEGATIVE_INFINITY
      : existingUpdatedAtMs;
  if (existing && occurredAtMs < recoverableExistingUpdatedAtMs) {
    return { id: existing.id, items: [...items] };
  }
  if (
    existing &&
    occurredAtMs === recoverableExistingUpdatedAtMs &&
    isExactActivityReplay(existing, input)
  ) {
    return { id: existing.id, items: [...items] };
  }
  if (existing && occurredAtMs === recoverableExistingUpdatedAtMs) {
    const statusPrecedence: Record<ActivityStatus, number> = {
      in_progress: 0,
      needs_attention: 1,
      recent: 2,
    };
    if (statusPrecedence[input.status] < statusPrecedence[existing.status]) {
      return { id: existing.id, items: [...items] };
    }
  }
  const nextItem: ActivityItem = existing
    ? {
        ...existing,
        source: input.source,
        status: input.status,
        tone: input.tone,
        title: input.title,
        description: input.description,
        destination: input.destination,
        updatedAt: occurredAt,
        readAt: input.preserveRead ? existing.readAt : undefined,
      }
    : {
        id: createActivityId(nowMs),
        dedupeKey: input.dedupeKey,
        source: input.source,
        status: input.status,
        tone: input.tone,
        title: input.title,
        description: input.description,
        destination: input.destination,
        createdAt: occurredAt,
        updatedAt: occurredAt,
      };
  const retentionCutoff = nowMs - ACTIVITY_RETENTION_MS;
  const nextItems = [nextItem, ...items.filter((item) => item.dedupeKey !== nextItem.dedupeKey)]
    .filter((item) => Date.parse(item.updatedAt) >= retentionCutoff)
    .toSorted((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt))
    .slice(0, MAX_ACTIVITY_ITEMS);
  return { id: nextItem.id, items: nextItems };
}

const ACTIVITY_STATUS_VALUES = new Set<ActivityStatus>([
  "needs_attention",
  "in_progress",
  "recent",
]);
const ACTIVITY_TONE_VALUES = new Set<ActivityTone>(["error", "info", "success", "warning"]);
const ACTIVITY_SOURCE_VALUES = new Set<ActivitySource>([
  "automation",
  "maintenance",
  "provider",
  "system",
  "terminal",
  "thread",
  "update",
]);
const SETTINGS_SECTION_VALUES = new Set<string>(SETTINGS_SECTION_IDS);
const SETTINGS_TARGET_VALUES = new Set<string>(Object.values(SETTINGS_TARGETS));

function isValidDestination(value: unknown): value is ActivityDestination {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<ActivityDestination> & {
    section?: unknown;
    stateStartedAt?: unknown;
    target?: unknown;
    threadId?: unknown;
  };
  if (candidate.type === "thread") {
    return typeof candidate.threadId === "string" && candidate.threadId.length > 0;
  }
  if (candidate.type === "connection_diagnostics") {
    return (
      typeof candidate.stateStartedAt === "string" &&
      Number.isFinite(Date.parse(candidate.stateStartedAt))
    );
  }
  if (candidate.type !== "settings") return false;
  return (
    (candidate.section === undefined ||
      (typeof candidate.section === "string" && SETTINGS_SECTION_VALUES.has(candidate.section))) &&
    (candidate.target === undefined ||
      (typeof candidate.target === "string" && SETTINGS_TARGET_VALUES.has(candidate.target)))
  );
}

export function normalizePersistedItems(value: unknown, nowMs = Date.now()): ActivityItem[] {
  if (!Array.isArray(value)) return [];
  const retentionCutoff = nowMs - ACTIVITY_RETENTION_MS;
  const validated = value
    .filter((item): item is ActivityItem => {
      if (!item || typeof item !== "object") return false;
      const candidate = item as Partial<ActivityItem>;
      return (
        typeof candidate.id === "string" &&
        typeof candidate.dedupeKey === "string" &&
        candidate.dedupeKey.length > 0 &&
        typeof candidate.source === "string" &&
        ACTIVITY_SOURCE_VALUES.has(candidate.source as ActivitySource) &&
        typeof candidate.status === "string" &&
        ACTIVITY_STATUS_VALUES.has(candidate.status as ActivityStatus) &&
        typeof candidate.tone === "string" &&
        ACTIVITY_TONE_VALUES.has(candidate.tone as ActivityTone) &&
        typeof candidate.title === "string" &&
        candidate.title.length > 0 &&
        (candidate.description === undefined || typeof candidate.description === "string") &&
        (candidate.destination === undefined || isValidDestination(candidate.destination)) &&
        typeof candidate.createdAt === "string" &&
        Number.isFinite(Date.parse(candidate.createdAt)) &&
        typeof candidate.updatedAt === "string" &&
        Number.isFinite(Date.parse(candidate.updatedAt)) &&
        (candidate.readAt === undefined ||
          (typeof candidate.readAt === "string" &&
            Number.isFinite(Date.parse(candidate.readAt)))) &&
        Date.parse(candidate.updatedAt) >= retentionCutoff
      );
    })
    .map((item) => {
      if (Date.parse(item.updatedAt) <= nowMs + ACTIVITY_FUTURE_TOLERANCE_MS) return item;
      const recoveredAt = new Date(nowMs).toISOString();
      return {
        ...item,
        createdAt:
          Date.parse(item.createdAt) > nowMs + ACTIVITY_FUTURE_TOLERANCE_MS
            ? recoveredAt
            : item.createdAt,
        updatedAt: recoveredAt,
        readAt:
          item.readAt && Date.parse(item.readAt) > nowMs + ACTIVITY_FUTURE_TOLERANCE_MS
            ? undefined
            : item.readAt,
      };
    })
    .toSorted((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt));

  const dedupeKeys = new Set<string>();
  const ids = new Set<string>();
  const normalized: ActivityItem[] = [];
  for (const item of validated) {
    if (dedupeKeys.has(item.dedupeKey)) continue;
    dedupeKeys.add(item.dedupeKey);
    const uniqueItem = ids.has(item.id) ? { ...item, id: createActivityId(nowMs) } : item;
    ids.add(uniqueItem.id);
    normalized.push(uniqueItem);
    if (normalized.length >= MAX_ACTIVITY_ITEMS) break;
  }
  return normalized;
}

export const useActivityStore = create<ActivityStore>()(
  persist(
    (set, get) => ({
      items: [],
      publish: (input) => {
        const next = upsertActivityItems(get().items, input);
        set({ items: next.items });
        return next.id;
      },
      markRead: (id) => {
        const readAt = new Date().toISOString();
        set((state) => ({
          items: state.items.map((item) =>
            item.id === id && !item.readAt ? { ...item, readAt } : item,
          ),
        }));
      },
      markAllRead: () => {
        const readAt = new Date().toISOString();
        set((state) => ({
          items: state.items.map((item) => (item.readAt ? item : { ...item, readAt })),
        }));
      },
      remove: (dedupeKey) => {
        set((state) => ({ items: state.items.filter((item) => item.dedupeKey !== dedupeKey) }));
      },
      clearRead: () => {
        set((state) => ({
          items: state.items.filter((item) => item.status !== "recent" || !item.readAt),
        }));
      },
      reset: () => set({ items: [] }),
    }),
    {
      name: ACTIVITY_STORAGE_KEY,
      version: 1,
      storage: createJSONStorage(() =>
        typeof localStorage === "undefined" ? fallbackStorage : localStorage,
      ),
      partialize: (state) => ({ items: state.items }),
      merge: (persisted, current) => ({
        ...current,
        items: normalizePersistedItems((persisted as Partial<ActivityStore> | undefined)?.items),
      }),
    },
  ),
);

export const activityManager = {
  publish(input: PublishActivityInput): string {
    return useActivityStore.getState().publish(input);
  },
  remove(dedupeKey: string): void {
    useActivityStore.getState().remove(dedupeKey);
  },
  markRead(id: string): void {
    useActivityStore.getState().markRead(id);
  },
};
