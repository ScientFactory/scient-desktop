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
});
