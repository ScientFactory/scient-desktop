import { ProviderDriverKind, ProviderInstanceId, type ServerProvider } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";

import { collectExternalSkillProviders, summarizeExternalSkills } from "./externalSkills";

function provider(
  input: Partial<ServerProvider> & Pick<ServerProvider, "instanceId">,
): ServerProvider {
  const { instanceId, ...overrides } = input;
  return {
    instanceId,
    driver: input.driver ?? ProviderDriverKind.make("codex"),
    enabled: true,
    installed: true,
    version: "1.0.0",
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-08-25T00:00:00.000Z",
    models: [],
    slashCommands: [],
    skills: [],
    ...overrides,
  };
}

describe("external skill presentation", () => {
  it("keeps provider instances separate and hides project and Scient skills", () => {
    const groups = collectExternalSkillProviders([
      provider({
        instanceId: ProviderInstanceId.make("codex-personal"),
        displayName: "Personal Codex",
        skills: [
          {
            name: "review",
            path: "/Users/test/.codex/skills/review/SKILL.md",
            scope: "user",
            enabled: true,
          },
          {
            name: "test-t3-app",
            path: "/repo/.agents/skills/test-t3-app/SKILL.md",
            scope: "project",
            enabled: true,
          },
          {
            name: "scient-review",
            path: "scient://skills/scient.review",
            scope: "personal",
            enabled: true,
          },
        ],
      }),
      provider({
        instanceId: ProviderInstanceId.make("codex-work"),
        displayName: "Work Codex",
        skills: [
          {
            name: "docs",
            path: "/Users/test/.codex/skills/docs/SKILL.md",
            scope: "user",
            enabled: false,
          },
        ],
      }),
    ]);

    expect(groups).toHaveLength(2);
    expect(groups.map((group) => group.provider.instanceId)).toEqual([
      "codex-personal",
      "codex-work",
    ]);
    expect(groups.flatMap((group) => group.skills.map((skill) => skill.skill.name))).toEqual([
      "review",
      "docs",
    ]);
    expect(summarizeExternalSkills(groups)).toBe("2 skills across 2 providers");
  });

  it("keeps an eligible provider visible when it reports no global skills", () => {
    const groups = collectExternalSkillProviders([
      provider({
        instanceId: ProviderInstanceId.make("claude-main"),
        driver: ProviderDriverKind.make("claude"),
        skills: [
          {
            name: "workspace-review",
            path: "/workspace/.claude/skills/workspace-review/SKILL.md",
            scope: "project",
            enabled: true,
          },
        ],
      }),
    ]);

    expect(groups).toHaveLength(1);
    expect(groups[0]?.skills).toEqual([]);
    expect(summarizeExternalSkills(groups)).toBe("0 skills across 1 provider");
  });
});
