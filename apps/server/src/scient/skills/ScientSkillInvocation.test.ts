import { describe, expect, it } from "@effect/vitest";

import { prepareScientSkillTurn } from "./ScientSkillInvocation.ts";

const skills = [
  {
    releaseKey: `scient.workspace-readiness-review@0.1.0#sha256:${"a".repeat(64)}`,
    id: "scient.workspace-readiness-review",
    name: "workspace-readiness-review",
    description: "Review workspace readiness.",
    invocationPolicy: "automatic" as const,
  },
];

describe("explicit Scient skill invocation", () => {
  it("adds an exact private routing instruction for a selected active skill", () => {
    const result = prepareScientSkillTurn(
      "Please use $workspace-readiness-review to inspect this.",
      skills,
    );
    expect(result.input).toContain("The user explicitly selected");
    expect(result.input).toContain(skills[0]!.releaseKey);
    expect(result.input).toContain("grants no additional tools or permissions");
    expect(result.selectedReleaseKeys).toEqual(new Set([skills[0]!.releaseKey]));
  });

  it("leaves inactive, partial, and ordinary text unchanged", () => {
    expect(prepareScientSkillTurn("Use $unknown please.", skills)).toEqual({
      input: "Use $unknown please.",
      selectedReleaseKeys: new Set(),
    });
    expect(prepareScientSkillTurn("Use $workspace-readiness", skills)).toEqual({
      input: "Use $workspace-readiness",
      selectedReleaseKeys: new Set(),
    });
    expect(prepareScientSkillTurn("Review this workspace.", skills)).toEqual({
      input: "Review this workspace.",
      selectedReleaseKeys: new Set(),
    });
  });
});
