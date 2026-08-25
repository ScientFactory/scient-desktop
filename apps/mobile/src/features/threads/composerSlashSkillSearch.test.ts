import { describe, expect, it } from "vite-plus/test";

import { matchesSlashSkillQuery } from "./composerSlashSkillSearch";

const browserSkill = {
  name: "browser",
  path: "/skills/browser/SKILL.md",
  enabled: true,
  shortDescription: "Open and control the in-app browser",
};

describe("matchesSlashSkillQuery", () => {
  it("matches the rendered skill prefix", () => {
    expect(matchesSlashSkillQuery(browserSkill, "skill")).toBe(true);
    expect(matchesSlashSkillQuery(browserSkill, "skill:brow")).toBe(true);
  });

  it("does not expose project skills in the global skill picker", () => {
    expect(
      matchesSlashSkillQuery(
        {
          ...browserSkill,
          path: "/workspace/.agents/skills/browser/SKILL.md",
          scope: "project",
        },
        "skill",
      ),
    ).toBe(false);
  });
});
