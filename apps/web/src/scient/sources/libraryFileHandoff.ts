import { useEffect, useSyncExternalStore } from "react";

const pending = new Map<string, ReadonlyArray<File>>();
const listeners = new Set<() => void>();

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Hands PDFs to the Library of a project, which imports them as if they were dropped on it. */
export function requestLibraryFileImport(root: string, files: ReadonlyArray<File>): void {
  pending.set(root, [...(pending.get(root) ?? []), ...files]);
  for (const listener of listeners) listener();
}

/** Imports PDFs handed to this project's Library once it is ready to show their progress. */
export function useLibraryFileImport(
  root: string,
  ready: boolean,
  importFiles: (files: ReadonlyArray<File>) => void,
): void {
  const files = useSyncExternalStore(subscribe, () => pending.get(root) ?? null);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- takes PDFs handed over from a browser tab and starts their import once
  useEffect(() => {
    if (!ready || !files || pending.get(root) !== files) return;
    pending.delete(root);
    importFiles(files);
  }, [files, importFiles, ready, root]);
}
