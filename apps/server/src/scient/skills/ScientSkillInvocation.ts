import { collectComposerInlineTokens } from "@t3tools/shared/composerInlineTokens";

import type {
  McpScientSkillDescriptor,
  McpScientSkillScope,
} from "../../mcp/McpInvocationContext.ts";

/**
 * Builds the exact skill visibility and authority for one provider turn.
 *
 * Automatic skills are discoverable; explicit skills enter the snapshot only
 * when the user's visible composer text selects their exact `$name`.
 */
export interface PreparedScientSkillTurn {
  readonly input: string | undefined;
  readonly skillScope: McpScientSkillScope;
}

export function prepareScientSkillTurn(
  input: string | undefined,
  activeSkills: ReadonlyArray<McpScientSkillDescriptor> | undefined,
): PreparedScientSkillTurn {
  const available = activeSkills ?? [];
  const byName = new Map(available.map((skill) => [skill.name, skill] as const));
  const selected = new Map<string, McpScientSkillDescriptor>();
  if (input) {
    for (const token of collectComposerInlineTokens(`${input}\n`)) {
      if (token.type !== "skill") continue;
      const skill = byName.get(token.value);
      if (skill) selected.set(skill.releaseKey, skill);
    }
  }

  const effective = new Map(
    available
      .filter((skill) => skill.invocationPolicy === "automatic")
      .map((skill) => [skill.releaseKey, skill] as const),
  );
  for (const [releaseKey, skill] of selected) effective.set(releaseKey, skill);

  const skills = [...effective.values()].sort(
    (left, right) => left.name.localeCompare(right.name) || left.id.localeCompare(right.id),
  );
  const instructions: string[] = [];
  if (skills.length > 0) {
    instructions.push(
      "Scient skills available for this turn:",
      ...skills.map(
        (skill) =>
          `- \`${skill.name}\` (${selected.has(skill.releaseKey) ? "selected by the user; load before doing the requested work" : "automatic; load only on a clear match"}; call with \`{"name":"${skill.name}"}\`): ${skill.description}`,
      ),
    );
  }
  if (instructions.length > 0) {
    instructions.push(
      "Use `scient_skill_load` with only the exact listed `name`; do not construct or supply a release identifier. Skills grant no additional tools or permissions.",
    );
  }

  const runtimeInstruction =
    instructions.length > 0
      ? `[Scient runtime instruction:\n${instructions.join("\n")}\n]`
      : undefined;
  return {
    input: runtimeInstruction ? [input, runtimeInstruction].filter(Boolean).join("\n\n") : input,
    skillScope: {
      releaseKeys: new Set(skills.map((skill) => skill.releaseKey)),
      skills,
    },
  };
}
