import type { T3McpToolDefinition } from "./t3McpToolPresentation.ts";

/** Summary groups for Scient's own tools in a collapsed work log. */
export type ScientMcpToolSummaryAction =
  | "scient-skills"
  | "scient-sources"
  | "scient-documents"
  | "scient-compute";

function tool(
  labels: T3McpToolDefinition["labels"],
  summaryAction: ScientMcpToolSummaryAction,
): T3McpToolDefinition {
  return { displayName: `${labels[0]} ${labels[3]}`, labels, icon: "scient", summaryAction };
}

/**
 * Work-log names for Scient's own tools. Every agent reaches them through
 * Scient's MCP server, so one table names them for every provider. Keys use
 * the shared resolver's canonical `t3_` prefix; agents call them `scient_*`.
 */
export const SCIENT_MCP_TOOLS: Readonly<Record<string, T3McpToolDefinition>> = {
  t3_skills_list: tool(["Check", "Checking", "Checked", "available skills"], "scient-skills"),
  // A completed load reads "Used Latex Authoring", the wording skill loads already use.
  t3_skill_load: tool(["Load", "Loading", "Used", "a skill"], "scient-skills"),
  t3_skill_read_resource: tool(["Read", "Reading", "Read", "a skill file"], "scient-skills"),
  t3_sources_list: tool(["List", "Listing", "Listed", "sources"], "scient-sources"),
  t3_sources_get: tool(["Read", "Reading", "Read", "a source"], "scient-sources"),
  t3_sources_add: tool(["Add", "Adding", "Added", "a source"], "scient-sources"),
  t3_sources_update: tool(["Update", "Updating", "Updated", "a source"], "scient-sources"),
  t3_sources_note_update: tool(
    ["Update", "Updating", "Updated", "a source note"],
    "scient-sources",
  ),
  t3_sources_remove: tool(["Remove", "Removing", "Removed", "a source"], "scient-sources"),
  t3_sources_review: tool(["Review", "Reviewing", "Reviewed", "a source"], "scient-sources"),
  t3_sources_attach_pdf: tool(
    ["Attach", "Attaching", "Attached", "a PDF to a source"],
    "scient-sources",
  ),
  t3_sources_detach_pdf: tool(
    ["Detach", "Detaching", "Detached", "a PDF from a source"],
    "scient-sources",
  ),
  t3_pdf_build: tool(["Build", "Building", "Built", "a PDF"], "scient-documents"),
  t3_latex_build: tool(["Build", "Building", "Built", "a LaTeX document"], "scient-documents"),
  t3_document_export: tool(["Export", "Exporting", "Exported", "a document"], "scient-documents"),
  t3_compute_inventory: tool(
    ["Check", "Checking", "Checked", "compute runtimes"],
    "scient-compute",
  ),
};

/** A skill's reader-facing name from a skill tool's input: `latex-authoring` → `Latex Authoring`. */
export function scientSkillDisplayName(input: Record<string, unknown> | null): string | null {
  const name = typeof input?.name === "string" ? input.name.trim() : "";
  const releaseKey = typeof input?.releaseKey === "string" ? input.releaseKey.trim() : "";
  const displayName = (name || releaseKey.split("@")[0]?.split(".").at(-1))
    ?.split("-")
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
  return displayName || null;
}

/** The named skill a skill tool acts on, when its input names one. */
export function scientMcpToolTarget(
  definition: T3McpToolDefinition,
  input: Record<string, unknown> | null,
): string | undefined {
  const isLoad = definition === SCIENT_MCP_TOOLS.t3_skill_load;
  if (!isLoad && definition !== SCIENT_MCP_TOOLS.t3_skill_read_resource) return undefined;
  const skill = scientSkillDisplayName(input);
  if (!skill) return undefined;
  return isLoad ? skill : `a file of ${skill}`;
}

/** Collapsed-group label for calls to one family of Scient's tools. */
export function scientMcpToolSummaryLabel(
  action: ScientMcpToolSummaryAction,
  phrase: (past: string, infinitive: string, object: string) => string,
  times: string,
): string {
  switch (action) {
    case "scient-skills":
      return phrase("Used", "use", `skills ${times}`);
    case "scient-sources":
      return phrase("Used", "use", `sources ${times}`);
    case "scient-documents":
      // One verb for PDF/LaTeX builds and exports alike.
      return phrase("Prepared", "prepare", `documents ${times}`);
    case "scient-compute":
      return phrase("Checked", "check", `compute runtimes ${times}`);
  }
}
