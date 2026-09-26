import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  type EnvironmentId,
  type ScopedThreadRef,
  type ThreadId,
  ThreadSectionId,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { useEffect } from "react";

import { getLocalStorageItem, setLocalStorageItem } from "../../hooks/useLocalStorage";

/**
 * "New thread in this section" opens an ordinary draft. The draft already
 * knows the thread id it will create, so the section is remembered here and
 * filed once that thread exists on the server. Entries outlive a restart and
 * expire after a week, so an abandoned draft leaves nothing behind for long.
 */
const STORAGE_KEY = "scient:sidebar:pending-new-thread-sections";
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

const PendingEntries = Schema.Record(
  Schema.String,
  Schema.Struct({ sectionId: Schema.String, rememberedAt: Schema.Number }),
);
type PendingEntries = typeof PendingEntries.Type;

// Read once; the apply hook runs on every shell update and must stay cheap.
let cache: PendingEntries | null = null;

function read(): PendingEntries {
  if (cache === null) {
    try {
      cache = getLocalStorageItem(STORAGE_KEY, PendingEntries) ?? {};
    } catch {
      cache = {};
    }
  }
  return cache;
}

function write(entries: PendingEntries): void {
  cache = entries;
  setLocalStorageItem(STORAGE_KEY, entries, PendingEntries);
}

export function rememberSectionForNewThread(threadId: string, sectionId: ThreadSectionId): void {
  write({ ...read(), [threadId]: { sectionId, rememberedAt: Date.now() } });
}

/** Files each newly created thread whose draft was opened from a section. */
export function useApplyPendingNewThreadSections(input: {
  readonly threads: ReadonlyArray<{
    readonly id: ThreadId;
    readonly environmentId: EnvironmentId;
    readonly sectionId?: string | null | undefined;
  }>;
  readonly apply: (target: ScopedThreadRef, sectionId: ThreadSectionId) => void;
}): void {
  const { apply, threads } = input;
  useEffect(() => {
    const entries = read();
    const ids = Object.keys(entries);
    if (ids.length === 0) return;
    const now = Date.now();
    const next: Record<string, PendingEntries[string]> = { ...entries };
    let changed = false;
    for (const id of ids) {
      const entry = entries[id]!;
      const thread = threads.find((candidate) => candidate.id === id);
      if (thread !== undefined) {
        delete next[id];
        changed = true;
        if (thread.sectionId == null) {
          apply(
            scopeThreadRef(thread.environmentId, thread.id),
            ThreadSectionId.make(entry.sectionId),
          );
        }
      } else if (now - entry.rememberedAt > MAX_AGE_MS) {
        delete next[id];
        changed = true;
      }
    }
    if (changed) write(next);
  }, [apply, threads]);
}
