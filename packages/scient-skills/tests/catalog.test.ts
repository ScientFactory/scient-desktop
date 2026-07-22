import { describe, expect, it } from "vitest";

import {
  createBuiltInSkillsLock,
  getBuiltInSkillReadiness,
  listBuiltInSkillReleases,
  listCurrentBuiltInSkillReleases,
  listProjectActivatableBuiltInSkillReleases,
  listUserActivatedBuiltInSkillReleases,
  listUserFacingBuiltInSkillReleases,
  resolveBuiltInSkillsLock,
  SCIENT_BUILT_IN_ORIGIN,
} from "../src/index.ts";
import { selectCurrentBuiltInSkillReleases } from "../src/catalog.ts";
import { assertBuiltInSkillMetadata } from "../src/validate.ts";

describe("Scient built-in skills catalog", () => {
  it("ships the maintained v0.1 built-in portfolio", () => {
    const releases = listBuiltInSkillReleases();
    const skillAuthoring = releases.find((release) => release.id === "scient.skill-authoring");
    const evidenceToNote = releases.find((release) => release.id === "scient.evidence-to-note");
    const medicalStudy = releases.find((release) => release.id === "scient.medical-exam-study");

    expect(releases).toHaveLength(3);
    expect(skillAuthoring).toMatchObject({
      id: "scient.skill-authoring",
      version: "0.1.0",
      name: "scient-skill-authoring",
      kind: "meta",
      role: "constructive",
      visibility: "user",
      activation: { scope: "user", defaultEnabled: true },
      origin: SCIENT_BUILT_IN_ORIGIN,
      capabilities: {
        network: false,
        codeExecution: false,
        projectWrites: "proposal-only",
      },
    });
    expect(skillAuthoring?.body).toContain("# Scient Skill Authoring");
    expect(skillAuthoring?.assets).toEqual([]);
    expect(skillAuthoring?.digest).toMatch(/^sha256:[0-9a-f]{64}$/);

    expect(evidenceToNote).toMatchObject({
      id: "scient.evidence-to-note",
      version: "0.1.0",
      name: "scient-evidence-to-note",
      kind: "scientific",
      role: "constructive",
      visibility: "user",
      activation: { scope: "project", defaultEnabled: false },
      origin: SCIENT_BUILT_IN_ORIGIN,
      capabilities: {
        network: false,
        codeExecution: false,
        projectWrites: "proposal-only",
      },
    });
    expect(evidenceToNote?.requirements.projectObjects).toContain("selected source evidence");
    expect(evidenceToNote?.requirements.operations).toContain("propose evidence-linked note");
    expect(evidenceToNote?.body).toContain("# Evidence to Note");
    expect(evidenceToNote?.assets).toEqual([]);
    expect(evidenceToNote?.digest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(evidenceToNote && getBuiltInSkillReadiness(evidenceToNote)).toBe("latent");

    expect(medicalStudy).toMatchObject({
      id: "scient.medical-exam-study",
      version: "0.1.0",
      name: "scient-medical-exam-study",
      kind: "scientific",
      role: "constructive",
      scope: "domain",
      visibility: "user",
      activation: { scope: "user", defaultEnabled: false },
      origin: SCIENT_BUILT_IN_ORIGIN,
      capabilities: {
        network: true,
        codeExecution: false,
        projectWrites: "proposal-only",
      },
    });
    expect(medicalStudy?.body).toContain("# Medical Exam Study");
    expect(medicalStudy?.description).toContain("Do not use for general medical research");
    expect(medicalStudy?.assets).toEqual([
      expect.objectContaining({
        path: "assets/minimal-rtl-lesson.html",
        contents: expect.stringContaining('lang="he" dir="rtl"'),
      }),
    ]);
    expect(medicalStudy?.digest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(medicalStudy && getBuiltInSkillReadiness(medicalStudy)).toBe("available");

    expect(listUserFacingBuiltInSkillReleases()).toEqual(releases);
    expect(listCurrentBuiltInSkillReleases()).toEqual(releases);
    expect(listUserActivatedBuiltInSkillReleases()).toEqual([medicalStudy, skillAuthoring]);
    expect(listProjectActivatableBuiltInSkillReleases()).toEqual([evidenceToNote]);
  });

  it("keeps old immutable releases resolvable while exposing only the newest release", () => {
    const release = listBuiltInSkillReleases().find(
      (candidate) => candidate.id === "scient.skill-authoring",
    );
    expect(release).toBeDefined();
    if (!release) return;
    const oldRelease = { ...release, version: "0.2.0" };
    const currentRelease = { ...release, version: "0.10.0" };

    expect(selectCurrentBuiltInSkillReleases([currentRelease, release, oldRelease])).toEqual([
      currentRelease,
    ]);
  });

  it("resolves only an exact identity, origin, and digest", () => {
    const release = listBuiltInSkillReleases().find(
      (candidate) => candidate.id === "scient.skill-authoring",
    );
    expect(release).toBeDefined();
    if (!release) return;
    const activation = {
      id: release.id,
      version: release.version,
      digest: release.digest,
      origin: release.origin,
    };
    expect(resolveBuiltInSkillsLock(createBuiltInSkillsLock([activation]))[0]).toMatchObject({
      status: "resolved",
      activation,
      release: { id: release.id, version: release.version },
    });
    expect(
      resolveBuiltInSkillsLock(
        createBuiltInSkillsLock([{ ...activation, digest: `sha256:${"0".repeat(64)}` }]),
      )[0],
    ).toMatchObject({ status: "digest-mismatch" });
  });

  it("rejects sidecar fields that the release contract does not understand", () => {
    const release = listBuiltInSkillReleases().find(
      (candidate) => candidate.id === "scient.skill-authoring",
    );
    expect(release).toBeDefined();
    if (!release) return;

    expect(() =>
      assertBuiltInSkillMetadata({
        id: release.id,
        version: release.version,
        displayName: release.displayName,
        kind: release.kind,
        role: release.role,
        scope: release.scope,
        visibility: release.visibility,
        activation: release.activation,
        maintainer: release.maintainer,
        capabilities: release.capabilities,
        requirements: release.requirements,
        limitations: release.limitations,
        accidentalAuthority: true,
      }),
    ).toThrow("unexpected accidentalAuthority");
  });
});
