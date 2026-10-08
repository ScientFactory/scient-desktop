import { describe, expect, it } from "vite-plus/test";

import {
  resolveWorkEntryToolPresentation,
  summarizeToolGroup,
  type WorkLogPresentationEntry,
} from "./presentation.ts";

describe("Scient tool presentation", () => {
  it.each([
    "scient_skills_list",
    "mcp__t3-code__scient_skills_list",
    "mcp__scient__scient_skills_list",
    "t3-code · scient_skills_list",
  ])("names the skills check for every provider's spelling: %s", (label) => {
    expect(resolveWorkEntryToolPresentation({ label, toolLifecycleStatus: "completed" })).toEqual({
      displayName: "Checked available skills",
      icon: "scient",
    });
  });

  it("names the skill from the call's input", () => {
    const load = {
      label: "mcp__t3-code__scient_skill_load",
      toolData: { input: { name: "html-pdf-authoring" } },
    };
    expect(
      resolveWorkEntryToolPresentation({ ...load, toolLifecycleStatus: "inProgress" }),
    ).toEqual({ displayName: "Loading Html Pdf Authoring", icon: "scient" });
    expect(
      resolveWorkEntryToolPresentation({ ...load, toolLifecycleStatus: "completed" })?.displayName,
    ).toBe("Used Html Pdf Authoring");
    expect(
      resolveWorkEntryToolPresentation({ ...load, toolLifecycleStatus: "failed" })?.displayName,
    ).toBe("Failed to load Html Pdf Authoring");
    expect(
      resolveWorkEntryToolPresentation({
        label: "scient_skill_load",
        toolLifecycleStatus: "completed",
        toolData: { input: { releaseKey: "scient.latex-authoring@immutable-release" } },
      })?.displayName,
    ).toBe("Used Latex Authoring");
    expect(
      resolveWorkEntryToolPresentation({
        label: "scient_skill_read_resource",
        toolLifecycleStatus: "completed",
        toolData: { arguments: { name: "html-pdf-authoring", path: "references/print.md" } },
      })?.displayName,
    ).toBe("Read a file of Html Pdf Authoring");
  });

  it("falls back to a general description when the input names no skill", () => {
    expect(
      resolveWorkEntryToolPresentation({
        label: "scient_skill_load",
        toolLifecycleStatus: "completed",
        toolData: { input: { name: " " } },
      })?.displayName,
    ).toBe("Used a skill");
    expect(
      resolveWorkEntryToolPresentation({
        label: "scient_skill_read_resource",
        toolLifecycleStatus: "inProgress",
      })?.displayName,
    ).toBe("Reading a skill file");
  });

  it("names the other Scient tools, including failures the result reports", () => {
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
    expect(
      resolveWorkEntryToolPresentation({
        label: "t3-code.scient_latex_build",
        toolLifecycleStatus: "completed",
        toolData: { input: {}, output: { isError: true, content: "LaTeX error" } },
      })?.displayName,
    ).toBe("Failed to build a LaTeX document");
  });

  it("summarizes a group by the Scient tool families it used", () => {
    const entry = (id: string, label: string): WorkLogPresentationEntry => ({
      id,
      createdAt: "2026-10-07T00:00:00.000Z",
      tone: "tool",
      label,
      itemType: "dynamic_tool",
      toolLifecycleStatus: "completed",
    });
    expect(
      summarizeToolGroup([
        entry("list", "scient_skills_list"),
        entry("load", "scient_skill_load"),
        entry("build", "mcp__t3-code__scient_pdf_build"),
      ]).summary,
    ).toBe("Used skills 2 times and prepared documents 1 time");
    // Builds and exports share the documents summary, so its verb covers both.
    expect(
      summarizeToolGroup([
        entry("build", "scient_latex_build"),
        entry("export", "scient_document_export"),
      ]).summary,
    ).toBe("Prepared documents 2 times");
  });
});
