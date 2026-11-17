import type { ScopedThreadRef } from "@t3tools/contracts";
import { useEffect } from "react";
import { create } from "zustand";

import { useRightPanelStore } from "~/rightPanelStore";
import { scientSourcesSurface } from "~/scient/rightPanel/surfaces";

interface LibrarySourceRequestState {
  /** One pending request per project root: the source the Library should show next. */
  readonly byRoot: Readonly<Record<string, { readonly id: number; readonly sourceId: string }>>;
}

let nextRequestId = 1;

const useLibrarySourceRequestStore = create<LibrarySourceRequestState>(() => ({
  byRoot: {},
}));

/** Opens the Library beside the document, showing one source. */
export function openLibrarySource(input: {
  readonly threadRef: ScopedThreadRef;
  readonly root: string;
  readonly sourceId: string;
}): void {
  useLibrarySourceRequestStore.setState((state) => ({
    byRoot: { ...state.byRoot, [input.root]: { id: nextRequestId++, sourceId: input.sourceId } },
  }));
  useRightPanelStore.getState().openScient(input.threadRef, scientSourcesSurface());
}

function acknowledgeLibrarySourceRequest(root: string, id: number): void {
  useLibrarySourceRequestStore.setState((state) => {
    if (state.byRoot[root]?.id !== id) return state;
    const { [root]: _done, ...rest } = state.byRoot;
    return { byRoot: rest };
  });
}

/** Lets the Library panel for `root` act on a request once its sources are loaded. */
export function useLibrarySourceRequest(
  root: string,
  ready: boolean,
  show: (sourceId: string) => void,
): void {
  const request = useLibrarySourceRequestStore((state) => state.byRoot[root] ?? null);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- a document asked the Library to show a source; the request lives in a store outside this panel
  useEffect(() => {
    if (!request || !ready) return;
    show(request.sourceId);
    acknowledgeLibrarySourceRequest(root, request.id);
  }, [ready, request, root, show]);
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
