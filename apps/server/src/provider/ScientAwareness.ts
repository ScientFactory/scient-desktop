import { T3_CODE_BROWSER_TOOL_INSTRUCTIONS } from "@t3tools/provider-core/server/orchestrationInstructions";

import { toMcpCapabilities, type McpCapability } from "../mcp/McpInvocationContext.ts";
import { scientAgentCopy } from "./ScientAgentCopy.ts";
import {
  SCIENT_DEVICE_TOOL_INSTRUCTIONS,
  SCIENT_DEVICE_TOOL_INSTRUCTIONS_WITH_TOOL_SEARCH,
} from "./ScientProviderInstructions.ts";
import {
  CANONICAL_SCIENT_TOOL_PROJECTION,
  type ScientToolProjection,
} from "./ScientToolProjection.ts";

/** Always-on product identity and presentation capabilities. */
export const SCIENT_CORE_AWARENESS = `## Scient
You are in Scient, a project workspace for code and science. The user reads your replies in Scient's Markdown chat and can edit project files.

Replies render LaTeX math, Markdown images, and fenced \`mermaid\`, \`vega-lite\` (JSON) and \`plotly\` (self-contained figure JSON) blocks. Put a chart or diagram that fits one in your reply as that block, and explain it nearby. Show a visual without being asked when it says more than prose. Start Mermaid with its diagram type. Do not wrap them in HTML or JavaScript or embed base64 images.

Put standalone deliverables in project files and link them instead of preview URLs. Linked \`.tex\` files open in Scient's LaTeX editor and \`.html\` files in its browser.`;

/** Upstream's browser rules in Scient's copy, with each tool named as this provider sees it. */
const buildScientBrowserAwareness = (tools: ScientToolProjection): string =>
  scientAgentCopy(T3_CODE_BROWSER_TOOL_INSTRUCTIONS)
    .trim()
    .replaceAll(
      /`(preview_[\w*]+)`/g,
      (_match, name: `preview_${string}`) => `\`${tools.name(name)}\``,
    );

export const SCIENT_BROWSER_AWARENESS = buildScientBrowserAwareness(
  CANONICAL_SCIENT_TOOL_PROJECTION,
);

/** Included only when the session may build project documents. */
const buildScientDocumentAwareness = (tools: ScientToolProjection): string => `## Scient PDF builds
For a requested PDF deliverable, use \`${tools.name("scient_pdf_build")}\` to build an existing project HTML source, \`${tools.name("scient_latex_build")}\` to build an existing project LaTeX source, and \`${tools.name("scient_document_export")}\` to export an existing project Markdown document.${tools.deferred ? ` If any is deferred, load its exact name through \`ToolSearch\` first.` : ""}`;

export const SCIENT_DOCUMENT_BUILD_AWARENESS = buildScientDocumentAwareness(
  CANONICAL_SCIENT_TOOL_PROJECTION,
);

/** Included with document authority: the Overleaf tools need no grant of their own. */
const buildScientOverleafAwareness = (tools: ScientToolProjection): string => `## Scient Overleaf
A project folder can be linked to one Overleaf project and synced both ways on request. For Overleaf work, use the Overleaf tools, starting with \`${tools.name("scient_overleaf_status")}\`, and follow the \`overleaf-sync\` skill. The tools need no approval: do what the user asked. Settle reported conflicts; report other problems.${tools.deferred ? " If they are deferred, load their exact names through `ToolSearch` first." : ""}`;

export const SCIENT_OVERLEAF_AWARENESS = buildScientOverleafAwareness(
  CANONICAL_SCIENT_TOOL_PROJECTION,
);

/** Included when this provider can receive turn-scoped Scient skills. */
const buildScientSkillsAwareness = (tools: ScientToolProjection): string => `## Scient skills
Scient skills are instructions the user manages in Scient, separate from your provider's own skills. On a substantive task, follow this turn's Scient skill scope note; without one, call \`${tools.name("scient_skills_list")}\`. Load a skill with \`${tools.name("scient_skill_load")}\` before you follow it; load one the user selected directly. Save a skill the user keeps with \`${tools.name("scient_skill_save")}\`, not in your provider's own skills folder.${tools.deferred ? " If these tools are deferred, find their exact names through `ToolSearch` first." : ""} Skills give guidance only and grant no tools or permissions.`;

export const SCIENT_SKILLS_AWARENESS = buildScientSkillsAwareness(CANONICAL_SCIENT_TOOL_PROJECTION);

const buildScientComputeAwareness = (tools: ScientToolProjection): string => `## Scient Compute
Run data analysis and figures with \`${tools.name("scient_compute_run")}\`, not a shell interpreter: the user sees each run and variables persist. \`${tools.name("scient_compute_sessions")}\` finds the user's sessions, such as an open file. \`${tools.name("scient_compute_inventory")}\` shows what is installed for any language. For \`.ipynb\` files use \`${tools.name("scient_notebook_read")}\`, \`${tools.name("scient_notebook_edit")}\` and \`${tools.name("scient_notebook_run")}\`.${tools.deferred ? " If deferred, load these tools through `ToolSearch` first." : ""}`;

export const SCIENT_COMPUTE_AWARENESS = buildScientComputeAwareness(
  CANONICAL_SCIENT_TOOL_PROJECTION,
);

/** The sign-in sentence needs the browser grant as well as Accounts. */
const buildScientPapersAwareness = (tools: ScientToolProjection, browser: boolean): string =>
  `## Scient papers
To fetch a paper, call \`${tools.name("scient_paper_get")}\` first with its DOI or link (for a title, find one): it uses the user's free legal copies and university access. For more than a few papers, use \`${tools.name("scient_papers_queue")}\`.${browser ? ` \`${tools.name("preview_open")}\` signs in by itself on sites with a saved sign-in; its \`accountsNote\` says what to do when it could not.` : ""}${tools.deferred ? " If deferred, load these tools through `ToolSearch` first." : ""}`;

export const SCIENT_PAPERS_AWARENESS = buildScientPapersAwareness(
  CANONICAL_SCIENT_TOOL_PROJECTION,
  true,
);

/** Included with Library access, so literature work starts in the Library rather than on the web. */
const buildScientLibraryAwareness = (tools: ScientToolProjection): string => `## Scient Library
Start literature or citation work in the project's Library, before web search: \`${tools.name("scient_sources_list")}\` (\`total\` is its size), \`${tools.name("scient_sources_search")}\` (PDF text), \`${tools.name("scient_sources_add")}\` by DOI, PMID, arXiv ID or ISBN (\`identifierList\` for several). Cite with keys from the \`references.bib\` that \`${tools.name("scient_sources_bibliography")}\` manages.${tools.deferred ? " If deferred, load these tools through `ToolSearch` first." : ""}`;

export const SCIENT_LIBRARY_AWARENESS = buildScientLibraryAwareness(
  CANONICAL_SCIENT_TOOL_PROJECTION,
);

/**
 * Compose only the blocks whose tools this session's list can show. The
 * capabilities are the session's provider-facing manifest, which omits project
 * grants when the thread has no verified workspace.
 */
export function buildScientAwareness(
  capabilities?: ReadonlySet<McpCapability>,
  tools: ScientToolProjection = CANONICAL_SCIENT_TOOL_PROJECTION,
): string {
  const has = (capability: McpCapability) => capabilities?.has(capability) === true;
  return [
    SCIENT_CORE_AWARENESS,
    ...(has("preview") ? [buildScientBrowserAwareness(tools)] : []),
    ...(has("compute") ? [buildScientComputeAwareness(tools)] : []),
    ...(has("device")
      ? [
          tools.deferred
            ? SCIENT_DEVICE_TOOL_INSTRUCTIONS_WITH_TOOL_SEARCH
            : SCIENT_DEVICE_TOOL_INSTRUCTIONS,
        ]
      : []),
    ...(has("documents:build")
      ? [buildScientDocumentAwareness(tools), buildScientOverleafAwareness(tools)]
      : []),
    ...(has("skills:read") ? [buildScientSkillsAwareness(tools)] : []),
    ...(has("sources:read") ? [buildScientLibraryAwareness(tools)] : []),
    ...(has("accounts") ? [buildScientPapersAwareness(tools, has("preview"))] : []),
  ].join("\n\n");
}

/**
 * For providers whose only Scient channel is the prompt, where upstream's own
 * prompt path already delivers the device text.
 */
export const buildScientPromptAwareness = (capabilities: ReadonlySet<string>): string =>
  buildScientAwareness(
    new Set([...toMcpCapabilities(capabilities)].filter((capability) => capability !== "device")),
  );

/** Grants whose blocks name project tools, which discovery lists only with a verified workspace. */
const PROJECT_AWARENESS_GRANTS: ReadonlySet<string> = new Set<McpCapability>([
  "compute",
  "documents:build",
  "sources:read",
]);

/**
 * The provider-facing manifest that awareness reads: the session's grants, less
 * those whose blocks would name tools the list hides. Call-time checks still use
 * the grants themselves.
 */
export const scientAwarenessManifest = (
  capabilities: ReadonlySet<string>,
  workspaceVerified: boolean,
): ReadonlySet<string> =>
  workspaceVerified
    ? capabilities
    : new Set([...capabilities].filter((capability) => !PROJECT_AWARENESS_GRANTS.has(capability)));
