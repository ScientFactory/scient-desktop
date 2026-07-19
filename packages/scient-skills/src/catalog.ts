import { GENERATED_BUILT_IN_SKILL_RELEASES } from "./generated.ts";
import type { BuiltInSkillRelease } from "./types.ts";
import { compareBuiltInSkillVersions } from "./validate.ts";

const releases: readonly BuiltInSkillRelease[] = GENERATED_BUILT_IN_SKILL_RELEASES;

export function listBuiltInSkillReleases(): readonly BuiltInSkillRelease[] {
  return releases;
}

export function selectCurrentBuiltInSkillReleases(
  availableReleases: readonly BuiltInSkillRelease[],
): readonly BuiltInSkillRelease[] {
  const currentById = new Map<string, BuiltInSkillRelease>();
  for (const release of availableReleases) {
    const current = currentById.get(release.id);
    if (!current || compareBuiltInSkillVersions(release.version, current.version) > 0) {
      currentById.set(release.id, release);
    }
  }
  return [...currentById.values()].toSorted((left, right) => left.id.localeCompare(right.id));
}

export function listCurrentBuiltInSkillReleases(): readonly BuiltInSkillRelease[] {
  return selectCurrentBuiltInSkillReleases(releases);
}

export function listUserFacingBuiltInSkillReleases(): readonly BuiltInSkillRelease[] {
  return listCurrentBuiltInSkillReleases().filter((release) => release.visibility === "user");
}

export function listUserActivatedBuiltInSkillReleases(): readonly BuiltInSkillRelease[] {
  return listUserFacingBuiltInSkillReleases().filter(
    (release) => release.activation.scope === "user",
  );
}

export function listProjectActivatableBuiltInSkillReleases(): readonly BuiltInSkillRelease[] {
  return listUserFacingBuiltInSkillReleases().filter(
    (release) => release.activation.scope === "project",
  );
}

export function getBuiltInSkillRelease(
  id: string,
  version: string,
): BuiltInSkillRelease | undefined {
  return releases.find((release) => release.id === id && release.version === version);
}
