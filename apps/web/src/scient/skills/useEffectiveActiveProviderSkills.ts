import { resolveProviderSkillsForCwd } from "@t3tools/client-runtime/providerSkills";
import type {
  EnvironmentId,
  ProjectId,
  ProviderDriverKind,
  ServerProvider,
  ThreadId,
} from "@t3tools/contracts";
import { useMemo } from "react";

import { useEnvironmentQuery } from "~/state/query";

import { mergeEffectiveProviderSkills } from "./effectiveSkills";
import { resolveScientSkillListInput } from "./scientSkillListInput";
import { scientSkillsInventory } from "./scientSkillsState";

const EMPTY_PROVIDER_SKILLS: ServerProvider["skills"] = [];

/**
 * The skills a chat's messages present: the active provider's native skills
 * for the working directory, plus the Scient skills active in this context.
 */
export function useEffectiveActiveProviderSkills(input: {
  readonly environmentId: EnvironmentId;
  readonly routeKind: "server" | "draft";
  readonly activeThreadId: ThreadId | null;
  readonly activeProjectId: ProjectId | null;
  readonly selectedProvider: ProviderDriverKind;
  readonly activeProviderStatus: ServerProvider | null;
  readonly gitCwd: string | null | undefined;
}): ReadonlyArray<ServerProvider["skills"][number]> {
  const {
    environmentId,
    routeKind,
    activeThreadId,
    activeProjectId,
    selectedProvider,
    activeProviderStatus,
    gitCwd,
  } = input;
  const scientSkills = useEnvironmentQuery(
    scientSkillsInventory({
      environmentId,
      input: resolveScientSkillListInput({
        routeKind,
        threadId: activeThreadId,
        projectId: activeProjectId,
      }),
    }),
  ).data;
  return useMemo(
    () =>
      mergeEffectiveProviderSkills({
        provider: selectedProvider,
        providerSkills: activeProviderStatus
          ? resolveProviderSkillsForCwd(activeProviderStatus, gitCwd)
          : EMPTY_PROVIDER_SKILLS,
        inventory: scientSkills,
        includeContextualProviderSkills: true,
      }),
    [activeProviderStatus, gitCwd, scientSkills, selectedProvider],
  );
}
