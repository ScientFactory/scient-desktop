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

/**
 * Forgets any section remembered for a draft. New-thread requests reuse an
 * empty draft (and its thread id); one made from anywhere but a section must
 * not inherit a section chosen earlier.
 */
export function forgetSectionForNewThread(threadId: string): void {
  const entries = read();
  if (!(threadId in entries)) return;
  const { [threadId]: _forgotten, ...rest } = entries;
  write(rest);
}

// Threads whose filing is in flight, so shell updates don't file them twice.
const filing = new Set<string>();

type PendingThread = {
  readonly id: ThreadId;
  readonly environmentId: EnvironmentId;
  readonly sectionId?: string | null | undefined;
};
type ApplyPendingSection = (
  target: ScopedThreadRef,
  sectionId: ThreadSectionId,
) => Promise<boolean>;

/**
 * Files each newly created thread whose draft was opened from a section. An
 * entry is dropped only once its write succeeds; a failed write is retried on
 * a later update until the entry expires.
 */
export function applyPendingNewThreadSections(
  threads: ReadonlyArray<PendingThread>,
  apply: ApplyPendingSection,
  now = Date.now(),
): void {
  const entries = read();
  const ids = Object.keys(entries);
  if (ids.length === 0) return;
  const expired: string[] = [];
  for (const id of ids) {
    const entry = entries[id]!;
    const thread = threads.find((candidate) => candidate.id === id);
    if (thread === undefined) {
      if (now - entry.rememberedAt > MAX_AGE_MS) expired.push(id);
      continue;
    }
    // Our optimistic membership is not an acknowledgment of the pending write.
    if (filing.has(id)) continue;
    // Already filed (here or by another window): nothing left to do.
    if (thread.sectionId != null) {
      forgetSectionForNewThread(id);
      continue;
    }
    filing.add(id);
    void apply(
      scopeThreadRef(thread.environmentId, thread.id),
      ThreadSectionId.make(entry.sectionId),
    )
      .then(
        (filed) => {
          if (filed && read()[id] === entry) forgetSectionForNewThread(id);
        },
        () => {
          // Preserve the entry when a transport unexpectedly rejects.
        },
      )
      .finally(() => filing.delete(id));
  }
  if (expired.length > 0) {
    const next = { ...read() };
    for (const id of expired) delete next[id];
    write(next);
  }
}

/** Runs `applyPendingNewThreadSections` whenever the thread list changes. */
export function useApplyPendingNewThreadSections(input: {
  readonly threads: ReadonlyArray<PendingThread>;
  readonly apply: ApplyPendingSection;
}): void {
  const { apply, threads } = input;
  useEffect(() => applyPendingNewThreadSections(threads, apply), [apply, threads]);
}
