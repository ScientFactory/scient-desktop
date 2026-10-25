const browserSkill = {
  name: "browser",
  path: "/skills/browser/SKILL.md",
  enabled: true,
  shortDescription: "Open and control the in-app browser",
};

import { describe, expect, it } from "vite-plus/test";

import { matchesSlashSkillQuery } from "./composerSlashSkillSearch";

describe("matchesSlashSkillQuery", () => {
  it("does not expose project skills in the global skill picker", () => {
    expect(
      matchesSlashSkillQuery(
        {
          name: "browser",
          path: "/workspace/.agents/skills/browser/SKILL.md",
          enabled: true,
          scope: "project",
        },
        "skill",
      ),
    ).toBe(false);
  });

  // regression: e723501227 feat(composer): list skills with slash commands (#7737)
  it("matches the rendered skill prefix", () => {
    expect(matchesSlashSkillQuery(browserSkill, "skill")).toBe(true);
    expect(matchesSlashSkillQuery(browserSkill, "skill:brow")).toBe(true);
  });
});
