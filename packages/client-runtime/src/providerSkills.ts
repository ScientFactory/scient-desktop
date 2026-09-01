import type {
  ProviderDriverKind,
  ScientSkillInventory,
  ServerProviderSkill,
  ServerProviderSlashCommand,
} from "@t3tools/contracts";

export type ProviderSkillSourceKind = "app" | "repo" | "project" | "personal" | "system" | "other";

function titleCaseWords(value: string): string {
  const words: string[] = [];
  for (const segment of value.split(/[\s:_-]+/)) {
    if (segment.length === 0) continue;
    words.push(segment.charAt(0).toUpperCase() + segment.slice(1));
  }
  return words.join(" ");
}

function normalizePathSeparators(pathValue: string): string {
  return pathValue.replaceAll("\\", "/");
}

export function formatProviderSkillDisplayName(
  skill: Pick<ServerProviderSkill, "name" | "displayName">,
): string {
  const displayName = skill.displayName?.trim();
  if (displayName) {
    return displayName;
  }
  return titleCaseWords(skill.name);
}

export function dedupeProviderSkillsByName(
  skills: ReadonlyArray<ServerProviderSkill>,
): ServerProviderSkill[] {
  const seenNames = new Set<string>();
  return skills.filter((skill) => {
    const normalizedName = skill.name.trim().toLowerCase();
    if (seenNames.has(normalizedName)) {
      return false;
    }
    seenNames.add(normalizedName);
    return true;
  });
}

export function getProviderSkillsForSlashMenu(
  skills: ReadonlyArray<ServerProviderSkill>,
  showSkillsInSlashMenu: boolean,
): ServerProviderSkill[] {
  return showSkillsInSlashMenu
    ? dedupeProviderSkillsByName(
        skills.filter(
          (skill) =>
            skill.enabled &&
            (isGlobalProviderSkill(skill) || skill.path.startsWith(SCIENT_SKILL_PATH_PREFIX)),
        ),
      )
    : [];
}

export function getProviderSlashCommandsForSlashMenu(
  slashCommands: ReadonlyArray<ServerProviderSlashCommand>,
  visibleSkills: ReadonlyArray<ServerProviderSkill>,
): ServerProviderSlashCommand[] {
  const skillNames = new Set(visibleSkills.map((skill) => skill.name.trim().toLowerCase()));
  return slashCommands.filter((command) => !skillNames.has(command.name.trim().toLowerCase()));
}

export function resolveProviderSkillSourceKind(
  skill: Pick<ServerProviderSkill, "path" | "scope">,
): ProviderSkillSourceKind {
  const normalizedPath = normalizePathSeparators(skill.path);
  const normalizedScope = skill.scope?.trim().toLowerCase();
  // A provider's explicit project scope is authoritative even when the path
  // resembles a plugin or personal root.
  if (normalizedScope === "repo" || normalizedScope === "repository") {
    return "repo";
  }
  if (
    normalizedScope === "project" ||
    normalizedScope === "workspace" ||
    normalizedScope === "local"
  ) {
    return "project";
  }
  // SCIENT-FORK: built-in Scient releases are app-owned, not provider or user files.
  if (normalizedPath.startsWith("scient://skills/")) {
    return "app";
  }
  if (normalizedPath.includes("/.codex/plugins/") || normalizedPath.includes("/.agents/plugins/")) {
    return "app";
  }
  switch (normalizedScope) {
    case "app":
    case "builtin":
    case "bundled":
      return "app";
    case "user":
    case "personal":
      return "personal";
    case "system":
    case "admin":
      return "system";
    case undefined:
    case "":
      return "other";
    default:
      return "other";
  }
}

export function isGlobalProviderSkill(skill: Pick<ServerProviderSkill, "path" | "scope">): boolean {
  const source = resolveProviderSkillSourceKind(skill);
  return source !== "repo" && source !== "project";
}

const SCIENT_SKILL_PATH_PREFIX = "scient://skills/";

/** Merge the contextual Scient inventory into one provider's composer menu. */
export function mergeEffectiveProviderSkills(input: {
  readonly provider: ProviderDriverKind;
  readonly providerSkills: ReadonlyArray<ServerProviderSkill>;
  readonly inventory: ScientSkillInventory | null;
}): ReadonlyArray<ServerProviderSkill> {
  const { inventory, provider, providerSkills } = input;
  const visibleProviderSkills = providerSkills.filter(isGlobalProviderSkill);
  if (!inventory?.supportedProviders.includes(provider)) return visibleProviderSkills;

  // Provider-native behavior remains authoritative. A Scient skill with the
  // same visible name is withheld so `$name` can never route ambiguously.
  const occupiedNames = new Set(
    visibleProviderSkills.map((skill) => skill.name.trim().toLowerCase()),
  );
  const scientSkills = inventory.skills
    .filter((skill) => skill.active && !occupiedNames.has(skill.name.trim().toLowerCase()))
    .map(
      (skill): ServerProviderSkill => ({
        name: skill.name,
        description: skill.description,
        shortDescription: skill.description,
        path: `${SCIENT_SKILL_PATH_PREFIX}${encodeURIComponent(skill.releaseKey)}`,
        scope: skill.scope === "project" ? "project" : "personal",
        enabled: true,
      }),
    )
    .sort((left, right) => left.name.localeCompare(right.name));
  return scientSkills.length === 0
    ? visibleProviderSkills
    : [...visibleProviderSkills, ...scientSkills];
}
