import { getBuiltInSkillRelease } from "./catalog.ts";
import {
  SCIENT_BUILT_IN_ORIGIN,
  SCIENT_SKILLS_LOCK_FORMAT_VERSION,
  type BuiltInSkillActivation,
  type BuiltInSkillRelease,
  type BuiltInSkillsLock,
} from "./types.ts";

export type BuiltInSkillResolution =
  | {
      readonly status: "resolved";
      readonly activation: BuiltInSkillActivation;
      readonly release: BuiltInSkillRelease;
    }
  | {
      readonly status: "unavailable" | "origin-mismatch" | "digest-mismatch";
      readonly activation: BuiltInSkillActivation;
    };

export function createBuiltInSkillsLock(
  activations: readonly BuiltInSkillActivation[],
): BuiltInSkillsLock {
  return {
    formatVersion: SCIENT_SKILLS_LOCK_FORMAT_VERSION,
    skills: activations
      .toSorted((left, right) =>
        left.id === right.id
          ? left.version.localeCompare(right.version)
          : left.id.localeCompare(right.id),
      )
      .map((activation) => ({ ...activation })),
  };
}

export function resolveBuiltInSkillsLock(
  lock: BuiltInSkillsLock,
): readonly BuiltInSkillResolution[] {
  return lock.skills.map((activation) => {
    if (activation.origin !== SCIENT_BUILT_IN_ORIGIN) {
      return { status: "origin-mismatch", activation };
    }
    const release = getBuiltInSkillRelease(activation.id, activation.version);
    if (!release) return { status: "unavailable", activation };
    if (release.digest !== activation.digest) {
      return { status: "digest-mismatch", activation };
    }
    return { status: "resolved", activation, release };
  });
}
