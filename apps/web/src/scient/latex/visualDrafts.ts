import * as Schema from "effect/Schema";
import {
  getLocalStorageItem,
  setLocalStorageItem,
  removeLocalStorageItem,
} from "~/hooks/useLocalStorage";

const Draft = Schema.Struct({ source: Schema.String, baseRevision: Schema.String });
type Draft = typeof Draft.Type;
const drafts = new Map<string, Draft>();
const pending = new Map<string, ReturnType<typeof setTimeout>>();
const storageKey = (key: string) => `scient:latex-visual-draft:source:${key}`;

function load(key: string): Draft | null {
  const memory = drafts.get(key);
  if (memory) return memory;
  try {
    const saved = getLocalStorageItem(storageKey(key), Draft);
    if (saved) drafts.set(key, saved);
    return saved;
  } catch {
    return null;
  }
}

export function readVisualDraft(
  key: string,
  current?: { source: string; revision: string },
): string | null {
  const draft = load(key);
  return draft && draft.source !== current?.source ? draft.source : null;
}

/** A recovered whole-file draft cannot replace a newer disk revision. */
export function canRestoreVisualDraft(key: string, revision: string): boolean {
  return load(key)?.baseRevision === revision;
}

/** One source copy, coalesced off the input path. Workspace saving owns durability. */
export function checkpointVisualDraft(
  key: string,
  _text: string,
  _before: string,
  source: string,
  baseRevision: string,
): void {
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
  try {
    setLocalStorageItem(storageKey(key), draft, Draft);
    return true;
  } catch {
    window.dispatchEvent(new CustomEvent("scient-latex-recovery-error", { detail: key }));
    return false;
  }
}

export function clearVisualDraft(key: string): void {
  clearTimeout(pending.get(key));
  pending.delete(key);
  drafts.delete(key);
  try {
    removeLocalStorageItem(storageKey(key));
  } catch {
    /* Workspace saves remain authoritative. */
  }
}

export function confirmVisualDraft(key: string, source: string): boolean {
  if (load(key)?.source !== source) return false;
  clearVisualDraft(key);
  return true;
}

export function discardVisualDraft(key: string, discarded: Draft): boolean {
  const draft = load(key);
  if (!draft || draft.source !== discarded.source || draft.baseRevision !== discarded.baseRevision)
    return false;
  clearVisualDraft(key);
  return true;
}
