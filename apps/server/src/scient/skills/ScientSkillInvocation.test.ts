import { describe, expect, it } from "@effect/vitest";

import { prepareScientSkillTurn } from "./ScientSkillInvocation.ts";

const automatic = {
  releaseKey: `scient.workspace-readiness-review@0.1.0#sha256:${"a".repeat(64)}`,
  id: "scient.workspace-readiness-review",
  name: "workspace-readiness-review",
  description: "Review workspace readiness.",
  invocationPolicy: "automatic" as const,
};
const explicit = {
  releaseKey: `scient.improve-workspace-readiness@0.1.0#sha256:${"b".repeat(64)}`,
  id: "scient.improve-workspace-readiness",
  name: "improve-workspace-readiness",
  description: "Improve workspace readiness.",
  invocationPolicy: "explicit" as const,
};
const authoring = {
  releaseKey: `scient.skill-authoring@0.1.0#sha256:${"c".repeat(64)}`,
  id: "scient.skill-authoring",
  name: "scient-skill-authoring",
  description: "Create or improve skills for Scient.",
  invocationPolicy: "explicit" as const,
};
const skills = [automatic, explicit];

describe("turn-local Scient skill routing", () => {
  it("indexes automatic skills and only the explicitly selected $name", () => {
    const result = prepareScientSkillTurn(
      "Please use $improve-workspace-readiness after the review.",
      skills,
    );
    expect(result.input).toContain("Scient skills available for this turn");
    expect(result.input).toContain(`{"name":"${automatic.name}"}`);
    expect(result.input).toContain("selected by the user");
    expect(result.input).toContain(`{"name":"${explicit.name}"}`);
    expect(result.input).not.toContain(automatic.releaseKey);
    expect(result.input).not.toContain(explicit.releaseKey);
    expect(result.input).toContain("grant no additional tools or permissions");
    expect(result.skillScope).toEqual({
      releaseKeys: new Set([automatic.releaseKey, explicit.releaseKey]),
      skills: [explicit, automatic],
    });
  });

  it("keeps unselected explicit, inactive, and partial names out of the turn", () => {
    for (const input of [
      "Use $unknown please.",
      "Use $improve-workspace",
      "Review this workspace.",
    ]) {
      const result = prepareScientSkillTurn(input, skills);
      expect(result.skillScope.releaseKeys).toEqual(new Set([automatic.releaseKey]));
      expect(result.input).not.toContain(explicit.releaseKey);
    }
  });

  it("selects the skill-authoring release by its exact $name", () => {
    const result = prepareScientSkillTurn(
      "Use $scient-skill-authoring to improve this candidate.",
      [authoring],
    );
    expect(result.input).toContain("selected by the user");
    expect(result.input).toContain(`{"name":"${authoring.name}"}`);
    expect(result.input).not.toContain(authoring.releaseKey);
    expect(result.input?.match(new RegExp(authoring.name, "gu"))).toHaveLength(3);
    expect(result.skillScope).toEqual({
      releaseKeys: new Set([authoring.releaseKey]),
      skills: [authoring],
    });
  });

  it("returns an empty, inert scope when no skills are active", () => {
    expect(prepareScientSkillTurn("Review this workspace.", [])).toEqual({
      input: "Review this workspace.",
      skillScope: { releaseKeys: new Set(), skills: [] },
    });
  });
});
