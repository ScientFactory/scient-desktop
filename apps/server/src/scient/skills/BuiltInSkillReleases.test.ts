// @effect-diagnostics nodeBuiltinImport:off -- This test validates the on-disk candidate release.
import * as NodePath from "node:path";

import { loadSkillRelease } from "@scientfactory/scient-skills";
import { describe, expect, it } from "@effect/vitest";

import { BUILT_IN_SKILL_RELEASE_ROOTS } from "./BuiltInSkillReleases.ts";

const candidateRoots = {
  improve: NodePath.join(import.meta.dirname, "candidates", "improve-workspace-readiness"),
  review: NodePath.join(import.meta.dirname, "candidates", "workspace-readiness-review"),
};

describe("Scient built-in skill candidates", () => {
  it("keeps the workspace readiness releases valid but dormant", async () => {
    const [improve, review] = await Promise.all([
      loadSkillRelease(candidateRoots.improve),
      loadSkillRelease(candidateRoots.review),
    ]);

    expect([improve, review]).toMatchObject([
      {
        id: "scient.improve-workspace-readiness",
        version: "0.1.0",
        activationScope: "user",
        origin: "scient",
        resources: [],
      },
      {
        id: "scient.workspace-readiness-review",
        version: "0.1.0",
        activationScope: "user",
        origin: "scient",
        resources: [],
      },
    ]);
    expect(BUILT_IN_SKILL_RELEASE_ROOTS).not.toContain(candidateRoots.improve);
    expect(BUILT_IN_SKILL_RELEASE_ROOTS).not.toContain(candidateRoots.review);
  });
});
