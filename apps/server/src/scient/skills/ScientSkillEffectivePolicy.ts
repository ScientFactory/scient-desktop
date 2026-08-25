import type { SkillInvocationPolicy, SkillRelease } from "@scientfactory/scient-skills";

import type { ScientSkillPolicySnapshot } from "./ScientSkillPolicy.ts";
import type { ScientSkillRegistryShape } from "./ScientSkillRegistry.ts";

export interface EffectiveUserSkillPolicy {
  readonly release: SkillRelease;
  readonly active: boolean;
  readonly invocationPolicy: SkillInvocationPolicy;
  readonly defaultActive: boolean;
}

const preferenceKey = (release: { readonly id: string; readonly origin: string }): string =>
  `${release.origin}:${release.id}`;

/**
 * Resolves the single effective personal policy used by management and delivery.
 * User choices follow a stable skill within one origin; runtime authority remains
 * pinned to the exact release currently present in the reviewed catalog.
 */
export function resolveEffectiveUserSkillPolicies(
  registry: ScientSkillRegistryShape,
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
