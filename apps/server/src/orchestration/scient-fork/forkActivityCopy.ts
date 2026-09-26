/**
 * Which origin activities a fork copies, and how large their payloads may be.
 *
 * SCIENT-OWNED. A fork should read like its source up to the fork point, so the
 * visible work log (tool calls, their results, subagent tasks, runtime notices,
 * plan steps) is copied with the transcript. Nothing executable is copied:
 * approval and question requests belong to the origin's live provider and
 * must never become answerable in the fork. Context-window reports describe the
 * origin's provider session, not the fork's, so they are not copied either.
 *
 * Tool output is stored uncapped by ingestion. A fork keeps each string field
 * to a bounded head and tail so a long command log cannot bloat every fork.
 */
import type { OrchestrationThreadActivity } from "@t3tools/contracts";

export const FORK_COPIED_ACTIVITY_KINDS: ReadonlySet<string> = new Set([
  "tool.updated",
  "tool.completed",
  "tool.denied",
  "task.started",
  "task.progress",
  "task.completed",
  "runtime.error",
  "runtime.warning",
  "turn.plan.updated",
]);

/** Largest string kept verbatim in a copied activity payload. */
export const FORK_ACTIVITY_STRING_MAX_CHARS = 8_192;
const HEAD_CHARS = 6_144;
const TAIL_CHARS = 1_536;
const MAX_ARRAY_ITEMS = 200;
const MAX_DEPTH = 12;

export const FORK_TRUNCATION_MARKER = "[… truncated in fork …]";

export function isForkCopiedActivity(activity: OrchestrationThreadActivity): boolean {
  return FORK_COPIED_ACTIVITY_KINDS.has(activity.kind);
}

function capString(value: string): string {
  if (value.length <= FORK_ACTIVITY_STRING_MAX_CHARS) return value;
  return `${value.slice(0, HEAD_CHARS)}\n${FORK_TRUNCATION_MARKER}\n${value.slice(-TAIL_CHARS)}`;
}

/** Bounds every string and array in an activity payload; structure is kept. */
export function capForkActivityPayload(value: unknown, depth = 0): unknown {
  if (typeof value === "string") return capString(value);
  if (value === null || typeof value !== "object") return value;
  if (depth >= MAX_DEPTH) return FORK_TRUNCATION_MARKER;
  if (Array.isArray(value)) {
    const kept = value
      .slice(0, MAX_ARRAY_ITEMS)
      .map((item: unknown) => capForkActivityPayload(item, depth + 1));
    return value.length > MAX_ARRAY_ITEMS ? [...kept, FORK_TRUNCATION_MARKER] : kept;
  }
  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [key, capForkActivityPayload(entry, depth + 1)]),
  );
}
