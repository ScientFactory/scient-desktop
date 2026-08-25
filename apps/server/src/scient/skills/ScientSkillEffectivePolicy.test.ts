import { toSkillReleaseRef } from "@scientfactory/scient-skills";
import { describe, expect, it } from "@effect/vitest";

import { BUILT_IN_SKILL_RELEASES } from "./BuiltInSkillReleases.ts";
import { resolveEffectiveUserSkillPolicies } from "./ScientSkillEffectivePolicy.ts";
import type { ScientSkillPolicySnapshot } from "./ScientSkillPolicy.ts";
import type { ScientSkillRegistryShape } from "./ScientSkillRegistry.ts";

const release = BUILT_IN_SKILL_RELEASES[0]!;

function resolve(
  defaultActive: boolean,
  preference?: ScientSkillPolicySnapshot["userSkills"][number],
) {
  const registry: ScientSkillRegistryShape = {
    catalog: { releases: [release], diagnostics: [] },
    resolveReleaseKey: () => release,
    defaultActive: () => defaultActive,
  };
  return resolveEffectiveUserSkillPolicies(registry, {
    userSkills: preference ? [preference] : [],
    trustedProjects: [],
  })[0]!;
}

describe("effective Scient skill policy", () => {
  it("uses shipping defaults only when the user has no preference", () => {
    expect(resolve(true)).toMatchObject({ defaultActive: true, active: true });
    expect(resolve(false)).toMatchObject({ defaultActive: false, active: false });
  });

  it("keeps an explicit user choice authoritative over either shipping default", () => {
    const reference = toSkillReleaseRef(release);
    expect(
      resolve(true, { release: reference, active: false, invocationPolicy: "explicit" }),
    ).toMatchObject({ defaultActive: true, active: false, invocationPolicy: "explicit" });
    expect(
      resolve(false, { release: reference, active: true, invocationPolicy: "automatic" }),
    ).toMatchObject({ defaultActive: false, active: true, invocationPolicy: "automatic" });
  });

  it("matches preferences by stable ID and origin while delivering the current exact release", () => {
    const previousRelease = {
      ...toSkillReleaseRef(release),
      version: "0.0.9",
      digest: `sha256:${"a".repeat(64)}`,
    };
    const effective = resolve(true, {
      release: previousRelease,
      active: false,
      invocationPolicy: "explicit",
    });
    expect(effective.active).toBe(false);
    expect(effective.release).toBe(release);
  });
});
