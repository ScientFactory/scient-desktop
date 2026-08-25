import {
  formatProviderSkillDisplayName,
  isGlobalProviderSkill,
  resolveProviderSkillSourceKind,
  type ProviderSkillSourceKind,
} from "@t3tools/client-runtime/providerSkills";
import {
  isProviderAvailable,
  type ServerProvider,
  type ServerProviderSkill,
} from "@t3tools/contracts";

export interface ExternalSkillItem {
  readonly skill: ServerProviderSkill;
  readonly displayName: string;
  readonly description: string | undefined;
  readonly source: ProviderSkillSourceKind;
}

export interface ExternalSkillProviderGroup {
  readonly provider: ServerProvider;
  readonly skills: ReadonlyArray<ExternalSkillItem>;
}

const EXTERNAL_SKILL_DESCRIPTION_LIMIT = 160;

/**
 * Keep provider-authored discovery instructions available in the provider
 * snapshot while presenting a compact summary in Settings. Some providers use
 * `description` for both a human summary and detailed invocation guidance.
 */
export function compactExternalSkillDescription(
  description: string | undefined,
): string | undefined {
  const normalized = description?.replace(/\s+/g, " ").trim();
  if (!normalized) return undefined;

  const firstSentence = normalized.match(/^.*?[.!?](?=\s|$)/)?.[0] ?? normalized;
  if (firstSentence.length <= EXTERNAL_SKILL_DESCRIPTION_LIMIT) return firstSentence;

  const clipped = firstSentence.slice(0, EXTERNAL_SKILL_DESCRIPTION_LIMIT + 1);
  const wordBoundary = clipped.lastIndexOf(" ");
  const end =
    wordBoundary > EXTERNAL_SKILL_DESCRIPTION_LIMIT / 2
      ? wordBoundary
      : EXTERNAL_SKILL_DESCRIPTION_LIMIT;
  return `${firstSentence.slice(0, end).trimEnd()}…`;
}

export const externalSkillSourceLabel = (source: ProviderSkillSourceKind): string => {
  switch (source) {
    case "app":
      return "Provider bundled";
    case "personal":
      return "Personal";
    case "system":
      return "System";
    case "other":
      return "Provider managed";
    case "repo":
    case "project":
      return "Project";
  }
};

export function collectExternalSkillProviders(
  providers: ReadonlyArray<ServerProvider>,
): ReadonlyArray<ExternalSkillProviderGroup> {
  return providers.flatMap((provider) => {
    if (!provider.enabled || !provider.installed || !isProviderAvailable(provider)) return [];
    const skills = provider.skills
      .filter((skill) => isGlobalProviderSkill(skill) && !skill.path.startsWith("scient://skills/"))
      .map(
        (skill): ExternalSkillItem => ({
          skill,
          displayName: formatProviderSkillDisplayName(skill),
          description: compactExternalSkillDescription(skill.shortDescription ?? skill.description),
          source: resolveProviderSkillSourceKind(skill),
        }),
      )
      .toSorted((left, right) => left.displayName.localeCompare(right.displayName));
    return [{ provider, skills }];
  });
}

export function summarizeExternalSkills(groups: ReadonlyArray<ExternalSkillProviderGroup>): string {
  const skillCount = groups.reduce((total, group) => total + group.skills.length, 0);
  if (groups.length === 0) return "No connected provider inventories";
  const providerLabel = groups.length === 1 ? "provider" : "providers";
  const skillLabel = skillCount === 1 ? "skill" : "skills";
  return `${skillCount} ${skillLabel} across ${groups.length} ${providerLabel}`;
}
