import { collectComposerInlineTokens } from "@t3tools/shared/composerInlineTokens";

import type { McpScientSkillDescriptor } from "../../mcp/McpInvocationContext.ts";

/**
 * Turn-local routing for an explicit `$skill` selection.
 *
 * This does not activate a skill or add authority. It only makes the user's
 * visible composer selection deterministic for the exact active releases
 * already bound to the provider session.
 */
export interface PreparedScientSkillTurn {
  readonly input: string | undefined;
  readonly selectedReleaseKeys: ReadonlySet<string>;
}

export function prepareScientSkillTurn(
  input: string | undefined,
  activeSkills: ReadonlyArray<McpScientSkillDescriptor> | undefined,
): PreparedScientSkillTurn {
  if (!input || !activeSkills || activeSkills.length === 0) {
    return { input, selectedReleaseKeys: new Set() };
  }
  const byName = new Map(activeSkills.map((skill) => [skill.name, skill] as const));
  const selected = new Map<string, McpScientSkillDescriptor>();
  for (const token of collectComposerInlineTokens(`${input}\n`)) {
    if (token.type !== "skill") continue;
    const skill = byName.get(token.value);
    if (skill) selected.set(skill.releaseKey, skill);
  }
  if (selected.size === 0) return { input, selectedReleaseKeys: new Set() };

  const selections = [...selected.values()]
    .sort((left, right) => left.name.localeCompare(right.name))
    .map((skill) => `\`${skill.name}\` (${skill.releaseKey})`)
    .join(", ");
  return {
    input: `${input}\n\n[Scient runtime instruction: The user explicitly selected ${selections}. Before doing the requested work, load each exact release with \`scient_skill_load\`. This selection grants no additional tools or permissions.]`,
    selectedReleaseKeys: new Set(selected.keys()),
  };
}
