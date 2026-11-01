import { PdfSourceDescriptor } from "@scientfactory/document-artifacts";
import * as Schema from "effect/Schema";
import { useSyncExternalStore } from "react";

const SavedCopy = Schema.Struct({
  source: PdfSourceDescriptor,
  sessionKey: Schema.String,
  showOriginal: Schema.Boolean,
  savedAt: Schema.Number,
});
export type SavedPdfEditedCopy = typeof SavedCopy.Type;
const decode = Schema.decodeUnknownSync(Schema.fromJsonString(SavedCopy));
const prefix = "scient.pdf-edited-copy.v1:";
const MAX_REMEMBERED_COPIES = 100;
const cache = new Map<string, SavedPdfEditedCopy | null>();
const listeners = new Set<() => void>();

export function readPdfEditedCopy(key: string) {
  if (cache.has(key)) return cache.get(key)!;
  let value: SavedPdfEditedCopy | null = null;
  try {
    const stored = localStorage.getItem(prefix + key);
    if (stored) {
      const decoded = decode(stored);
      if (decoded.source._tag === "generated-pdf") value = decoded;
    }
  } catch {
    // A damaged preference cannot prevent opening the original PDF.
  }
  cache.set(key, value);
  return value;
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * Copies of a generated PDF are remembered per revision: a rebuild shows the
 * new build, and a save still finishing for an older build cannot replace the
 * newer build's copy.
 */
export function pdfEditedCopyKey(documentKey: string, original: PdfSourceDescriptor) {
  return original._tag === "generated-pdf"
    ? JSON.stringify([documentKey, original.revisionId])
    : documentKey;
}

export function usePdfEditedCopy(key: string) {
  return useSyncExternalStore(
    subscribe,
    () => readPdfEditedCopy(key),
    () => null,
  );
}

/** Forgets the least recently saved copies once more than the limit are remembered. */
function forgetOldCopies() {
  const remembered: { key: string; savedAt: number }[] = [];
  for (let index = 0; index < localStorage.length; index++) {
    const key = localStorage.key(index);
    if (!key?.startsWith(prefix)) continue;
    let savedAt = 0;
    try {
      savedAt = decode(localStorage.getItem(key) ?? "").savedAt;
    } catch {
      // Damaged entries are the first to go.
    }
    remembered.push({ key, savedAt });
  }
  remembered.sort((left, right) => left.savedAt - right.savedAt);
  for (const { key } of remembered.slice(
    0,
    Math.max(0, remembered.length - MAX_REMEMBERED_COPIES),
  )) {
    localStorage.removeItem(key);
    cache.delete(key.slice(prefix.length));
  }
}

export function rememberPdfEditedCopy(
  key: string,
  remembered: Omit<SavedPdfEditedCopy, "savedAt">,
) {
  const copy: SavedPdfEditedCopy = { ...remembered, savedAt: Date.now() };
  cache.set(key, copy);
  let durable = true;
  try {
    localStorage.setItem(prefix + key, JSON.stringify(copy));
    forgetOldCopies();
  } catch {
    durable = false;
  }
  for (const listener of listeners) listener();
  return durable;
}

if (typeof window !== "undefined")
  window.addEventListener("storage", (event) => {
    if (event.key === null) cache.clear();
    else if (event.key.startsWith(prefix)) cache.delete(event.key.slice(prefix.length));
    else return;
    for (const listener of listeners) listener();
  });
