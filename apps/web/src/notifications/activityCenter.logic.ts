// FILE: activityCenter.logic.ts
// Purpose: Derives stable Activity Center groups, labels, and sidebar summary copy.
// Layer: Notification presentation logic

import type { ActivityItem, ActivityStatus } from "./activityStore";

export const ACTIVITY_GROUP_ORDER = ["needs_attention", "in_progress", "recent"] as const;

export const ACTIVITY_GROUP_LABEL: Record<ActivityStatus, string> = {
  needs_attention: "Needs attention",
  in_progress: "In progress",
  recent: "Recent",
};

export function groupActivityItems(
  items: readonly ActivityItem[],
): Record<ActivityStatus, ActivityItem[]> {
  return {
    needs_attention: items.filter((item) => item.status === "needs_attention"),
    in_progress: items.filter((item) => item.status === "in_progress"),
    recent: items.filter((item) => item.status === "recent"),
  };
}

export function prioritizeActivityItemsForPreview(
  items: readonly ActivityItem[],
  limit: number,
): ActivityItem[] {
  if (limit <= 0) return [];
  return ACTIVITY_GROUP_ORDER.flatMap((status) =>
    items.filter((item) => item.status === status),
  ).slice(0, limit);
}

export function unreadActivityCount(items: readonly ActivityItem[]): number {
  return items.filter((item) => !item.readAt).length;
}

export function activitySidebarSummary(items: readonly ActivityItem[]): string {
  const attentionCount = items.filter((item) => item.status === "needs_attention").length;
  if (attentionCount > 0) {
    return `${attentionCount} ${attentionCount === 1 ? "needs" : "need"} attention`;
  }
  const progressCount = items.filter((item) => item.status === "in_progress").length;
  if (progressCount > 0) {
    return `${progressCount} in progress`;
  }
  const unreadCount = unreadActivityCount(items);
  if (unreadCount > 0) {
    return `${unreadCount} new`;
  }
  return "All caught up";
}

export function formatActivityRelativeTime(timestamp: string, nowMs = Date.now()): string {
  const timestampMs = Date.parse(timestamp);
  if (!Number.isFinite(timestampMs)) return "Now";
  const elapsedMs = Math.max(0, nowMs - timestampMs);
  const minutes = Math.floor(elapsedMs / 60_000);
  if (minutes < 1) return "Now";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d`;
  return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" }).format(
    new Date(timestampMs),
  );
}
