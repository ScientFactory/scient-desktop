import type {
  ProviderDriverKind,
  ScientSkillInventory,
  ServerProviderSkill,
} from "@t3tools/contracts";

const SCIENT_SKILL_PATH_PREFIX = "scient://skills/";

export function mergeEffectiveProviderSkills(input: {
  readonly provider: ProviderDriverKind;
  readonly providerSkills: ReadonlyArray<ServerProviderSkill>;
  readonly inventory: ScientSkillInventory | null;
}): ReadonlyArray<ServerProviderSkill> {
  const { inventory, provider, providerSkills } = input;
  if (!inventory?.supportedProviders.includes(provider)) return providerSkills;

  // Provider-native behavior remains authoritative. A Scient skill with the
  // same visible name is withheld so `$name` can never route ambiguously.
  const occupiedNames = new Set(providerSkills.map((skill) => skill.name.trim().toLowerCase()));
  const scientSkills = inventory.skills
    .filter((skill) => skill.active && !occupiedNames.has(skill.name.trim().toLowerCase()))
    .map(
      (skill): ServerProviderSkill => ({
        name: skill.name,
        description: skill.description,
        shortDescription: skill.description,
        path: `${SCIENT_SKILL_PATH_PREFIX}${encodeURIComponent(skill.releaseKey)}`,
        scope: "personal",
        enabled: true,
      }),
    )
    .sort((left, right) => left.name.localeCompare(right.name));
  return scientSkills.length === 0 ? providerSkills : [...providerSkills, ...scientSkills];
}
