import type { SkillRelease } from "@scientfactory/scient-skills";

import type {
  AgentSkillDescriptor,
  AgentSkillScope,
} from "../operations/AgentInvocationContext.ts";

/**
 * Builds the exact skill visibility and authority for one provider turn.
 *
 * Automatic skills are discoverable; explicit skills enter the snapshot only
 * when the current composer supplies their exact name as selection metadata.
 * Serialized provider text (captures, citations, history) is not selection authority.
 */
export interface PreparedScientSkillTurn {
  readonly input: string | undefined;
  readonly skillScope: AgentSkillScope;
}

export interface ScientSkillTurnProjection {
  readonly skillLoadToolName: string;
  readonly skillListToolName?: string;
  readonly providerNativeSkillTool?: boolean;
  readonly deferred?: boolean;
  /** Under input pressure, omit automatic entry lines, not selected intent. */
  readonly omitAutomaticIndex?: boolean;
}

const DEFAULT_PROJECTION: ScientSkillTurnProjection = {
  skillLoadToolName: "scient_skill_load",
  skillListToolName: "scient_skills_list",
};

/** Bounds automatic orientation only; exact selected instructions are never cut. */
const AUTOMATIC_SKILL_INDEX_BYTE_BUDGET = 2_800;

export function prepareScientSkillTurn(
  input: string | undefined,
  activeSkills: ReadonlyArray<AgentSkillDescriptor> | undefined,
  activeReleases: ReadonlyMap<string, SkillRelease> | undefined,
  projection: ScientSkillTurnProjection = DEFAULT_PROJECTION,
  selectedNames: ReadonlyArray<string> = [],
): PreparedScientSkillTurn {
  const available = (activeSkills ?? []).filter((skill) => activeReleases?.has(skill.releaseKey));
  const byName = new Map(available.map((skill) => [skill.name, skill] as const));
  const selected = new Map<string, AgentSkillDescriptor>();
  for (const name of selectedNames) {
    const skill = byName.get(name);
    if (skill) selected.set(skill.releaseKey, skill);
  }

  const effective = new Map(
    available
      .filter((skill) => skill.invocationPolicy === "automatic")
      .map((skill) => [skill.releaseKey, skill] as const),
  );
  for (const [releaseKey, skill] of selected) effective.set(releaseKey, skill);

  const skills = [...effective.values()].sort((left, right) =>
    left.name < right.name
      ? -1
      : left.name > right.name
        ? 1
        : left.id < right.id
          ? -1
          : left.id > right.id
            ? 1
            : 0,
  );
  const instructions: string[] = [];
  let automaticBytes = 0;
  let omitted = 0;
  const index: string[] = [];
  for (const skill of skills) {
    const isSelected = selected.has(skill.releaseKey);
    const line = `- \`${skill.name}\` (${isSelected ? "selected by the user; load before doing the requested work" : "automatic; load only on a clear match"}; call with \`{"name":"${skill.name}"}\`): ${skill.description}`;
    const bytes = Buffer.byteLength(line, "utf8");
    if (
      !isSelected &&
      (projection.omitAutomaticIndex || automaticBytes + bytes > AUTOMATIC_SKILL_INDEX_BYTE_BUDGET)
    ) {
      omitted++;
      continue;
    }
    if (!isSelected) automaticBytes += bytes;
    index.push(line);
  }
  if (skills.length > 0) {
    instructions.push(
      "Scient skills available for this turn:",
      ...index,
      ...(omitted > 0
        ? [
            `${omitted} additional skills remain available. Search \`${projection.skillListToolName ?? "scient_skills_list"}\` with \`{"query":"topic"}\` or browse with \`{"offset":0,"limit":20}\`; follow nextOffset for more. Omission from this short index does not disable a skill.`,
          ]
        : []),
    );
  }
  if (instructions.length > 0) {
    instructions.push(
      ...(projection.providerNativeSkillTool
        ? [
            "These are Scient-managed skills, not provider-native skills. Do not use the provider's native `Skill` tool for them.",
          ]
        : []),
      ...(projection.deferred
        ? [
            `If \`${projection.skillLoadToolName}\` is deferred, load that exact fully qualified name through \`ToolSearch\` first.`,
          ]
        : []),
      `Use \`${projection.skillLoadToolName}\` with only the exact listed \`name\`; do not construct or supply a release identifier. Skills grant no additional tools or permissions.`,
    );
  }

  const runtimeInstruction =
    instructions.length > 0
      ? `[Scient runtime instruction:\n${instructions.join("\n")}\n]`
      : undefined;
  return {
    input: runtimeInstruction ? [input, runtimeInstruction].filter(Boolean).join("\n\n") : input,
    skillScope: {
      releases: new Map(
        skills.map((skill) => [skill.releaseKey, activeReleases!.get(skill.releaseKey)!] as const),
      ),
      skills,
    },
  };
}
