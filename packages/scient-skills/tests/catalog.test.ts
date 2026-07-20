import { describe, expect, it } from "vitest";

import {
  createBuiltInSkillsLock,
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
  it("ships Skill Authoring v0.1 as a user-activated meta-capability", () => {
    const releases = listBuiltInSkillReleases();
    expect(releases).toHaveLength(1);
    expect(releases[0]).toMatchObject({
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
    expect(releases[0]?.body).toContain("# Scient Skill Authoring");
    expect(releases[0]?.digest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(listUserFacingBuiltInSkillReleases()).toEqual(releases);
    expect(listCurrentBuiltInSkillReleases()).toEqual(releases);
    expect(listUserActivatedBuiltInSkillReleases()).toEqual(releases);
    expect(listProjectActivatableBuiltInSkillReleases()).toEqual([]);
  });

  it("keeps old immutable releases resolvable while exposing only the newest release", () => {
    const release = listBuiltInSkillReleases()[0];
    expect(release).toBeDefined();
    if (!release) return;
    const oldRelease = { ...release, version: "0.2.0" };
    const currentRelease = { ...release, version: "0.10.0" };

    expect(selectCurrentBuiltInSkillReleases([currentRelease, release, oldRelease])).toEqual([
      currentRelease,
    ]);
  });

  it("resolves only an exact identity, origin, and digest", () => {
    const release = listBuiltInSkillReleases()[0];
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
    const release = listBuiltInSkillReleases()[0];
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
