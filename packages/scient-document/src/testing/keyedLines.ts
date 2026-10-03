import type { DocumentReconciliation } from "../persistenceCoordinator.ts";

/**
 * A deliberately simple document format for tests, unrelated to any editor: one
 * `key=value` entry per line. It proves the coordinator works with any
 * format that supplies its own reconciliation.
 */
export interface KeyedLinesReconciliation extends DocumentReconciliation {
  readonly changedKeys: readonly string[];
}

function entries(source: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const line of source.split("\n")) {
    if (line.length === 0) continue;
    const separator = line.indexOf("=");
    const key = separator === -1 ? line : line.slice(0, separator);
    map.set(key, separator === -1 ? "" : line.slice(separator + 1));
  }
  return map;
}

/** Three-way merge by key; returns null when both sides changed the same key differently. */
export function reconcileKeyedLines(
  baselineSource: string,
  draftSource: string,
  diskSource: string,
): KeyedLinesReconciliation | null {
  const base = entries(baselineSource);
  const draft = entries(draftSource);
  const disk = entries(diskSource);
  const keys = [...new Set([...base.keys(), ...draft.keys(), ...disk.keys()])];
  const lines: string[] = [];
  const changedKeys: string[] = [];
  for (const key of keys) {
    const original = base.get(key);
    const local = draft.get(key);
    const external = disk.get(key);
    let value: string | undefined;
    if (local === external) value = local;
    else if (local === original) value = external;
    else if (external === original) value = local;
    else return null;
    if (value !== local) changedKeys.push(key);
    if (value !== undefined) lines.push(`${key}=${value}`);
  }
  return { source: lines.map((line) => `${line}\n`).join(""), changedKeys };
}
