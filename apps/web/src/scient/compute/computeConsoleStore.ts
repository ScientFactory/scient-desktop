import { create } from "zustand";

import { getComputeContext, type ComputeContextId } from "./computeContextStore";

interface ComputeConsoleState {
  /** What is typed and not yet run, so it survives moving between tabs. */
  readonly drafts: Readonly<Record<string, string>>;
  /** The language each Console runs, for its tab. */
  readonly languages: Readonly<Record<string, string>>;
  /** The runtime a Console opens with, when it was asked for one. */
  readonly runtimes: Readonly<Record<string, string>>;
  setDraft: (contextId: ComputeContextId, draft: string) => void;
  setLanguage: (contextId: ComputeContextId, languageId: string) => void;
  presetRuntime: (contextId: ComputeContextId, runtimeKey: string) => void;
  forget: (contextId: ComputeContextId) => void;
}

const without = (record: Readonly<Record<string, string>>, key: string) => {
  const { [key]: _removed, ...rest } = record;
  return rest;
};

export const useComputeConsoleStore = create<ComputeConsoleState>()((set) => ({
  drafts: {},
  languages: {},
  runtimes: {},
  setDraft: (contextId, draft) =>
    set((state) => ({ drafts: { ...state.drafts, [contextId]: draft } })),
  setLanguage: (contextId, languageId) =>
    set((state) =>
      state.languages[contextId] === languageId
        ? state
        : { languages: { ...state.languages, [contextId]: languageId } },
    ),
  presetRuntime: (contextId, runtimeKey) =>
    set((state) => ({ runtimes: { ...state.runtimes, [contextId]: runtimeKey } })),
  forget: (contextId) =>
    set((state) => ({
      drafts: without(state.drafts, contextId),
      languages: without(state.languages, contextId),
      runtimes: without(state.runtimes, contextId),
    })),
}));

/** Nothing has run here and nothing is typed, so the tab can become whatever opens next. */
export function computeConsoleIsEmpty(contextId: ComputeContextId): boolean {
  const binding = getComputeContext(contextId);
  const draft = useComputeConsoleStore.getState().drafts[contextId] ?? "";
  return (binding === null || binding.sessionId === null) && draft.trim() === "";
}
