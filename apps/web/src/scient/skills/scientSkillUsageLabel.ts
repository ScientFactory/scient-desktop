import { scientSkillDisplayName } from "@t3tools/shared/scientMcpToolPresentation";
import { resolveT3McpToolName } from "@t3tools/shared/t3McpToolPresentation";

const scientSkillLoadToolNames: ReadonlySet<string> = new Set(["scient_skill_load"]);

export function scientSkillUsageLabel(itemValue: unknown): string | null {
  const item = asRecord(itemValue);
  const tool = asTrimmedString(item?.tool);
  if (!tool || resolveT3McpToolName(tool, scientSkillLoadToolNames) !== "scient_skill_load") {
    return null;
  }
  const displayName = scientSkillDisplayName(asRecord(item?.arguments));
  if (!displayName) return null;
  switch (asTrimmedString(item?.status)) {
    case "completed":
      return `Used ${displayName}`;
    case "failed":
      return `Couldn't load ${displayName}`;
    case "declined":
    case "stopped":
    case "cancelled":
    case "interrupted":
      return `Didn't load ${displayName}`;
    default:
      return `Loading ${displayName}`;
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

function asTrimmedString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}
