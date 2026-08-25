import { ProviderDriverKind, type ScientSkillInventory } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";

import { mergeEffectiveProviderSkills } from "./effectiveSkills";

const inventory: ScientSkillInventory = {
  supportedProviders: [ProviderDriverKind.make("codex")],
  skills: [
    {
      releaseKey: `scient.review@0.1.0#sha256:${"a".repeat(64)}`,
      id: "scient.review",
      version: "0.1.0",
      name: "review",
      description: "Review the workspace.",
      category: "Workspace readiness",
      categoryDescription: "Review and improve workspace readiness.",
      origin: "scient",
      supportedScopes: ["user", "project"],
      defaultInvocationPolicy: "automatic",
      defaultActive: true,
      active: true,
      invocationPolicy: "automatic",
    },
  ],
};

describe("effective provider skill inventory", () => {
  it("appends active Scient skills without changing provider-native entries", () => {
    const native = [{ name: "native", path: "/native", scope: "user", enabled: true }];
    const result = mergeEffectiveProviderSkills({
      provider: ProviderDriverKind.make("codex"),
      providerSkills: native,
      inventory,
    });
    expect(result[0]).toBe(native[0]);
    expect(result[1]).toMatchObject({ name: "review", path: expect.stringMatching(/^scient:/u) });
  });

  it("lets provider-native skills win collisions and excludes unsupported providers", () => {
    const native = [{ name: "review", path: "/native", enabled: true }];
    expect(
      mergeEffectiveProviderSkills({
        provider: ProviderDriverKind.make("codex"),
        providerSkills: native,
        inventory,
      }),
    ).toEqual(native);
    expect(
      mergeEffectiveProviderSkills({
        provider: ProviderDriverKind.make("antigravity"),
        providerSkills: [],
        inventory,
      }),
    ).toEqual([]);
  });

  it("keeps project-native skills out of global composer menus", () => {
    const projectSkill = {
      name: "test-t3-app",
      path: "/workspace/.agents/skills/test-t3-app/SKILL.md",
      scope: "project",
      enabled: true,
    };
    expect(
      mergeEffectiveProviderSkills({
        provider: ProviderDriverKind.make("codex"),
        providerSkills: [projectSkill],
        inventory,
      }).some((skill) => skill.name === projectSkill.name),
    ).toBe(false);
  });
});
