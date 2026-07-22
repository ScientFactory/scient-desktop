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

function withEvidenceToNoteEnabled(enabled: boolean) {
  return {
    ...DEFAULT_SERVER_SETTINGS,
    skills: {
      ...DEFAULT_SERVER_SETTINGS.skills,
      scientBuiltInActivationOverrides: [{ id: "scient.evidence-to-note", enabled }],
    },
  };
}

describe("Scient built-in skill delivery", () => {
  it("lists user- and project-scoped built-ins with honest readiness", () => {
    expect(listScientBuiltInSkillCatalogEntries(DEFAULT_SERVER_SETTINGS)).toEqual([
      expect.objectContaining({
        id: "scient.evidence-to-note",
        version: "0.1.0",
        kind: "scientific",
        activationScope: "project",
        readiness: "latent",
        enabled: false,
        defaultEnabled: false,
      }),
      expect.objectContaining({
        id: "scient.skill-authoring",
        version: "0.1.0",
        kind: "meta",
        activationScope: "user",
        readiness: "available",
        enabled: true,
        defaultEnabled: true,
      }),
    ]);

    expect(listScientBuiltInSkillCatalogEntries(withEvidenceToNoteEnabled(true))[0]).toMatchObject({
      id: "scient.evidence-to-note",
      enabled: false,
    });
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
    await expect(
      readFile(
        path.join(scientBuiltInSkillsActiveRoot(baseDir), "scient-evidence-to-note", "SKILL.md"),
        "utf8",
      ),
    ).rejects.toMatchObject({ code: "ENOENT" });

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
    expect(
      haveSameScientBuiltInSkillActivation(
        DEFAULT_SERVER_SETTINGS,
        withEvidenceToNoteEnabled(true),
      ),
    ).toBe(true);
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
    expect(enabled).not.toContain("scient.evidence-to-note");

    const projectOverride = buildScientBuiltInSkillTriggerInstructions({
      baseDir: "/tmp/scient",
      settings: withEvidenceToNoteEnabled(true),
    });
    expect(projectOverride).toContain('id="scient.skill-authoring"');
    expect(projectOverride).not.toContain("scient.evidence-to-note");

    const disabled = buildScientBuiltInSkillTriggerInstructions({
      baseDir: "/tmp/scient",
      settings: withSkillAuthoringEnabled(false),
    });
    expect(disabled).toContain('enabled="none"');
    expect(disabled).not.toContain("scient.skill-authoring");
  });
});
