import * as Schema from "effect/Schema";
import {
  getLocalStorageItem,
  setLocalStorageItem,
  removeLocalStorageItem,
} from "~/hooks/useLocalStorage";

const Draft = Schema.Struct({ source: Schema.String, baseRevision: Schema.String });
type Draft = typeof Draft.Type;
// This window's checkpoints that are not written yet. Anything written is read
// from storage each time, because other windows share it.
const drafts = new Map<string, Draft>();
// Compare the slot against the version this writer observed. A delayed timer
// must not replace a newer checkpoint written by a different app window.
const observed = new Map<string, string | null>();
const pending = new Map<string, ReturnType<typeof setTimeout>>();
// Stored records that wait in their slot for the user's choice.
const held = new Map<string, Draft>();
const same = (a: Draft, b: Draft) => a.source === b.source && a.baseRevision === b.baseRevision;
const storageKey = (key: string) => `scient:latex-visual-draft:source:${key}`;

/** One source copy, coalesced off the input path. Workspace saving owns durability. */
export function checkpointVisualDraft(
  key: string,
  _text: string,
  _before: string,
  source: string,
  baseRevision: string,
): void {
  if (!observed.has(key)) {
    try {
      observed.set(key, localStorage.getItem(storageKey(key)));
    } catch {
      window.dispatchEvent(new CustomEvent("scient-latex-recovery-error", { detail: key }));
    }
  }
  drafts.set(key, { source, baseRevision });
  if (pending.has(key)) return;
  pending.set(
    key,
    setTimeout(() => flushVisualDraft(key), 200),
  );
}

/** Flush on exit, or before handing an unconverted typing draft to source recovery. */
export function flushVisualDraft(key: string): boolean {
  clearTimeout(pending.get(key));
  pending.delete(key);
  const draft = drafts.get(key);
  if (!draft) return true;
  // The slot holds work the user has not decided about. The checkpoint stays
  // unwritten, in memory, until that work is resolved.
  if (occupiedByHeldDraft(key, draft)) return false;
  try {
    const persisted = readPersisted(key);
    const identity = localStorage.getItem(storageKey(key));
    const expected = observed.get(key);
    if (identity !== null && identity !== expected && (!persisted || !same(persisted, draft))) {
      window.dispatchEvent(new CustomEvent("scient-latex-recovery-error", { detail: key }));
      return false;
    }
    setLocalStorageItem(storageKey(key), draft, Draft);
    observed.set(key, localStorage.getItem(storageKey(key)));
    drafts.delete(key);
    return true;
  } catch {
    window.dispatchEvent(new CustomEvent("scient-latex-recovery-error", { detail: key }));
    return false;
  }
}

function readPersisted(key: string): Draft | null {
  try {
    return getLocalStorageItem(storageKey(key), Draft);
  } catch {
    return null;
  }
}

function removePersisted(key: string): boolean {
  try {
    removeLocalStorageItem(storageKey(key));
    return true;
  } catch {
    window.dispatchEvent(new CustomEvent("scient-latex-recovery-error", { detail: key }));
    return false;
  }
}

function dropUnwritten(key: string): void {
  clearTimeout(pending.get(key));
  pending.delete(key);
  drafts.delete(key);
  observed.delete(key);
}

function occupiedByHeldDraft(key: string, incoming: Draft): boolean {
  const occupant = held.get(key);
  if (!occupant) return false;
  const persisted = readPersisted(key);
  if (!persisted || !same(persisted, occupant)) {
    // No longer the record that was held: the slot follows the ordinary rules again.
    held.delete(key);
    return false;
  }
  return !same(incoming, occupant);
}

/**
 * Keep this window's checkpoints from replacing a stored record that is being
 * offered to the user from its slot. The hold belongs to the record, not to
 * the editor that offered it: it lasts for every editor of the document until
 * the record leaves the slot (applied, discarded, parked, or cleared because
 * its source was saved) or another window replaces it.
 */
export function holdPersistedVisualDraft(key: string, draft: Draft): void {
  held.set(key, draft);
}

export function releasePersistedVisualDraft(key: string): void {
  held.delete(key);
}

export function clearVisualDraft(key: string): void {
  held.delete(key);
  dropUnwritten(key);
  removePersisted(key);
}

/**
 * Remove the copies that match, and only those. This window's unwritten
 * checkpoint and the persisted record are judged separately: neither goes
 * because the other matched, and neither stays because the other did not.
 */
function clearMatching(key: string, matches: (draft: Draft) => boolean): boolean {
  const unwritten = drafts.get(key);
  const persisted = readPersisted(key);
  const unwrittenMatches = unwritten !== undefined && matches(unwritten);
  const persistedMatches = persisted !== null && matches(persisted);
  if (unwrittenMatches) dropUnwritten(key);
  const removed = persistedMatches && removePersisted(key);
  return unwrittenMatches || removed;
}

export function confirmVisualDraft(key: string, source: string): boolean {
  return clearMatching(key, (draft) => draft.source === source);
}

export function discardVisualDraft(key: string, discarded: Draft): boolean {
  return clearMatching(key, (draft) => same(draft, discarded));
}

/**
 * Store a record only where the slot is empty or already holds it. A slot that
 * holds a different record is never taken: that record may be the only copy of
 * someone's unsaved work.
 */
export function storeVisualDraftInFreeSlot(key: string, draft: Draft): boolean {
  const persisted = readPersisted(key);
  if (persisted && !same(persisted, draft)) return false;
  try {
    setLocalStorageItem(storageKey(key), draft, Draft);
    return true;
  } catch {
    return false;
  }
}

/** The record in storage now, ignoring this window's unwritten checkpoint. */
export function readPersistedVisualDraft(key: string): Draft | null {
  return readPersisted(key);
}

/** Remove the persisted record only if it is still exactly `draft`; unwritten checkpoints stay. */
export function removePersistedVisualDraft(key: string, draft: Draft): boolean {
  const persisted = readPersisted(key);
  if (!persisted || !same(persisted, draft)) return false;
  return removePersisted(key);
}
