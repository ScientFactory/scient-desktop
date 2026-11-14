import * as NodeUtil from "node:util";

import { type ProjectId, type ProjectSettingsOverrides } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as Settings from "../serverSettings.ts";

export function deletedProjectOverridePatch(entry: ProjectSettingsOverrides | undefined) {
  // Keep cleanup policy for deleted threads; omitting providerInstances would preserve obsolete references in the merge.
  return entry?.worktreeCleanup !== undefined
    ? { worktreeCleanup: entry.worktreeCleanup, providerInstances: {} }
    : null;
}

export const sweep = Effect.gen(function* () {
  const serverSettings = yield* Settings.ServerSettingsService;
  const projectStore = yield* ProjectStore.ProjectStoreV2;

  const settings = yield* serverSettings.getSettings;
  const projects = yield* projectStore.list({ includeDeleted: true });
  const projectsById = new Map<string, ProjectStore.ProjectRow>(
    projects.map((project) => [project.projectId, project]),
  );

  const overrides = Object.entries(settings.projectSettingsOverrides).flatMap(
    ([projectId, entry]) => {
      const project = projectsById.get(projectId);
      if (project?.deletedAt === null) return [];
      const patch = project ? deletedProjectOverridePatch(entry) : null;
      if (NodeUtil.isDeepStrictEqual(entry, patch)) return [];
      return [[projectId, patch] as const];
    },
  );
  if (overrides.length === 0) return;

  // SCIENT-FORK:START — a merged patch keeps title instructions for released clients, so every
  // entry is removed server-side first and only a kept cleanup policy is written back.
  yield* serverSettings.removeProjectSettingsOverrides(
    overrides.map(([projectId]) => projectId as ProjectId),
  );
  const kept = overrides.filter(([, patch]) => patch !== null);
  if (kept.length === 0) return;
  // SCIENT-FORK:END
  yield* serverSettings.updateSettings({
    projectSettingsOverrides: Object.fromEntries(kept),
  });
}).pipe(
  Effect.asVoid,
  Effect.catchCause((cause) =>
    Effect.logWarning("Failed to sweep orphaned project settings overrides.", cause),
  ),
);
