// @effect-diagnostics nodeBuiltinImport:off -- This test validates the on-disk candidate release.
import * as NodePath from "node:path";

import { loadSkillRelease } from "@scientfactory/scient-skills";
import { describe, expect, it } from "@effect/vitest";

import { BUILT_IN_SKILL_RELEASE_ROOTS } from "./BuiltInSkillReleases.ts";

const candidateRoot = NodePath.join(
  import.meta.dirname,
  "candidates",
  "workspace-readiness-review",
);

describe("Scient built-in skill candidates", () => {
  it("keeps the workspace readiness release valid but dormant", async () => {
    const release = await loadSkillRelease(candidateRoot);

    expect(release).toMatchObject({
      id: "scient.workspace-readiness-review",
      version: "0.1.0",
      activationScope: "user",
      origin: "scient",
      resources: [],
    });
    expect(BUILT_IN_SKILL_RELEASE_ROOTS).not.toContain(candidateRoot);
  });
});
