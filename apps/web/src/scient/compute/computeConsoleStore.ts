import type { ComputeExecutionRecord } from "@t3tools/contracts";
import { create } from "zustand";

import type { ThreadRightPanelState } from "~/rightPanelStore";
import type { ScientRightPanelSurface } from "../rightPanel/surfaces";

import { getComputeContext, type ComputeContextId } from "./computeContextStore";

interface ComputeConsoleState {
  /** What is typed and not yet run, so it survives moving between tabs. */
  readonly drafts: Readonly<Record<string, string>>;
  /** The language each Console runs, for its tab. */
  readonly languages: Readonly<Record<string, string>>;
  /** The runtime picked for a Console, until it has a session of its own to go by. */
  readonly runtimes: Readonly<Record<string, string>>;
  setDraft: (contextId: ComputeContextId, draft: string) => void;
  setLanguage: (contextId: ComputeContextId, languageId: string) => void;
  chooseRuntime: (contextId: ComputeContextId, runtimeKey: string) => void;
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
  chooseRuntime: (contextId, runtimeKey) =>
    set((state) => ({ runtimes: { ...state.runtimes, [contextId]: runtimeKey } })),
  forget: (contextId) =>
    set((state) => ({
      drafts: without(state.drafts, contextId),
      languages: without(state.languages, contextId),
      runtimes: without(state.runtimes, contextId),
    })),
}));

/** What was typed at this Console, oldest first, for Up and Down to walk through. */
export function computeConsoleHistory(
  executions: ReadonlyArray<ComputeExecutionRecord>,
): ReadonlyArray<string> {
  return executions
    .filter((execution) => execution.request.source._tag === "console")
    .toSorted((left, right) => left.request.submittedAt.localeCompare(right.request.submittedAt))
    .map((execution) => execution.request.code);
}

/** Nothing has run here and nothing is typed, so the tab can become whatever opens next. */
export function computeConsoleIsEmpty(contextId: ComputeContextId): boolean {
  const binding = getComputeContext(contextId);
  const draft = useComputeConsoleStore.getState().drafts[contextId] ?? "";
  return (binding === null || binding.sessionId === null) && draft.trim() === "";
}

export function findEmptyComputeConsole(
  panel: Pick<ThreadRightPanelState, "surfaces" | "activeSurfaceId"> | undefined,
  cwd: string,
) {
  const emptyConsoles = panel?.surfaces.filter(
    (surface): surface is Extract<ScientRightPanelSurface, { module: "compute" }> =>
      surface.kind === "scient" &&
      surface.module === "compute" &&
      surface.cwd === cwd &&
      surface.contextId !== undefined &&
      computeConsoleIsEmpty(surface.contextId),
  );
  return (
    emptyConsoles?.find((surface) => surface.id === panel?.activeSurfaceId) ?? emptyConsoles?.at(-1)
  );
}
