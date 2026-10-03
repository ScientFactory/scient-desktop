/**
 * Work-log names for Scient's own tools. Every agent reaches them through
 * Scient's MCP server, so one table names them for every provider.
 */
export const SCIENT_MCP_TOOL_LABELS: Record<
  string,
  readonly [action: string, running: string, completed: string, detail: string]
> = {
  scient_skills_list: ["Check", "Checking", "Checked", "available skills"],
  scient_skill_load: ["Load", "Loading", "Loaded", "a skill"],
  scient_skill_read_resource: ["Read", "Reading", "Read", "a skill file"],
  scient_sources_list: ["List", "Listing", "Listed", "sources"],
  scient_sources_get: ["Read", "Reading", "Read", "a source"],
  scient_sources_add: ["Add", "Adding", "Added", "a source"],
  scient_sources_update: ["Update", "Updating", "Updated", "a source"],
  scient_sources_note_update: ["Update", "Updating", "Updated", "a source note"],
  scient_sources_remove: ["Remove", "Removing", "Removed", "a source"],
  scient_sources_review: ["Review", "Reviewing", "Reviewed", "a source"],
  scient_sources_attach_pdf: ["Attach", "Attaching", "Attached", "a PDF to a source"],
  scient_sources_detach_pdf: ["Detach", "Detaching", "Detached", "a PDF from a source"],
  scient_pdf_build: ["Build", "Building", "Built", "a PDF"],
  scient_latex_build: ["Build", "Building", "Built", "a LaTeX document"],
  scient_document_export: ["Export", "Exporting", "Exported", "a document"],
  scient_compute_inventory: ["Check", "Checking", "Checked", "compute runtimes"],
};

/** The named skill a skill tool acts on, when its input names one. */
export function scientMcpToolTarget(
  name: string,
  input: Record<string, unknown> | null,
): string | undefined {
  if (name !== "scient_skill_load" && name !== "scient_skill_read_resource") return undefined;
  const skill = typeof input?.name === "string" ? input.name.trim() : "";
  if (!skill) return undefined;
  return name === "scient_skill_load" ? `skill ${skill}` : `a file of skill ${skill}`;
}
