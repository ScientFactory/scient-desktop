import { create } from "zustand";

import type { ComputeContextId } from "./computeContextStore";
import type { ComputeFileView } from "./computeFileSurfaceModel";

export type ComputePanelView = "results" | "variables";

export interface ComputeFilePresentation {
  readonly view: ComputeFileView;
  readonly panelView: ComputePanelView;
  readonly resultsContextId: ComputeContextId | null;
}

interface ComputeFilePresentationStore {
  readonly presentations: Readonly<Record<string, ComputeFilePresentation>>;
  setFileView: (contextId: ComputeContextId, view: ComputeFileView) => void;
  setPanelView: (contextId: ComputeContextId, view: ComputePanelView) => void;
  setResultsContext: (
    contextId: ComputeContextId,
    resultsContextId: ComputeContextId | null,
  ) => void;
  remove: (contextId: ComputeContextId) => void;
}

const DEFAULT_PRESENTATION: ComputeFilePresentation = {
  view: "code",
  panelView: "results",
  resultsContextId: null,
};

function presentationFor(
  presentations: ComputeFilePresentationStore["presentations"],
  contextId: ComputeContextId,
): ComputeFilePresentation {
  return presentations[contextId] ?? DEFAULT_PRESENTATION;
}

/**
 * Ephemeral UI state for an owning file tab. It intentionally outlives React
 * mounts (thread and right-panel navigation) but is removed with the owning tab;
 * durable session state remains in the separate compute-context store.
 */
export const useComputeFilePresentationStore = create<ComputeFilePresentationStore>((set) => ({
  presentations: {},
  setResultsContext: (contextId, resultsContextId) =>
    set((state) => ({
      presentations: {
        ...state.presentations,
        [contextId]: { ...presentationFor(state.presentations, contextId), resultsContextId },
      },
    })),
  setFileView: (contextId, view) =>
    set((state) => ({
      presentations: {
        ...state.presentations,
        [contextId]: { ...presentationFor(state.presentations, contextId), view },
      },
    })),
  setPanelView: (contextId, panelView) =>
    set((state) => ({
      presentations: {
        ...state.presentations,
        [contextId]: { ...presentationFor(state.presentations, contextId), panelView },
      },
    })),
  remove: (contextId) =>
    set((state) => {
      if (state.presentations[contextId] === undefined) return state;
      const presentations = { ...state.presentations };
      delete presentations[contextId];
      return { presentations };
    }),
}));

export function getComputeFilePresentation(contextId: ComputeContextId): ComputeFilePresentation {
  return presentationFor(useComputeFilePresentationStore.getState().presentations, contextId);
}
