import { describe, expect, it } from "vite-plus/test";

import { BUILT_IN_DRIVERS } from "./builtInDrivers.ts";
import {
  buildScientAwareness,
  buildScientPromptAwareness,
  SCIENT_BROWSER_AWARENESS,
  SCIENT_CORE_AWARENESS,
  SCIENT_COMPUTE_AWARENESS,
  SCIENT_DOCUMENT_BUILD_AWARENESS,
  SCIENT_OVERLEAF_AWARENESS,
  SCIENT_PAPERS_AWARENESS,
  SCIENT_SKILLS_AWARENESS,
} from "./ScientAwareness.ts";
import {
  SCIENT_DEVICE_TOOL_INSTRUCTIONS,
  SCIENT_DEVICE_TOOL_INSTRUCTIONS_WITH_TOOL_SEARCH,
} from "./ScientProviderInstructions.ts";
import { CLAUDE_SCIENT_TOOL_PROJECTION } from "./ScientToolProjection.ts";

/**
 * How each built-in provider receives Scient's awareness. Adding a provider
 * fails the coverage test until its delivery is decided here.
 */
const SCIENT_AWARENESS_DELIVERY = {
  acpRegistry: "first-prompt",
  antigravity: "first-prompt",
  claudeAgent: "system-preset-append",
  codex: "developer-instructions",
  cursor: "first-prompt",
  droid: "system-prompt-append",
  fx: "first-prompt",
  grok: "rules-append",
  kiro: "first-prompt",
  // Muse has no system seam: the first turn carries it, and a changed one again.
  muse: "first-turn-and-on-change",
  opencode: "managed-server-per-message-system",
  omp: "before-agent-start-system-append",
  pi: "before-agent-start-system-append",
  scient: "before-agent-start-system-append",
} as const;

const wordCount = (value: string): number => value.trim().split(/\s+/u).length;

describe("Scient awareness", () => {
  it("composes device and read-only compute awareness without granting either implicitly", () => {
    const combined = buildScientAwareness(new Set(["compute", "device"]));
    expect(combined).toContain(SCIENT_COMPUTE_AWARENESS);
    expect(combined).toContain("## Scient devices");
    expect(buildScientAwareness(new Set(["device"]))).not.toContain(SCIENT_COMPUTE_AWARENESS);
    expect(buildScientAwareness(new Set(["compute"]))).not.toContain("## Scient devices");
  });

  it("keeps the always-on identity compact and free of tool-specific guidance", () => {
    expect(wordCount(SCIENT_CORE_AWARENESS)).toBeLessThanOrEqual(135);
    // Link spelling comes from upstream's runtime instructions alone.
    expect(SCIENT_CORE_AWARENESS).not.toMatch(/relative|absolute/u);
    expect(SCIENT_CORE_AWARENESS).not.toContain("sources_");
  });

  it("mentions Scient skills only when exact skill access is granted", () => {
    expect(wordCount(SCIENT_SKILLS_AWARENESS)).toBeLessThanOrEqual(80);
    expect(SCIENT_SKILLS_AWARENESS).toContain("`scient_skills_list`");
    expect(SCIENT_SKILLS_AWARENESS).toContain("`scient_skill_load`");
    expect(buildScientAwareness(new Set(["skills:read"]))).toBe(
      `${SCIENT_CORE_AWARENESS}\n\n${SCIENT_SKILLS_AWARENESS}`,
    );
    expect(buildScientAwareness(new Set(["preview", "skills:read"]))).toBe(
      `${SCIENT_CORE_AWARENESS}\n\n${SCIENT_BROWSER_AWARENESS}\n\n${SCIENT_SKILLS_AWARENESS}`,
    );
  });

  it("reuses upstream's browser rules only for an actually granted preview capability", () => {
    expect(SCIENT_BROWSER_AWARENESS).toMatch(/^## Scient browser\n/u);
    expect(SCIENT_BROWSER_AWARENESS).toContain("Prefer snapshot locators over coordinates.");
    expect(SCIENT_BROWSER_AWARENESS).toContain("two preview calls fail on one step");
    expect(buildScientAwareness()).toBe(SCIENT_CORE_AWARENESS);
    expect(buildScientAwareness(new Set(["sources:read"]))).toBe(SCIENT_CORE_AWARENESS);
    expect(buildScientAwareness(new Set(["preview"]))).toBe(
      `${SCIENT_CORE_AWARENESS}\n\n${SCIENT_BROWSER_AWARENESS}`,
    );
  });

  it("sends papers first to the paper tool, and the sign-in note only with the browser", () => {
    expect(wordCount(SCIENT_PAPERS_AWARENESS)).toBeLessThanOrEqual(70);
    expect(SCIENT_PAPERS_AWARENESS).toContain("`scient_paper_get` first");
    expect(SCIENT_PAPERS_AWARENESS).toContain("`scient_papers_queue`");
    expect(buildScientAwareness(new Set(["preview", "accounts"]))).toContain(
      "`preview_open` signs in by itself",
    );
    const withoutBrowser = buildScientAwareness(new Set(["accounts"]));
    expect(withoutBrowser).toContain("`scient_paper_get` first");
    expect(withoutBrowser).not.toContain("preview_open");
    expect(buildScientAwareness(new Set(["preview"]))).not.toContain("scient_paper_get");
  });

  it("recommends Compute runs only with compute authority", () => {
    expect(wordCount(SCIENT_COMPUTE_AWARENESS)).toBeLessThanOrEqual(50);
    expect(SCIENT_COMPUTE_AWARENESS).toContain("`scient_compute_run`");
    expect(buildScientAwareness()).toBe(SCIENT_CORE_AWARENESS);
    expect(buildScientAwareness(new Set(["sources:read"]))).toBe(SCIENT_CORE_AWARENESS);
    expect(buildScientAwareness(new Set(["compute"]))).toBe(
      `${SCIENT_CORE_AWARENESS}\n\n${SCIENT_COMPUTE_AWARENESS}`,
    );
  });
  it("projects the Compute tool names for Claude's MCP namespace", () => {
    const awareness = buildScientAwareness(new Set(["compute"]), CLAUDE_SCIENT_TOOL_PROJECTION);

    expect(awareness).toContain("`mcp__scient__scient_compute_run`");
    expect(awareness).not.toContain("`scient_compute_run`");
  });

  it("adds compact, truthful PDF build guidance only with document authority", () => {
    expect(wordCount(SCIENT_DOCUMENT_BUILD_AWARENESS)).toBeLessThanOrEqual(50);
    expect(SCIENT_DOCUMENT_BUILD_AWARENESS).toContain("`scient_pdf_build`");
    expect(SCIENT_DOCUMENT_BUILD_AWARENESS).toContain("`scient_latex_build`");
    expect(SCIENT_DOCUMENT_BUILD_AWARENESS).toContain("requested PDF deliverable");
    expect(SCIENT_DOCUMENT_BUILD_AWARENESS).toContain("existing project HTML source");
    expect(SCIENT_DOCUMENT_BUILD_AWARENESS).toContain("existing project LaTeX source");
    expect(SCIENT_DOCUMENT_BUILD_AWARENESS).toContain("`scient_document_export`");
    expect(SCIENT_DOCUMENT_BUILD_AWARENESS).toContain("existing project Markdown document");
    for (const skillWorkflowDetail of [
      "retryAfterMs",
      "pageCount",
      "sourcePath",
      "outputPath",
      "rootSourcePath",
      "visual review",
    ]) {
      expect(SCIENT_DOCUMENT_BUILD_AWARENESS).not.toContain(skillWorkflowDetail);
    }
    expect(buildScientAwareness(new Set(["documents:build"]))).toBe(
      `${SCIENT_CORE_AWARENESS}\n\n${SCIENT_DOCUMENT_BUILD_AWARENESS}\n\n${SCIENT_OVERLEAF_AWARENESS}`,
    );
  });

  it("points agents at the Overleaf tools and skill with document authority, adding no gate", () => {
    expect(wordCount(SCIENT_OVERLEAF_AWARENESS)).toBeLessThanOrEqual(60);
    expect(buildScientAwareness(new Set(["sources:read"]))).not.toContain("Overleaf");
    expect(
      buildScientAwareness(new Set(["documents:build"]), CLAUDE_SCIENT_TOOL_PROJECTION),
    ).toContain("`mcp__scient__scient_overleaf_status`");
  });

  it("projects exact provider tool names without changing capability gating", () => {
    const awareness = buildScientAwareness(
      new Set(["documents:build", "skills:read", "preview"]),
      CLAUDE_SCIENT_TOOL_PROJECTION,
    );

    expect(awareness).toContain("`mcp__scient__scient_pdf_build`");
    expect(awareness).toContain("`mcp__scient__scient_latex_build`");
    expect(awareness).toContain("`mcp__scient__scient_document_export`");
    expect(awareness).toContain("`mcp__scient__preview_status`");
    expect(awareness).toContain("`mcp__scient__preview_open`");
    expect(awareness).not.toContain("`preview_status`");
    expect(awareness).toContain("`mcp__scient__preview_*`");
    expect(awareness).not.toContain("use `scient_pdf_build`");
    expect(awareness).toContain("`mcp__scient__scient_skills_list`");
    expect(awareness).toContain("`mcp__scient__scient_skill_load`");
    expect(awareness).not.toContain("`scient_skills_list`");
    expect(buildScientAwareness(new Set(), CLAUDE_SCIENT_TOOL_PROJECTION)).toBe(
      SCIENT_CORE_AWARENESS,
    );
  });

  it("tells Claude to load deferred tools, including the device tools, through ToolSearch", () => {
    const claude = buildScientAwareness(
      new Set(["compute", "device", "documents:build", "skills:read", "accounts"]),
      CLAUDE_SCIENT_TOOL_PROJECTION,
    );
    expect(claude).toContain(SCIENT_DEVICE_TOOL_INSTRUCTIONS_WITH_TOOL_SEARCH);
    expect(claude).toContain("`select:mcp__scient__device_list,");
    expect(claude.match(/through `ToolSearch` first/gu)).toHaveLength(5);
    const canonical = buildScientAwareness(new Set(["device"]));
    expect(canonical).toContain(SCIENT_DEVICE_TOOL_INSTRUCTIONS);
    expect(canonical).not.toContain("ToolSearch");
  });

  it("leaves the device text to upstream's own prompt delivery for prompt-only providers", () => {
    const prompt = buildScientPromptAwareness(new Set(["device", "preview", "not-a-grant"]));
    expect(prompt).toBe(buildScientAwareness(new Set(["preview"])));
  });

  it("requires an explicit delivery decision for every built-in provider", () => {
    const builtInKinds = BUILT_IN_DRIVERS.map((driver) => String(driver.driverKind)).toSorted();
    expect(Object.keys(SCIENT_AWARENESS_DELIVERY).toSorted()).toEqual(builtInKinds);
    // Oh My Pi uses Pi's session-local extension hook, appended to its string[] prompt.
    expect(SCIENT_AWARENESS_DELIVERY.omp).toBe(SCIENT_AWARENESS_DELIVERY.pi);
  });
});
