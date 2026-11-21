import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { useEffect } from "react";
import { create } from "zustand";

import { useRightPanelStore } from "~/rightPanelStore";
import { scientSourcesSurface } from "~/scient/rightPanel/surfaces";

/** What the Library should show next: one source, or the whole personal library. */
type LibraryRequestTarget =
  | { readonly kind: "source"; readonly sourceId: string }
  | { readonly kind: "library" };

interface LibrarySourceRequestState {
  /**
   * One pending request per thread and project root. Threads without a project share one root, so
   * the thread keeps another thread's Library from taking the request.
   */
  readonly byKey: Readonly<
    Record<string, { readonly id: number; readonly target: LibraryRequestTarget }>
  >;
}

let nextRequestId = 1;

const useLibrarySourceRequestStore = create<LibrarySourceRequestState>(() => ({
  byKey: {},
}));

function requestKey(threadRef: ScopedThreadRef, root: string): string {
  return `${scopedThreadKey(threadRef)}\u0000${root}`;
}

function openLibrary(threadRef: ScopedThreadRef, root: string, target: LibraryRequestTarget): void {
  const key = requestKey(threadRef, root);
  useLibrarySourceRequestStore.setState((state) => ({
    byKey: { ...state.byKey, [key]: { id: nextRequestId++, target } },
  }));
  useRightPanelStore.getState().openScient(threadRef, scientSourcesSurface());
}

/** Opens the Library beside the document, showing one source. */
export function openLibrarySource(input: {
  readonly threadRef: ScopedThreadRef;
  readonly root: string;
  readonly sourceId: string;
}): void {
  openLibrary(input.threadRef, input.root, { kind: "source", sourceId: input.sourceId });
}

/**
 * Opens the Library over the whole window, listing the whole personal library rather than its
 * project. **Restore panel size** brings the thread back beside it.
 */
export function openWholeLibrary(input: {
  readonly threadRef: ScopedThreadRef;
  readonly root: string;
}): void {
  openLibrary(input.threadRef, input.root, { kind: "library" });
  useRightPanelStore.getState().setMaximized(input.threadRef, true);
}

function acknowledgeLibrarySourceRequest(key: string, id: number): void {
  useLibrarySourceRequestStore.setState((state) => {
    if (state.byKey[key]?.id !== id) return state;
    const { [key]: _done, ...rest } = state.byKey;
    return { byKey: rest };
  });
}

/** Lets the thread's Library panel for `root` act on a request once its sources are loaded. */
export function useLibrarySourceRequest(
  threadRef: ScopedThreadRef,
  root: string,
  ready: boolean,
  show: (sourceId: string) => void,
  showWholeLibrary: () => void,
): void {
  const key = requestKey(threadRef, root);
  const request = useLibrarySourceRequestStore((state) => state.byKey[key] ?? null);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- a document asked the Library to show a source; the request lives in a store outside this panel
  useEffect(() => {
    if (!request || !ready) return;
    if (request.target.kind === "source") show(request.target.sourceId);
    else showWholeLibrary();
    acknowledgeLibrarySourceRequest(key, request.id);
  }, [key, ready, request, show, showWholeLibrary]);
}

/** Changes whenever the Library panel shows a changed Library, so documents can read it again. */
export const useLibraryVersionStore = create<{
  readonly byRoot: Readonly<Record<string, string>>;
}>(() => ({ byRoot: {} }));

export function publishLibraryVersion(root: string, version: string): void {
  useLibraryVersionStore.setState((state) =>
    state.byRoot[root] === version ? state : { byRoot: { ...state.byRoot, [root]: version } },
  );
}
