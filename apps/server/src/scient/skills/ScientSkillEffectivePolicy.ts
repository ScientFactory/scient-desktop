import {
  skillReleaseKey,
  type SkillInvocationPolicy,
  type SkillRelease,
  type SkillReleaseRef,
} from "@scientfactory/scient-skills";

import type { ScientSkillPolicySnapshot } from "./ScientSkillPolicy.ts";
import type { ScientSkillCatalogView } from "./ScientSkillRegistry.ts";

export interface EffectiveUserSkillPolicy {
  readonly release: SkillRelease;
  readonly active: boolean;
  readonly invocationPolicy: SkillInvocationPolicy;
  readonly defaultActive: boolean;
}

/**
 * A trusted Scient app update keeps the user's choice for a stable skill id.
 * Any other origin (add-ons) binds the choice to the exact reviewed release:
 * changed bytes or versions need a fresh activation, even under one origin.
 */
const preferenceKey = (release: SkillReleaseRef): string =>
  release.origin === "scient"
    ? `scient:${release.id}`
    : `${release.origin}:${skillReleaseKey(release)}`;

/**
 * Resolves the single effective personal policy used by management and delivery.
 * Runtime authority remains pinned to the exact release currently present in
 * the reviewed catalog.
 */
export function resolveEffectiveUserSkillPolicies(
  registry: ScientSkillCatalogView,
  snapshot: ScientSkillPolicySnapshot,
): ReadonlyArray<EffectiveUserSkillPolicy> {
  const preferenceByKey = new Map(
    snapshot.userSkills.map(
      (preference) => [preferenceKey(preference.release), preference] as const,
    ),
  );
  return registry.catalog.releases
    .filter((release) => release.supportedScopes.includes("user"))
    .map((release) => {
      const preference = preferenceByKey.get(preferenceKey(release));
      const defaultActive = registry.defaultActive(release);
      return {
        release,
        active: preference?.active ?? defaultActive,
        invocationPolicy: preference?.invocationPolicy ?? release.defaultInvocationPolicy,
        defaultActive,
      };
    });
}
