import { formatProviderSkillDisplayName } from "@t3tools/shared/inlineSkills";
import { msg } from "gt-react";
import {
  isGlobalProviderSkill,
  isScientManagedSkill,
  resolveProviderSkillSourceKind,
  type ProviderSkillSourceKind,
} from "@t3tools/client-runtime/providerSkills";
import {
  isProviderAvailable,
  type ServerProvider,
  type ServerProviderSkill,
} from "@t3tools/contracts";

import { m, type MessageResolver } from "~/i18n/messages";

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

export const externalSkillSourceLabel = (
  source: ProviderSkillSourceKind,
  resolve: MessageResolver = m,
): string => {
  switch (source) {
    case "app":
      return resolve(msg("Provider bundled"));
    case "personal":
      return resolve(msg("Personal", { $context: "skill source" }));
    case "system":
      return resolve(msg("System", { $context: "skill source" }));
    case "other":
      return resolve(msg("Provider managed"));
    case "repo":
    case "project":
      return resolve(msg("Project", { $context: "skill source" }));
  }
};

export function externalSkillStatus(
  skill: Pick<ServerProviderSkill, "canSetEnabled" | "enabled" | "enabledReadOnlyReason">,
  source: ProviderSkillSourceKind,
  resolve: MessageResolver = m,
): string {
  return [
    externalSkillSourceLabel(source, resolve),
    ...(skill.enabled ? [] : [resolve(msg("Deactivated"))]),
    ...(skill.canSetEnabled === true
      ? []
      : [skill.enabledReadOnlyReason ?? resolve(msg("Read-only in Scient"))]),
  ].join(" · ");
}

export function collectExternalSkillProviders(
  providers: ReadonlyArray<ServerProvider>,
): ReadonlyArray<ExternalSkillProviderGroup> {
  return providers.flatMap((provider) => {
    if (!provider.enabled || !provider.installed || !isProviderAvailable(provider)) return [];
    const skills = provider.skills
      .filter((skill) => isGlobalProviderSkill(skill) && !isScientManagedSkill(skill))
      .map((skill): ExternalSkillItem => ({
        skill,
        displayName: formatProviderSkillDisplayName(skill),
        description: compactExternalSkillDescription(skill.shortDescription ?? skill.description),
        source: resolveProviderSkillSourceKind(skill),
      }))
      .toSorted((left, right) => left.displayName.localeCompare(right.displayName));
    return [{ provider, skills }];
  });
}
