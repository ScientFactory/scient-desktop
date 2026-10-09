import { formatProviderSkillDisplayName } from "@t3tools/shared/inlineSkills";
import type {
  EnvironmentId,
  ProjectId,
  ScopedThreadRef,
  ServerProviderSkill,
  ThreadId,
} from "@t3tools/contracts";
import { scientManagedSkillReleaseKey } from "@t3tools/client-runtime/providerSkills";

import { useRightPanelStore } from "~/rightPanelStore";
import { scientSkillSurface } from "~/scient/rightPanel/surfaces";
import { useEnvironmentQuery } from "../../state/query.ts";
import { resolveScientSkillListInput } from "./scientSkillListInput.ts";
import { scientSkillsInventory } from "./scientSkillsState.ts";

/** The Scient skill inventory the composer offers for this thread or draft. */
export function useScientComposerSkills(input: {
  readonly environmentId: EnvironmentId;
  readonly routeKind: "server" | "draft";
  readonly threadId: ThreadId | null;
  readonly projectId: ProjectId | null;
}) {
  const { environmentId, routeKind, threadId, projectId } = input;
  return useEnvironmentQuery(
    scientSkillsInventory({
      environmentId,
      input: resolveScientSkillListInput({
        routeKind,
        threadId,
        projectId,
      }),
    }),
  ).data;
}

/**
 * Open a skill chip from the composer: provider skills open their file, and a
 * Scient-managed skill opens its installed file or, failing that, its
 * document surface in the right panel.
 */
export function openComposerSkill(
  skill: ServerProviderSkill,
  context: {
    readonly routeThreadRef: ScopedThreadRef;
    readonly scientSkills: ReturnType<typeof useScientComposerSkills>;
  },
): void {
  const { routeThreadRef, scientSkills } = context;
  const releaseKey = scientManagedSkillReleaseKey(skill);
  if (releaseKey === null) {
    useRightPanelStore.getState().openFile(routeThreadRef, skill.path);
    return;
  }
  const managedSkill = scientSkills?.skills.find(
    (candidate) => candidate.releaseKey === releaseKey,
  );
  if (managedSkill?.path) {
    useRightPanelStore.getState().openFile(routeThreadRef, managedSkill.path);
    return;
  }
  useRightPanelStore.getState().openScient(
    routeThreadRef,
    scientSkillSurface({
      releaseKey,
      title: formatProviderSkillDisplayName(skill),
    }),
  );
}
