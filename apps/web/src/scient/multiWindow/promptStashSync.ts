import type { PromptStashEntry } from "../../promptStashStore";
import { createCrossWindowStateSync, mergeWindowEntries } from "./crossWindowMerge";

type StashEntries = ReadonlyArray<PromptStashEntry>;
type StashEntriesById = Readonly<Record<string, PromptStashEntry>>;

const byId = (entries: StashEntries): StashEntriesById =>
  Object.fromEntries(entries.map((entry) => [entry.id, entry]));

const newestFirst = (left: PromptStashEntry, right: PromptStashEntry) =>
  left.createdAt < right.createdAt ? 1 : left.createdAt > right.createdAt ? -1 : 0;

/**
 * App windows share the stash. Adopting another window's save keeps the changes this window
 * has not managed to save, such as a removal its failed write left only in memory.
 */
export function createPromptStashWindowSync(read: () => StashEntries | null) {
  const sync = createCrossWindowStateSync<StashEntriesById>({
    read: () => {
      const entries = read();
      return entries && byId(entries);
    },
    merge: mergeWindowEntries,
  });
  return {
    setBaseline: (entries: StashEntries): void => sync.setBaseline(byId(entries)),
    didWrite: (entries: StashEntries): void => sync.didWrite(byId(entries)),
    adoptStored: (entries: StashEntries): StashEntries => {
      const local = byId(entries);
      const merged = sync.adoptStored(local);
      return merged === local ? entries : Object.values(merged).toSorted(newestFirst);
    },
  };
}
