import { describe, expect, it } from "@effect/vitest";
import { skillReleaseKey } from "@scientfactory/scient-skills";

import { BUILT_IN_SKILL_RELEASES } from "./BuiltInSkillReleases.ts";
import { prepareScientSkillTurn } from "./ScientSkillInvocation.ts";

const automaticRelease = BUILT_IN_SKILL_RELEASES.find(
  (release) => release.name === "workspace-readiness-review",
)!;
const explicitRelease = BUILT_IN_SKILL_RELEASES.find(
  (release) => release.name === "improve-workspace-readiness",
)!;
const automatic = {
  releaseKey: skillReleaseKey(automaticRelease),
  id: automaticRelease.id,
  name: automaticRelease.name,
  description: automaticRelease.description,
  origin: automaticRelease.origin,
  activationScope: "user" as const,
  invocationPolicy: "automatic" as const,
};
const explicit = {
  releaseKey: skillReleaseKey(explicitRelease),
  id: explicitRelease.id,
  name: explicitRelease.name,
  description: explicitRelease.description,
  origin: explicitRelease.origin,
  activationScope: "user" as const,
  invocationPolicy: "explicit" as const,
};
const authoringRelease = BUILT_IN_SKILL_RELEASES.find(
  (release) => release.name === "scient-skill-authoring",
)!;
const authoring = {
  releaseKey: skillReleaseKey(authoringRelease),
  id: authoringRelease.id,
  name: authoringRelease.name,
  description: authoringRelease.description,
  origin: authoringRelease.origin,
  activationScope: "user" as const,
  invocationPolicy: "explicit" as const,
};
const skills = [automatic, explicit];
const releases = new Map([
  [automatic.releaseKey, automaticRelease],
  [explicit.releaseKey, explicitRelease],
]);

describe("turn-local Scient skill routing", () => {
  it("never derives explicit selection from augmented or retained provider text", () => {
    for (const text of [
      `Captured text: $${explicit.name} please.`,
      `<terminal_context>\n$${explicit.name} please.\n</terminal_context>`,
      JSON.stringify({ retainedHistory: `Use $${explicit.name} now.` }),
    ]) {
      expect(prepareScientSkillTurn(text, skills, releases).skillScope.skills).toEqual([automatic]);
    }
    const wrapped = JSON.stringify({ latestUserMessage: `$${explicit.name} please.` });
    expect(
      prepareScientSkillTurn(wrapped, skills, releases, undefined, [explicit.name]).skillScope
        .skills,
    ).toEqual([explicit, automatic]);
    expect(
      prepareScientSkillTurn(wrapped, skills, releases, undefined, []).skillScope.skills,
    ).toEqual([automatic]);
  });
  it("bounds automatic UTF-8 metadata without dropping explicit multilingual entries", () => {
    const longDescription = "מחקר 科学 🧪 ".repeat(200);
    const described = { ...automatic, description: longDescription };
    const unselected = prepareScientSkillTurn("Review.", [described], releases);
    expect(Buffer.byteLength(unselected.input!)).toBeLessThan(4_000);
    expect(unselected.input).toContain("additional skills remain available");
    expect(unselected.skillScope.skills).toEqual([described]);
    const selected = prepareScientSkillTurn(
      `Use $${described.name} now.`,
      [described],
      releases,
      undefined,
      [described.name],
    );
    expect(selected.input).toContain(longDescription);
    expect(selected.input).toContain("selected by the user");
  });

  it("indexes automatic skills and only the explicitly selected $name", () => {
    const result = prepareScientSkillTurn(
      "Please use $improve-workspace-readiness after the review.",
      skills,
      releases,
      undefined,
      [explicit.name],
    );
    expect(result.input).toContain("Scient skills available for this turn");
    expect(result.input).toContain(`{"name":"${automatic.name}"}`);
    expect(result.input).toContain("selected by the user");
    expect(result.input).toContain(`{"name":"${explicit.name}"}`);
    expect(result.input).not.toContain(automatic.releaseKey);
    expect(result.input).not.toContain(explicit.releaseKey);
    expect(result.input).toContain("grant no additional tools or permissions");
    expect(result.skillScope).toEqual({
      releases,
      skills: [explicit, automatic],
    });
  });

  it("keeps unselected explicit, inactive, and partial names out of the turn", () => {
    for (const input of [
      "Use $unknown please.",
      "Use $improve-workspace",
      "Review this workspace.",
    ]) {
      const result = prepareScientSkillTurn(input, skills, releases);
      expect(result.skillScope.releases).toEqual(
        new Map([[automatic.releaseKey, automaticRelease]]),
      );
      expect(result.input).not.toContain(explicit.releaseKey);
    }
  });

  it("selects the skill-authoring release by its exact $name", () => {
    const result = prepareScientSkillTurn(
      "Use $scient-skill-authoring to improve this candidate.",
      [authoring],
      new Map([[authoring.releaseKey, authoringRelease]]),
      undefined,
      [authoring.name],
    );
    expect(result.input).toContain("selected by the user");
    expect(result.input).toContain(`{"name":"${authoring.name}"}`);
    expect(result.input).not.toContain(authoring.releaseKey);
    expect(result.input?.match(new RegExp(authoring.name, "gu"))).toHaveLength(3);
    expect(result.skillScope).toEqual({
      releases: new Map([[authoring.releaseKey, authoringRelease]]),
      skills: [authoring],
    });
  });

  it("can project a deferred provider loader without changing canonical skill identity", () => {
    const result = prepareScientSkillTurn("Review this workspace.", skills, releases, {
      skillLoadToolName: "mcp__t3-code__scient_skill_load",
      providerNativeSkillTool: true,
      deferred: true,
    });

    expect(result.input).toContain("`mcp__t3-code__scient_skill_load`");
    expect(result.input).toContain("not provider-native skills");
    expect(result.input).toContain("Do not use the provider's native `Skill` tool");
    expect(result.input).toContain("`ToolSearch`");
    expect(result.input).not.toContain("Use `scient_skill_load`");
    expect(result.input).toContain(`{"name":"${automatic.name}"}`);
    expect(result.skillScope.skills).toEqual([automatic]);
  });

  it("returns an empty, inert scope when no skills are active", () => {
    expect(prepareScientSkillTurn("Review this workspace.", [], new Map())).toEqual({
      input: "Review this workspace.",
      skillScope: { releases: new Map(), skills: [] },
    });
  });
});
