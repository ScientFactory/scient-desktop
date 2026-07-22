import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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

function withMedicalStudyEnabled(enabled: boolean) {
  return {
    ...DEFAULT_SERVER_SETTINGS,
    skills: {
      ...DEFAULT_SERVER_SETTINGS.skills,
      scientBuiltInActivationOverrides: [{ id: "scient.medical-exam-study", enabled }],
    },
  };
}

describe("Scient built-in skill delivery", () => {
  it("lists user- and project-scoped built-ins with honest readiness", () => {
    const entries = listScientBuiltInSkillCatalogEntries(DEFAULT_SERVER_SETTINGS);
    expect(entries).toHaveLength(3);
    expect(entries).toEqual(
      expect.arrayContaining([
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
          id: "scient.medical-exam-study",
          version: "0.1.0",
          kind: "scientific",
          activationScope: "user",
          readiness: "available",
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
      ]),
    );

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

  it("delivers bundled text assets only while their skill is enabled", async () => {
    const baseDir = await makeBaseDir();
    const skillRoot = path.join(
      scientBuiltInSkillsActiveRoot(baseDir),
      "scient-medical-exam-study",
    );
    const templatePath = path.join(skillRoot, "assets", "minimal-rtl-lesson.html");

    await synchronizeScientBuiltInSkills({
      baseDir,
      settings: withMedicalStudyEnabled(true),
    });
    expect(await readFile(path.join(skillRoot, "SKILL.md"), "utf8")).toContain(
      "# Medical Exam Study",
    );
    expect(await readFile(templatePath, "utf8")).toContain('lang="he" dir="rtl"');
    expect(JSON.parse(await readFile(path.join(skillRoot, "scient.release.json"), "utf8"))).toEqual(
      expect.objectContaining({
        id: "scient.medical-exam-study",
        assets: ["assets/minimal-rtl-lesson.html"],
      }),
    );

    const staleAssetPath = path.join(skillRoot, "assets", "stale.txt");
    await writeFile(staleAssetPath, "stale", "utf8");
    await synchronizeScientBuiltInSkills({
      baseDir,
      settings: withMedicalStudyEnabled(true),
    });
    await expect(readFile(staleAssetPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(path.join(skillRoot, "SKILL.md"), "utf8")).toContain(
      "# Medical Exam Study",
    );

    await synchronizeScientBuiltInSkills({
      baseDir,
      settings: withMedicalStudyEnabled(false),
    });
    await expect(readFile(templatePath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
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
    expect(enabled).not.toContain("scient.medical-exam-study");

    const projectOverride = buildScientBuiltInSkillTriggerInstructions({
      baseDir: "/tmp/scient",
      settings: withEvidenceToNoteEnabled(true),
    });
    expect(projectOverride).toContain('id="scient.skill-authoring"');
    expect(projectOverride).not.toContain("scient.evidence-to-note");
    expect(projectOverride).not.toContain("scient.medical-exam-study");

    const medicalStudyEnabled = buildScientBuiltInSkillTriggerInstructions({
      baseDir: "/tmp/scient",
      settings: withMedicalStudyEnabled(true),
    });
    expect(medicalStudyEnabled).toContain('id="scient.medical-exam-study"');
    expect(medicalStudyEnabled).toContain("Guide medical students preparing for exams");
    expect(medicalStudyEnabled).not.toContain("# Medical Exam Study");
    expect(medicalStudyEnabled).not.toContain("scient.evidence-to-note");

    const disabled = buildScientBuiltInSkillTriggerInstructions({
      baseDir: "/tmp/scient",
      settings: withSkillAuthoringEnabled(false),
    });
    expect(disabled).toContain('enabled="none"');
    expect(disabled).not.toContain("scient.skill-authoring");
  });
});
