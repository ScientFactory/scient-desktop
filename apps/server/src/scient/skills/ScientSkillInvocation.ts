// @effect-diagnostics nodeBuiltinImport:off -- The server computes a non-authorizing scope freshness digest.
import * as NodeCrypto from "node:crypto";

import type { SkillRelease } from "@scientfactory/scient-skills";

import type {
  AgentSkillDescriptor,
  AgentSkillScope,
} from "../operations/AgentInvocationContext.ts";
import { BUILT_IN_DOCUMENT_LAB_SKILL_RELEASES } from "./BuiltInSkillReleases.ts";

/**
 * Builds the exact skill visibility and authority for one provider turn.
 *
 * Automatic skills are discoverable; explicit skills enter the snapshot only
 * when the current composer supplies their exact name as selection metadata.
 * Serialized provider text (captures, citations, history) is not selection authority.
 */
export interface PreparedScientSkillTurn {
  readonly input: string | undefined;
  readonly runtimeInstruction: string | undefined;
  readonly skillScope: AgentSkillScope;
  /** True when the turn carries the automatic skills' names and descriptions. */
  readonly catalogIndexIncluded: boolean;
  /** Versions the automatic index text alone, so a one-turn selection does not resend it. */
  readonly catalogIndexDigest: string;
}

export interface ScientSkillTurnProjection {
  readonly skillLoadToolName: string;
  readonly skillListToolName?: string;
  readonly includeCatalogMarker?: boolean;
  readonly providerNativeSkillTool?: boolean;
  readonly deferred?: boolean;
  /**
   * With the catalog marker: "full" lists every automatic skill's name and description,
   * "unchanged" points back to the list an earlier turn of this provider session received.
   * Omitted keeps the count-and-digest marker alone.
   */
  readonly catalogIndex?: "full" | "unchanged";
}

/**
 * The automatic index's allowance. Past it the turn gets the marker and a pointer to search,
 * never a silently truncated list. Today's built-ins take about 6.5 KB.
 */
export const SCIENT_SKILL_INDEX_MAX_BYTES = 16_384;

const documentLabSkillIds = new Set(BUILT_IN_DOCUMENT_LAB_SKILL_RELEASES.map(({ id }) => id));

const oneLine = (text: string): string => text.replace(/\s+/gu, " ").trim();

const DEFAULT_PROJECTION: ScientSkillTurnProjection = {
  skillLoadToolName: "scient_skill_load",
};

const isNativeSlashCommand = (input: string | undefined): boolean =>
  input !== undefined && /^\s*\/[A-Za-z][\w-]*(?:\s|$)/u.test(input);

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
  const skillCount = `${skills.length} ${skills.length === 1 ? "skill" : "skills"}`;
  const instructions: string[] = [];
  // Selected skills get an exact-name loading note. Instruction bodies never enter the turn.
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

  const listTool = projection.skillListToolName ?? "scient_skills_list";
  const loadTool = projection.skillLoadToolName;
  // Routing needs what a skill is for, so the automatic skills' names and descriptions are
  // listed once per provider session and catalog version. A selection never changes the list;
  // selected skills also get their own loading note.
  const automaticEntries = skills
    .filter((skill) => skill.invocationPolicy === "automatic")
    .map((skill) => `- ${skill.name}: ${oneLine(skill.description)}`);
  const indexEntries = automaticEntries.join("\n");
  const indexFits = Buffer.byteLength(indexEntries) <= SCIENT_SKILL_INDEX_MAX_BYTES;
  const loadHow = `load it with \`${loadTool}\` before you do that part of the work${projection.deferred ? ` (if \`${loadTool}\` is deferred, load it through \`ToolSearch\` first)` : ""}`;
  let catalogIndexIncluded = false;
  const markerText = (): string | undefined => {
    if (!projection.includeCatalogMarker || !input?.trim() || isNativeSlashCommand(input))
      return undefined;
    if (catalogStatus !== "incomplete" && skills.length === 0)
      return `[Scient skill scope for this turn is complete and empty (0 skills). No Scient-managed skills are available in this scope; no \`${listTool}\` call is needed. Provider-native skills are separate.]`;
    const index = projection.catalogIndex;
    if (index !== undefined && automaticEntries.length > 0) {
      const status =
        catalogStatus === "incomplete"
          ? `incomplete, so others may exist (search them with \`${listTool}\`)`
          : `complete; ${skillCount}; digest ${catalogDigest}`;
      if (index === "full" && indexFits) {
        catalogIndexIncluded = true;
        return `[Scient skills for this turn (${status}). These are Scient-managed, separate from your provider's own skills. When one fits the request, ${loadHow}; an unrelated request needs none. Later turns say when this list is unchanged.\n${indexEntries}\n]`;
      }
      if (index === "unchanged" && catalogStatus !== "incomplete")
        return `[Scient skills for this turn: unchanged since the list an earlier turn gave (${skillCount}; digest ${catalogDigest}). When one fits the request, ${loadHow}. If that list is no longer in view, call \`${listTool}\`. Provider-native skills are separate.]`;
      if (index === "full" && catalogStatus !== "incomplete")
        return `[Scient skills for this turn: complete; ${skillCount}; digest ${catalogDigest}; too many to list here. Before choosing how to do a substantive request, search them with \`${listTool}\` and load any that fits. Provider-native skills are separate.]`;
    }
    return catalogStatus === "incomplete"
      ? `[Scient skill scope for this turn is incomplete; emptiness cannot be inferred. Use \`${listTool}\` to discover available Scient-managed skills as needed; results may be partial. Provider-native skills are separate.]`
      : `[Scient skill scope for this turn: complete; ${skillCount}; digest ${catalogDigest} (freshness only). Reuse visible summaries only from a full result (\`scope.includesAllSkills\`) with the same digest if sufficient; otherwise call \`${listTool}\`. Provider-native skills are separate.]`;
  };

  const catalogMarker = markerText();
  const documentLabNote =
    catalogMarker &&
    skills.some(({ origin, id }) => origin === "scient" && documentLabSkillIds.has(id))
      ? `[When a listed Document Lab skill fits the request, first load it with \`${loadTool}\`. This is the Scient loader for the listed skill, including when provider skills overlap. If the matching skill is absent, continue with the tools and skills available to you.]`
      : undefined;
  const runtimeInstruction = [
    documentLabNote,
    catalogMarker,
    instructions.length > 0
      ? `[Scient selected skills for this turn:\n${instructions.join("\n")}\n]`
      : undefined,
  ]
    .filter((instruction): instruction is string => instruction !== undefined)
    .join("\n\n");
  const preparedRuntimeInstruction = runtimeInstruction.length > 0 ? runtimeInstruction : undefined;
  return {
    runtimeInstruction: preparedRuntimeInstruction,
    input: preparedRuntimeInstruction
      ? [input, preparedRuntimeInstruction].filter(Boolean).join("\n\n")
      : input,
    catalogIndexIncluded,
    catalogIndexDigest: `sha256:${NodeCrypto.createHash("sha256").update(indexEntries).digest("hex")}`,
    skillScope: {
      catalog: { status: catalogStatus, digest: catalogDigest },
      releases: new Map(
        skills.map((skill) => [skill.releaseKey, activeReleases!.get(skill.releaseKey)!] as const),
      ),
      skills,
    },
  };
}
