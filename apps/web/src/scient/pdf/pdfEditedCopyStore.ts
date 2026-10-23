import { PdfSourceDescriptor } from "@scientfactory/document-artifacts";
import * as Schema from "effect/Schema";
import { useSyncExternalStore } from "react";

const SavedCopy = Schema.Struct({
  source: PdfSourceDescriptor,
  sessionKey: Schema.String,
  showOriginal: Schema.Boolean,
});
export type SavedPdfEditedCopy = typeof SavedCopy.Type;
const decode = Schema.decodeUnknownSync(Schema.fromJsonString(SavedCopy));
const prefix = "scient.pdf-edited-copy.v1:";
const cache = new Map<string, SavedPdfEditedCopy | null>();
const listeners = new Set<() => void>();

function readCopy(key: string) {
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

export function usePdfEditedCopy(key: string) {
  return useSyncExternalStore(
    subscribe,
    () => readCopy(key),
    () => null,
  );
}

export function rememberPdfEditedCopy(key: string, copy: SavedPdfEditedCopy) {
  cache.set(key, copy);
  let durable = true;
  try {
    localStorage.setItem(prefix + key, JSON.stringify(copy));
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
