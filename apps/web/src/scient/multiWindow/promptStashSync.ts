import type { PromptStashEntry } from "../../promptStashStore";
import { createCrossWindowStateSync, mergeWindowEntries } from "./crossWindowMerge";

type StashEntries = ReadonlyArray<PromptStashEntry>;
type StashEntriesById = Readonly<Record<string, PromptStashEntry>>;

const byId = (entries: StashEntries): StashEntriesById =>
  Object.fromEntries(entries.map((entry) => [entry.id, entry]));

const newestFirst = (left: PromptStashEntry, right: PromptStashEntry) =>
  left.createdAt < right.createdAt ? 1 : left.createdAt > right.createdAt ? -1 : 0;

/**
 * App windows share the stash. A save keeps the entries other windows stashed, took or finished
 * since this window last heard from them, and adopting another window's save keeps the changes
 * this window has not managed to save.
 */
export function createPromptStashWindowSync(read: () => StashEntries | null) {
  const sync = createCrossWindowStateSync<StashEntriesById>({
    read: () => {
      const entries = read();
      return entries && byId(entries);
    },
    merge: mergeWindowEntries,
  });
  const mergeWith = (
    entries: StashEntries,
    merge: (local: StashEntriesById) => StashEntriesById,
  ) => {
    const local = byId(entries);
    const merged = merge(local);
    return merged === local ? entries : Object.values(merged).toSorted(newestFirst);
  };
  return {
    setBaseline: (entries: StashEntries): void => sync.setBaseline(byId(entries)),
    mergeForWrite: (entries: StashEntries): StashEntries => mergeWith(entries, sync.mergeForWrite),
    didWrite: (entries: StashEntries): void => sync.didWrite(byId(entries)),
    adoptStored: (entries: StashEntries): StashEntries => mergeWith(entries, sync.adoptStored),
  };
}
