import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { DEFAULT_SERVER_SETTINGS } from "@synara/contracts";
import { afterEach, describe, expect, it } from "vitest";

import {
  buildScientBuiltInSkillTriggerInstructions,
  haveSameScientBuiltInSkillActivation,
  listScientBuiltInSkillCatalogEntries,
  scientBuiltInSkillsActiveRoot,
  synchronizeScientBuiltInSkills,
} from "./scientBuiltInSkills.ts";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function makeBaseDir(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "scient-built-in-skills-"));
  roots.push(root);
  return root;
}

function withSkillAuthoringEnabled(enabled: boolean) {
  return {
    ...DEFAULT_SERVER_SETTINGS,
    skills: {
      ...DEFAULT_SERVER_SETTINGS.skills,
      scientBuiltInActivationOverrides: [{ id: "scient.skill-authoring", enabled }],
    },
  };
}

describe("Scient built-in skill delivery", () => {
  it("lists Skill Authoring as visible and enabled by default", () => {
    expect(listScientBuiltInSkillCatalogEntries(DEFAULT_SERVER_SETTINGS)).toEqual([
      expect.objectContaining({
        id: "scient.skill-authoring",
        version: "0.1.0",
        kind: "meta",
        activationScope: "user",
        enabled: true,
        defaultEnabled: true,
      }),
    ]);
  });

  it("materializes only enabled releases and removes a deactivated release", async () => {
    const baseDir = await makeBaseDir();
    await synchronizeScientBuiltInSkills({ baseDir, settings: DEFAULT_SERVER_SETTINGS });
    const skillPath = path.join(
      scientBuiltInSkillsActiveRoot(baseDir),
      "scient-skill-authoring",
      "SKILL.md",
    );
    expect(await readFile(skillPath, "utf8")).toContain("# Scient Skill Authoring");

    await synchronizeScientBuiltInSkills({
      baseDir,
      settings: withSkillAuthoringEnabled(false),
    });

    await expect(readFile(skillPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("serializes rapid activation changes and leaves the last requested state delivered", async () => {
    const baseDir = await makeBaseDir();
    const skillPath = path.join(
      scientBuiltInSkillsActiveRoot(baseDir),
      "scient-skill-authoring",
      "SKILL.md",
    );

    await Promise.all([
      synchronizeScientBuiltInSkills({ baseDir, settings: DEFAULT_SERVER_SETTINGS }),
      synchronizeScientBuiltInSkills({
        baseDir,
        settings: withSkillAuthoringEnabled(false),
      }),
      synchronizeScientBuiltInSkills({ baseDir, settings: DEFAULT_SERVER_SETTINGS }),
    ]);

    expect(await readFile(skillPath, "utf8")).toContain("# Scient Skill Authoring");
  });

  it("compares effective activation rather than redundant override representation", () => {
    expect(
      haveSameScientBuiltInSkillActivation(
        DEFAULT_SERVER_SETTINGS,
        withSkillAuthoringEnabled(true),
      ),
    ).toBe(true);
    expect(
      haveSameScientBuiltInSkillActivation(
        DEFAULT_SERVER_SETTINGS,
        withSkillAuthoringEnabled(false),
      ),
    ).toBe(false);
  });

  it("gives agents exact trigger metadata only while the skill is enabled", () => {
    const enabled = buildScientBuiltInSkillTriggerInstructions({
      baseDir: "/tmp/scient",
      settings: DEFAULT_SERVER_SETTINGS,
    });
    expect(enabled).toContain('id="scient.skill-authoring"');
    expect(enabled).toContain('version="0.1.0"');
    expect(enabled).toContain("Create, revise, adapt, and review reusable Scient skill candidates");
    expect(enabled).not.toContain("# Scient Skill Authoring");

    const disabled = buildScientBuiltInSkillTriggerInstructions({
      baseDir: "/tmp/scient",
      settings: withSkillAuthoringEnabled(false),
    });
    expect(disabled).toContain('enabled="none"');
    expect(disabled).not.toContain("scient.skill-authoring");
  });
});
