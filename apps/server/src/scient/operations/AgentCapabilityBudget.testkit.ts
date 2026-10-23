import { skillReleaseKey, type SkillRelease } from "@scientfactory/scient-skills";

import { BUILT_IN_SKILL_RELEASES } from "../skills/BuiltInSkillReleases.ts";
import type { AgentSkillDescriptor } from "./AgentInvocationContext.ts";

export const capabilityBudgetFixture = (count: number) => {
  const base = BUILT_IN_SKILL_RELEASES[0]!;
  const releases = new Map<string, SkillRelease>();
  const skills: AgentSkillDescriptor[] = [];
  for (let index = 0; index < count; index++) {
    const name = `fixture-${String(index).padStart(3, "0")}`;
    const release = {
      ...base,
      id: `fixture.${index}`,
      name,
      description: `Scientific workflow ${index}; inspect measurements and preserve evidence.`,
    };
    const releaseKey = skillReleaseKey(release);
    releases.set(releaseKey, release);
    skills.push({
      releaseKey,
      id: release.id,
      name,
      description: release.description,
      origin: "scient",
      invocationPolicy: "automatic",
      activationScope: "user",
    });
  }
  return { releases, skills };
};
