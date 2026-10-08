import type { EnvironmentId } from "@t3tools/contracts";

import type {
  DocumentTemplateId,
  NewDocumentFormat,
  NewDocumentLanguage,
} from "./documentTemplates";

/**
 * Documents started from the Documents menu in this window, until they have
 * taken their title's name. While a LaTeX one is untouched its template and
 * language can still change; once written in, that choice is over for good.
 * Held in memory only: after a reload a new document is an ordinary file.
 */
export interface NewDocumentState {
  readonly format: NewDocumentFormat;
  readonly template: DocumentTemplateId;
  readonly language: NewDocumentLanguage;
  /** The editor has shown the document exactly as Scient wrote it. */
  readonly seenUntouched: boolean;
  /** Set at the first edit beyond the title after that; the template row does not return. */
  readonly settled: boolean;
}

interface NewDocumentKey {
  readonly environmentId: EnvironmentId;
  readonly cwd: string;
  readonly relativePath: string;
}

const entries = new Map<string, NewDocumentState>();
const listeners = new Set<() => void>();

function keyOf(key: NewDocumentKey): string {
  return JSON.stringify([key.environmentId, key.cwd, key.relativePath]);
}

function notify() {
  for (const listener of listeners) listener();
}

export const newDocuments = {
  get(key: NewDocumentKey): NewDocumentState | null {
    return entries.get(keyOf(key)) ?? null;
  },
  set(key: NewDocumentKey, state: NewDocumentState) {
    entries.set(keyOf(key), state);
    notify();
  },
  update(key: NewDocumentKey, patch: Partial<NewDocumentState>) {
    const current = entries.get(keyOf(key));
    if (!current) return;
    entries.set(keyOf(key), { ...current, ...patch });
    notify();
  },
  /** After its one rename the document is an ordinary file. */
  forget(key: NewDocumentKey) {
    if (entries.delete(keyOf(key))) notify();
  },
  subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
};

/**
 * Whether the LaTeX editor still holds unfinished field text or recovered
 * work under this path, from an earlier file of the same name. A new document
 * takes another name rather than inheriting it; nothing stored is removed.
 */
export function pathHasLeftoverDrafts(key: NewDocumentKey): boolean {
  const marker = `${key.environmentId}\0${key.cwd}\0${key.relativePath}`;
  try {
    for (let index = 0; index < localStorage.length; index++) {
      const name = localStorage.key(index);
      if (name?.includes(marker)) return true;
    }
  } catch {
    /* Storage unavailable: nothing to inherit. */
  }
  return false;
}
