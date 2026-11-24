import type { EnvironmentId } from "@t3tools/contracts";
import { create } from "zustand";

export function notebookRunDraftKey(environmentId: EnvironmentId, cwd: string, path: string) {
  return JSON.stringify([environmentId, cwd, path]);
}

type NotebookRunDraft = {
  readonly parameters?: Readonly<Record<string, string>>;
  readonly inputs?: ReadonlyArray<string>;
};

export const useNotebookRunDrafts = create<{
  readonly drafts: Readonly<Record<string, NotebookRunDraft | undefined>>;
  readonly update: (key: string, change: Partial<NotebookRunDraft>) => void;
}>((set) => ({
  drafts: {},
  update: (key, change) =>
    set((state) => ({
      drafts: { ...state.drafts, [key]: { ...state.drafts[key], ...change } },
    })),
}));
