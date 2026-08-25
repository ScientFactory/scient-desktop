import type { ServerProviderSkill, ServerProviderSlashCommand } from "@t3tools/contracts";

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

export function getProviderSkillsForSlashMenu(
  skills: ReadonlyArray<ServerProviderSkill>,
  showSkillsInSlashMenu: boolean,
): ServerProviderSkill[] {
  return showSkillsInSlashMenu
    ? skills.filter((skill) => skill.enabled && isGlobalProviderSkill(skill))
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
