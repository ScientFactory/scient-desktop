import { describe, expect, it } from "vite-plus/test";

import {
  formatProviderSkillDisplayName,
  getProviderSlashCommandsForSlashMenu,
  getProviderSkillsForSlashMenu,
  resolveProviderSkillSourceKind,
} from "./providerSkills.ts";

describe("formatProviderSkillDisplayName", () => {
  it("prefers the provider display name", () => {
    expect(
      formatProviderSkillDisplayName({
        name: "review-follow-up",
        displayName: "Review Follow-up",
      }),
    ).toBe("Review Follow-up");
  });

  it("falls back to a title-cased skill name", () => {
    expect(
      formatProviderSkillDisplayName({
        name: "review-follow-up",
      }),
    ).toBe("Review Follow Up");
  });
});

describe("getProviderSkillsForSlashMenu", () => {
  it("keeps the skill alias when the provider also exposes it as a slash command", () => {
    const askMatt = {
      name: "ask-matt",
      path: "/Users/matt/.agents/skills/ask-matt/SKILL.md",
      enabled: true,
    };
    expect(getProviderSkillsForSlashMenu([askMatt], true).map((skill) => skill.name)).toEqual([
      "ask-matt",
    ]);
  });

  it("omits project skills from the global composer menu", () => {
    expect(
      getProviderSkillsForSlashMenu(
        [
          {
            name: "project-review",
            path: "/workspace/.agents/skills/project-review/SKILL.md",
            scope: "project",
            enabled: true,
          },
        ],
        true,
      ),
    ).toEqual([]);
  });

  it("keeps contextual Scient project skills available for explicit selection", () => {
    expect(
      getProviderSkillsForSlashMenu(
        [
          {
            name: "project-review",
            path: "scient://skills/project.release%23exact",
            scope: "project",
            enabled: true,
          },
        ],
        true,
      ).map((skill) => skill.name),
    ).toEqual(["project-review"]);
  });

  it("omits provider-deactivated skills", () => {
    expect(
      getProviderSkillsForSlashMenu(
        [
          {
            name: "review",
            path: "/Users/test/.codex/skills/review/SKILL.md",
            scope: "user",
            enabled: false,
          },
        ],
        true,
      ),
    ).toEqual([]);
  });
});

describe("getProviderSlashCommandsForSlashMenu", () => {
  const commands = [
    { name: "ask-matt", description: "Ask which skill fits your situation." },
    { name: "compact", description: "Compact the conversation." },
  ];
  const skills = [
    {
      name: "ask-matt",
      path: "/Users/matt/.agents/skills/ask-matt/SKILL.md",
      enabled: true,
    },
  ];

  it("lets the skill alias win when a provider command has the same name", () => {
    expect(
      getProviderSlashCommandsForSlashMenu(commands, skills).map((command) => command.name),
    ).toEqual(["compact"]);
  });

  it("keeps the provider command when the matching skill alias is hidden", () => {
    const visibleSkills = getProviderSkillsForSlashMenu(skills, false);

    expect(
      getProviderSlashCommandsForSlashMenu(commands, visibleSkills).map((command) => command.name),
    ).toEqual(["ask-matt", "compact"]);
  });
});

describe("resolveProviderSkillSourceKind", () => {
  it("recognizes built-in Scient skill releases as app-owned", () => {
    expect(
      resolveProviderSkillSourceKind({
        path: "scient://skills/scient.review%400.1.0%23sha256%3Aabc",
        scope: "personal",
      }),
    ).toBe("app");
  });
  it("marks plugin-backed skills as app installs", () => {
    expect(
      resolveProviderSkillSourceKind({
        path: "/Users/julius/.codex/plugins/cache/openai-curated/github/skills/gh-fix-ci/SKILL.md",
        scope: "user",
      }),
    ).toBe("app");
  });

  it("keeps explicit project scope authoritative over path heuristics", () => {
    expect(
      resolveProviderSkillSourceKind({
        path: "/workspace/.agents/plugins/review/skills/review/SKILL.md",
        scope: "project",
      }),
    ).toBe("project");
  });

  it("maps standard scopes to source kinds", () => {
    expect(
      resolveProviderSkillSourceKind({
        path: "/provider/builtin/skills/guide/SKILL.md",
        scope: "app",
      }),
    ).toBe("app");
    expect(
      resolveProviderSkillSourceKind({
        path: "/workspace/.codex/skills/review-follow-up/SKILL.md",
        scope: "repo",
      }),
    ).toBe("repo");
    expect(
      resolveProviderSkillSourceKind({
        path: "/workspace/.codex/skills/review-follow-up/SKILL.md",
        scope: "project",
      }),
    ).toBe("project");
    expect(
      resolveProviderSkillSourceKind({
        path: "/Users/julius/.agents/skills/agent-browser/SKILL.md",
        scope: "user",
      }),
    ).toBe("personal");
    expect(
      resolveProviderSkillSourceKind({
        path: "/usr/local/share/codex/skills/imagegen/SKILL.md",
        scope: "system",
      }),
    ).toBe("system");
  });

  it("keeps unknown and missing scopes usable", () => {
    expect(
      resolveProviderSkillSourceKind({
        path: "/opt/skills/team-review/SKILL.md",
        scope: "team_shared",
      }),
    ).toBe("other");
    expect(
      resolveProviderSkillSourceKind({
        path: "/opt/skills/team-review/SKILL.md",
      }),
    ).toBe("other");
  });
});
