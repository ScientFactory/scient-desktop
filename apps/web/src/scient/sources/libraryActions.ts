import type { EnvironmentId, ScientSourcesLibraryOrganizeAction } from "@t3tools/contracts";

import { organizeScientSources } from "./client";
import { scientSourcesErrorMessage } from "./errorMessage";

export type ProjectSourcesChange = Extract<
  ScientSourcesLibraryOrganizeAction,
  { action: "pin" | "unpin" }
>;

/**
 * Adds sources to this project or removes them from it, one change each; the Library keeps them.
 * A source already in (or already out of) the project counts as neither changed nor failed.
 */
export async function changeProjectSources(input: {
  readonly environmentId: EnvironmentId;
  readonly root: string;
  readonly changes: ReadonlyArray<ProjectSourcesChange>;
}) {
  let changed = 0;
  let failed = 0;
  let error = null as string | null;
  const succeeded: ProjectSourcesChange[] = [];
  for (const change of input.changes) {
    const result = await organizeScientSources(input.environmentId, {
      root: input.root,
      change,
    }).catch((cause: unknown) => {
      error ??= scientSourcesErrorMessage(cause, import.meta.env.DEV);
      return null;
    });
    if (result?.outcome === "pinned" || result?.outcome === "unpinned") {
      changed += 1;
      succeeded.push(change);
    } else if (result?.outcome !== "existing" && result?.outcome !== "not-pinned") failed += 1;
  }
  return { changed, failed, error, succeeded };
}

export type ProjectSourcesOutcome = Awaited<ReturnType<typeof changeProjectSources>>;
