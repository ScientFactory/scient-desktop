import type { EnvironmentId, ScientProjectCitationStyle } from "@t3tools/contracts";
import { useEffect } from "react";
import { create } from "zustand";

import { readCitationStyles } from "./client";

export interface CitationStyleProject {
  readonly environmentId: EnvironmentId;
  readonly root: string;
}

type Loaded = ScientProjectCitationStyle | { readonly _tag: "failed" };

/** One project's style per environment and root, shared by the reference and the picker. */
const useCitationStyleStore = create<{ readonly byProject: Readonly<Record<string, Loaded>> }>(
  () => ({ byProject: {} }),
);
const loading = new Set<string>();
/** Bumped by every change, so a read that started before one does not undo it. */
const generations = new Map<string, number>();

const projectKey = (project: CitationStyleProject) => `${project.environmentId}\0${project.root}`;

export function publishProjectCitationStyle(
  project: CitationStyleProject,
  style: ScientProjectCitationStyle,
): void {
  const key = projectKey(project);
  generations.set(key, (generations.get(key) ?? 0) + 1);
  useCitationStyleStore.setState((state) => ({ byProject: { ...state.byProject, [key]: style } }));
}

/** The project's style, or null while it loads; `failed` when the server could not be asked. */
export function useProjectCitationStyle(project: CitationStyleProject | null): Loaded | null {
  const key = project ? projectKey(project) : null;
  const loaded = useCitationStyleStore((state) => (key === null ? null : state.byProject[key]));
  const environmentId = project?.environmentId ?? null;
  const root = project?.root ?? null;

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- the style is a project file on the server, which an agent can change; read it again when a reference opens
  useEffect(() => {
    if (key === null || environmentId === null || root === null || loading.has(key)) return;
    loading.add(key);
    const generation = generations.get(key) ?? 0;
    void readCitationStyles(environmentId, { root })
      .then(
        (result) => {
          if ((generations.get(key) ?? 0) !== generation) return;
          publishProjectCitationStyle({ environmentId, root }, result.current);
        },
        () => {
          if (useCitationStyleStore.getState().byProject[key]) return;
          useCitationStyleStore.setState((state) => ({
            byProject: { ...state.byProject, [key]: { _tag: "failed" } },
          }));
        },
      )
      .finally(() => loading.delete(key));
  }, [environmentId, key, root]);

  return loaded ?? null;
}
