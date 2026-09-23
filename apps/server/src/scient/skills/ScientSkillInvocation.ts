// @effect-diagnostics nodeBuiltinImport:off -- The server computes a non-authorizing scope freshness digest.
import * as NodeCrypto from "node:crypto";

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
  readonly providerNativeSkillTool?: boolean;
  readonly deferred?: boolean;
}

const DEFAULT_PROJECTION: ScientSkillTurnProjection = {
  skillLoadToolName: "scient_skill_load",
};

export function prepareScientSkillTurn(
  input: string | undefined,
  activeSkills: ReadonlyArray<AgentSkillDescriptor> | undefined,
  activeReleases: ReadonlyMap<string, SkillRelease> | undefined,
  projection: ScientSkillTurnProjection = DEFAULT_PROJECTION,
  selectedNames: ReadonlyArray<string> = [],
  catalogStatus: "complete" | "incomplete" = "complete",
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
  const catalogDigest = `sha256:${NodeCrypto.createHash("sha256")
    .update(
      JSON.stringify(
        skills.map((skill) => {
          const release = activeReleases!.get(skill.releaseKey)!;
          return [
            release.id,
            release.version,
            release.origin,
            release.digest,
            skill.name,
            skill.activationScope,
            skill.invocationPolicy,
          ];
        }),
      ),
    )
    .digest("hex")}`;
  const instructions: string[] = [];
  // Automatic discovery belongs to the stable skill tools, not user input.
  // Only structured, explicit selections need turn-local orientation. Never
  // include descriptions or instruction bodies here, even for selected skills.
  for (const skill of skills) {
    if (selected.has(skill.releaseKey)) {
      instructions.push(
        `- \`${skill.name}\` (selected by the user): load with \`{"name":"${skill.name}"}\` before doing the requested work.`,
      );
    }
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
      ? `[Scient selected skills for this turn:\n${instructions.join("\n")}\n]`
      : undefined;
  return {
    input: runtimeInstruction ? [input, runtimeInstruction].filter(Boolean).join("\n\n") : input,
    skillScope: {
      catalog: { status: catalogStatus, digest: catalogDigest },
      releases: new Map(
        skills.map((skill) => [skill.releaseKey, activeReleases!.get(skill.releaseKey)!] as const),
      ),
      skills,
    },
  };
}
