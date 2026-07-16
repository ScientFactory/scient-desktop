import {
  ProjectInitializationError,
  type NormalizedInitializationRequest,
  type ProjectProfileDescriptor,
} from "./types.ts";

export const PAPILAB_MANAGED_START = "<!-- papilab-managed:start template=1 -->";
export const PAPILAB_MANAGED_END = "<!-- papilab-managed:end -->";

const UNDECIDED = "Undecided";

function valueOrUndecided(value: string | null): string {
  return value ?? UNDECIDED;
}

export function renderProjectMarkdown(
  request: NormalizedInitializationRequest,
  profiles: readonly ProjectProfileDescriptor[],
): string {
  const sections = [
    `# ${request.title ?? "Untitled PapiLab Project"}`,
    "",
    "## Purpose",
    "",
    valueOrUndecided(request.purpose),
    "",
    "## Main Question Or Objective",
    "",
    valueOrUndecided(request.question),
    "",
    "## Project Type And Workflow",
    "",
    request.profileIds.length > 0 ? request.profileIds.join(", ") : UNDECIDED,
    "",
    "## Scope",
    "",
    "### Included",
    "",
    valueOrUndecided(request.scopeIncluded),
    "",
    "### Excluded",
    "",
    valueOrUndecided(request.scopeExcluded),
    "",
    "## Starting Materials",
    "",
    UNDECIDED,
    "",
    "## Intended Outputs",
    "",
    UNDECIDED,
    "",
    "## Constraints And Sensitivities",
    "",
    UNDECIDED,
    "",
    "## Terminology",
    "",
    UNDECIDED,
    "",
    "## Important Decisions",
    "",
    UNDECIDED,
    "",
    "## Open Questions",
    "",
    UNDECIDED,
    "",
    "## Current Status",
    "",
    UNDECIDED,
  ];

  for (const profile of profiles) {
    for (const section of profile.projectSections ?? []) {
      sections.push("", `## ${section.heading.trim()}`, "", section.prompt?.trim() || UNDECIDED);
    }
  }
  return `${sections.join("\n")}\n`;
}

export function renderManagedAgentsBlock(profiles: readonly ProjectProfileDescriptor[]): string {
  const lines = [
    PAPILAB_MANAGED_START,
    "",
    "## PapiLab Baseline",
    "",
    "- Read `PROJECT.md` before acting and keep work within the stated project scope.",
    "- Use only the project material and paths granted for the current task.",
    "- Never modify `.papilab/` directly.",
    "- Preserve provenance and never invent citations, data, observations, or results.",
    "- Distinguish evidence, inference, proposals, and accepted project state.",
    "- Keep scientific changes reviewable and prefer reversible operations.",
    "- Preserve uncertainty and leave durable work understandable without this conversation.",
  ];
  const instructions = profiles.flatMap((profile) => profile.managedAgentInstructions ?? []);
  if (instructions.length > 0) {
    lines.push("", "## Starter Profile Guidance", "");
    for (const instruction of instructions) {
      lines.push(`- ${instruction.trim()}`);
    }
  }
  lines.push("", PAPILAB_MANAGED_END);
  return lines.join("\n");
}

export function renderAgentsMarkdown(profiles: readonly ProjectProfileDescriptor[]): string {
  return [
    "# Project Agent Instructions",
    "",
    renderManagedAgentsBlock(profiles),
    "",
    "## Project-Specific Instructions",
    "",
    "Add project-specific preferences and instructions here.",
    "",
  ].join("\n");
}

export function proposeManagedAgentsContents(
  existingContents: string,
  profiles: readonly ProjectProfileDescriptor[],
): string {
  const newline = existingContents.includes("\r\n") ? "\r\n" : "\n";
  const startIndex = existingContents.indexOf(PAPILAB_MANAGED_START);
  const endIndex = existingContents.indexOf(PAPILAB_MANAGED_END);
  const hasStart = startIndex >= 0;
  const hasEnd = endIndex >= 0;
  if (hasStart !== hasEnd || (hasStart && endIndex < startIndex)) {
    throw new ProjectInitializationError(
      "INVALID_PLAN",
      "Existing AGENTS.md contains an incomplete PapiLab-managed section.",
    );
  }
  if (
    hasStart &&
    (existingContents.indexOf(PAPILAB_MANAGED_START, startIndex + PAPILAB_MANAGED_START.length) >=
      0 ||
      existingContents.indexOf(PAPILAB_MANAGED_END, endIndex + PAPILAB_MANAGED_END.length) >= 0)
  ) {
    throw new ProjectInitializationError(
      "INVALID_PLAN",
      "Existing AGENTS.md contains multiple PapiLab-managed sections.",
    );
  }

  const managedBlock = renderManagedAgentsBlock(profiles).replaceAll("\n", newline);
  if (!hasStart) {
    const prefix = existingContents.trimEnd();
    return `${prefix}${prefix.length > 0 ? `${newline}${newline}` : ""}${managedBlock}${newline}`;
  }
  const afterEnd = endIndex + PAPILAB_MANAGED_END.length;
  return `${existingContents.slice(0, startIndex)}${managedBlock}${existingContents.slice(afterEnd)}`;
}
