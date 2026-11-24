import { describe, expect, it } from "vite-plus/test";

import { toMcpCapabilities } from "../mcp/McpInvocationContext.ts";
import { BUILT_IN_DRIVERS } from "./builtInDrivers.ts";
import {
  buildScientAwareness,
  buildScientPromptAwareness,
  scientAwarenessManifest,
  SCIENT_CORE_AWARENESS,
} from "./ScientAwareness.ts";
import {
  SCIENT_DEVICE_TOOL_INSTRUCTIONS,
  SCIENT_DEVICE_TOOL_INSTRUCTIONS_WITH_TOOL_SEARCH,
} from "./ScientProviderInstructions.ts";
import {
  CANONICAL_SCIENT_TOOL_PROJECTION,
  CLAUDE_SCIENT_TOOL_PROJECTION,
  type ScientToolProjection,
} from "./ScientToolProjection.ts";

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

/** The blocks a session with these grants is sent, core first, each starting with its heading. */
const blocksFor = (
  capabilities: Iterable<string>,
  tools: ScientToolProjection = CANONICAL_SCIENT_TOOL_PROJECTION,
): ReadonlyArray<string> => {
  const granted = new Set(capabilities);
  const known = toMcpCapabilities(granted);
  expect(known.size, "every capability is a real grant").toBe(granted.size);
  return buildScientAwareness(known, tools).split(/\n\n(?=## )/u);
};

const headingsFor = (capabilities: Iterable<string>) =>
  blocksFor(capabilities).map((block) => block.slice(0, block.indexOf("\n")));

/** The one block under `heading` for these grants. */
const blockFor = (
  capabilities: Iterable<string>,
  heading: string,
  tools: ScientToolProjection = CANONICAL_SCIENT_TOOL_PROJECTION,
): string => {
  const found = blocksFor(capabilities, tools).filter((block) => block.startsWith(`${heading}\n`));
  expect(found, heading).toHaveLength(1);
  return found[0]!;
};

describe("Scient awareness", () => {
  it.each([
    [[], []],
    [["threads:read"], []],
    [["preview"], ["## Scient browser"]],
    [["compute"], ["## Scient Compute"]],
    [["device"], ["## Scient devices"]],
    [
      ["compute", "device"],
      ["## Scient Compute", "## Scient devices"],
    ],
    [["documents:build"], ["## Scient PDF builds", "## Scient Overleaf"]],
    [["skills:read"], ["## Scient skills"]],
    [
      ["preview", "skills:read"],
      ["## Scient browser", "## Scient skills"],
    ],
    [["sources:read"], ["## Scient Library"]],
    [["accounts"], ["## Scient papers", "## Scient connectors"]],
  ])("with %j sends only the core and %j", (capabilities, headings) => {
    expect(headingsFor(capabilities)).toEqual(["## Scient", ...headings]);
    expect(blocksFor(capabilities)[0]).toBe(SCIENT_CORE_AWARENESS);
  });

  it("sends only the core without a capability set", () => {
    expect(buildScientAwareness()).toBe(SCIENT_CORE_AWARENESS);
  });

  it("keeps the always-on identity compact and free of tool-specific guidance", () => {
    expect(wordCount(SCIENT_CORE_AWARENESS)).toBeLessThanOrEqual(135);
    // Link spelling comes from upstream's runtime instructions alone.
    expect(SCIENT_CORE_AWARENESS).not.toMatch(/relative|absolute/u);
    expect(SCIENT_CORE_AWARENESS).not.toContain("sources_");
  });

  it("points skill work at the Scient skill tools", () => {
    const skills = blockFor(["skills:read"], "## Scient skills");
    expect(wordCount(skills)).toBeLessThanOrEqual(80);
    expect(skills).toContain("`scient_skills_list`");
    expect(skills).toContain("`scient_skill_load`");
  });

  it("reuses upstream's browser rules under Scient's heading", () => {
    const browser = blockFor(["preview"], "## Scient browser");
    expect(browser).toContain("Prefer snapshot locators over coordinates.");
    expect(browser).toContain("two preview calls fail on one step");
  });

  it("sends papers first to the paper tool, and the sign-in note only with the browser", () => {
    const withBrowser = blockFor(["preview", "accounts"], "## Scient papers");
    expect(wordCount(withBrowser)).toBeLessThanOrEqual(70);
    expect(withBrowser).toContain("`scient_paper_get` first");
    expect(withBrowser).toContain("`scient_papers_queue`");
    expect(withBrowser).toContain("`preview_open` signs in by itself");
    const withoutBrowser = blockFor(["accounts"], "## Scient papers");
    expect(withoutBrowser).toContain("`scient_paper_get` first");
    expect(withoutBrowser).not.toContain("preview_open");
  });

  it("points literature work at the Library only with Library access in a verified project", () => {
    const library = blockFor(["sources:read"], "## Scient Library");
    expect(wordCount(library)).toBeLessThanOrEqual(95);
    expect(library).toContain("before web search");
    expect(library).toContain("`identifierList`");
    // Only a session that can load skills is sent to one.
    expect(library).not.toContain("skill");
    expect(blockFor(["skills:read", "sources:read"], "## Scient Library")).toContain(
      "load the `references` skill first",
    );
    const unverified = scientAwarenessManifest(new Set(["sources:read", "sources:write"]), false);
    expect(headingsFor(unverified)).toEqual(["## Scient"]);
  });

  it("recommends Compute runs", () => {
    const compute = blockFor(["compute"], "## Scient Compute");
    expect(wordCount(compute)).toBeLessThanOrEqual(50);
    expect(compute).toContain("saved project scripts with `scient_compute_run_file`");
    expect(compute).toContain("analysis snippets with `scient_compute_run`");
    expect(compute).toContain("never through the shell");
  });

  it("adds compact, truthful PDF build guidance", () => {
    const documents = blockFor(["documents:build"], "## Scient PDF builds");
    expect(wordCount(documents)).toBeLessThanOrEqual(50);
    expect(documents).toContain("`scient_pdf_build`");
    expect(documents).toContain("`scient_latex_build`");
    expect(documents).toContain("requested PDF deliverable");
    expect(documents).toContain("existing project HTML source");
    expect(documents).toContain("existing project LaTeX source");
    expect(documents).toContain("`scient_document_export`");
    expect(documents).toContain("existing project Markdown document");
    for (const skillWorkflowDetail of [
      "retryAfterMs",
      "pageCount",
      "sourcePath",
      "outputPath",
      "rootSourcePath",
      "visual review",
    ]) {
      expect(documents).not.toContain(skillWorkflowDetail);
    }
  });

  it("points agents at the Overleaf tools and skill with document authority, adding no gate", () => {
    const overleaf = blockFor(["documents:build"], "## Scient Overleaf");
    expect(wordCount(overleaf)).toBeLessThanOrEqual(60);
    expect(overleaf).toContain("`scient_overleaf_status`");
    expect(overleaf).toContain("`overleaf-sync` skill");
    expect(buildScientAwareness(new Set(["sources:read"]))).not.toContain("Overleaf");
  });

  it.each([
    [["compute"], "## Scient Compute", "`mcp__scient__scient_compute_run`"],
    [["documents:build"], "## Scient PDF builds", "`mcp__scient__scient_pdf_build`"],
    [["documents:build"], "## Scient Overleaf", "`mcp__scient__scient_overleaf_status`"],
    [["skills:read"], "## Scient skills", "`mcp__scient__scient_skills_list`"],
    [["sources:read"], "## Scient Library", "`mcp__scient__scient_sources_add`"],
    [["accounts"], "## Scient papers", "`mcp__scient__scient_paper_get`"],
  ])(
    "with %j, Claude's %s block names %s and loads it through ToolSearch",
    (capabilities, heading, tool) => {
      const claude = blockFor(capabilities, heading, CLAUDE_SCIENT_TOOL_PROJECTION);
      expect(claude).toContain(tool);
      expect(claude).toContain("through `ToolSearch` first");
      expect(blockFor(capabilities, heading)).not.toContain("ToolSearch");
    },
  );

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

  it("tells Claude to load the deferred device tools through ToolSearch", () => {
    const claude = buildScientAwareness(new Set(["device"]), CLAUDE_SCIENT_TOOL_PROJECTION);
    expect(claude).toContain(SCIENT_DEVICE_TOOL_INSTRUCTIONS_WITH_TOOL_SEARCH);
    expect(claude).toContain("`select:mcp__scient__device_list,");
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
