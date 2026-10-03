import { describe, expect, it } from "vite-plus/test";

import { resolveWorkEntryToolPresentation } from "./presentation.ts";

describe("Scient tool presentation", () => {
  it.each([
    "scient_skills_list",
    "mcp__t3-code__scient_skills_list",
    "t3-code · scient_skills_list",
  ])("names the skills check for every provider's spelling: %s", (label) => {
    expect(resolveWorkEntryToolPresentation({ label, toolLifecycleStatus: "completed" })).toEqual({
      displayName: "Checked available skills",
      icon: "t3-code",
    });
  });

  it("names the loaded skill from the call's input", () => {
    const entry = {
      label: "scient_skill_load",
      toolData: { toolName: "scient_skill_load", input: { name: "html-pdf-authoring" } },
    };
    expect(
      resolveWorkEntryToolPresentation({ ...entry, toolLifecycleStatus: "inProgress" }),
    ).toEqual({ displayName: "Loading skill html-pdf-authoring", icon: "t3-code" });
    expect(
      resolveWorkEntryToolPresentation({ ...entry, toolLifecycleStatus: "completed" })?.displayName,
    ).toBe("Loaded skill html-pdf-authoring");
    expect(
      resolveWorkEntryToolPresentation({
        label: "scient_skill_read_resource",
        toolLifecycleStatus: "completed",
        toolData: { arguments: { name: "html-pdf-authoring", path: "references/print.md" } },
      })?.displayName,
    ).toBe("Read a file of skill html-pdf-authoring");
  });

  it("falls back to a general description when the input names no skill", () => {
    expect(
      resolveWorkEntryToolPresentation({
        label: "scient_skill_load",
        toolLifecycleStatus: "completed",
      })?.displayName,
    ).toBe("Loaded a skill");
  });

  it("names the other Scient tools", () => {
    expect(
      resolveWorkEntryToolPresentation({
        label: "scient_sources_list",
        toolLifecycleStatus: "completed",
      })?.displayName,
    ).toBe("Listed sources");
    expect(
      resolveWorkEntryToolPresentation({ label: "scient_pdf_build", toolLifecycleStatus: "failed" })
        ?.displayName,
    ).toBe("Failed to build a PDF");
  });
});
