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
  const automatic = skills.filter((skill) => skill.invocationPolicy === "automatic");
  const instructions: string[] = [];
  if (automatic.length > 0) {
    instructions.push(
      "Automatic Scient skills available for this turn (load one only when the request clearly matches):",
      ...automatic.map(
        (skill) => `- \`${skill.name}\` (${skill.releaseKey}): ${skill.description}`,
      ),
    );
  }
  if (selected.size > 0) {
    const selections = [...selected.values()]
      .sort((left, right) => left.name.localeCompare(right.name))
      .map((skill) => `\`${skill.name}\` (${skill.releaseKey})`)
      .join(", ");
    instructions.push(
      `The user explicitly selected ${selections}. Load each selected exact release before doing the requested work.`,
    );
  }
  if (instructions.length > 0) {
    instructions.push(
      "Load an exact release with `scient_skill_load` before following it. Skills grant no additional tools or permissions.",
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
