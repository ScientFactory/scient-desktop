import { ProviderDriverKind, ProviderInstanceId, type ServerProvider } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";

import {
  compactExternalSkillDescription,
  collectExternalSkillProviders,
  externalSkillSourceLabel,
  summarizeExternalSkills,
} from "./externalSkills";

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

  it("uses concise source labels", () => {
    expect((["app", "personal", "system", "other"] as const).map(externalSkillSourceLabel)).toEqual(
      ["Provider bundled", "Personal", "System", "Provider managed"],
    );
  });

  it("shows a compact provider-authored summary without changing the source skill", () => {
    const description =
      "Use this skill to configure the Claude Code harness via settings.json. " +
      "Automated behaviors require hooks configured in settings.json. Examples follow.";
    const groups = collectExternalSkillProviders([
      provider({
        instanceId: ProviderInstanceId.make("claude-main"),
        driver: ProviderDriverKind.make("claude"),
        skills: [
          {
            name: "update-config",
            path: "claude://skills/update-config",
            scope: "app",
            enabled: true,
            description,
          },
        ],
      }),
    ]);

    expect(groups[0]?.skills[0]?.description).toBe(
      "Use this skill to configure the Claude Code harness via settings.json.",
    );
    expect(groups[0]?.skills[0]?.skill.description).toBe(description);
  });

  it("caps unusually long first sentences at a word boundary", () => {
    const summary = compactExternalSkillDescription(
      `Build ${"carefully selected visualizations ".repeat(10)}for the user's data.`,
    );

    expect(summary?.endsWith("…")).toBe(true);
    expect(summary?.length).toBeLessThanOrEqual(161);
  });
});
