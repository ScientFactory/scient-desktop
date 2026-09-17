// @effect-diagnostics nodeBuiltinImport:off -- Test compares embedded bytes with review files.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import { describe, expect, it } from "@effect/vitest";

import {
  BUILT_IN_SKILL_DEFAULT_ACTIVE_BY_ID,
  BUILT_IN_SKILL_RELEASES,
} from "./BuiltInSkillReleases.ts";
import { BUILT_IN_SKILL_SOURCES } from "./BuiltInSkillSources.ts";

describe("Scient built-in skill releases", () => {
  it("embeds the six reviewed releases with explicit product-owned defaults", () => {
    expect(BUILT_IN_SKILL_RELEASES).toMatchObject([
      {
        id: "scient.workspace-readiness-review",
        version: "0.1.0",
        category: "Workspace readiness",
        categoryDescription:
          "Review and improve a workspace so people and agents can understand it and work safely.",
        displayOrder: 10,
        supportedScopes: ["project", "user"],
        defaultInvocationPolicy: "automatic",
        origin: "scient",
        resources: [],
      },
      {
        id: "scient.improve-workspace-readiness",
        version: "0.1.0",
        category: "Workspace readiness",
        categoryDescription:
          "Review and improve a workspace so people and agents can understand it and work safely.",
        displayOrder: 20,
        supportedScopes: ["project", "user"],
        defaultInvocationPolicy: "explicit",
        origin: "scient",
        resources: [],
      },
      {
        id: "scient.skill-authoring",
        version: "0.1.0",
        category: "Skill creation",
        categoryDescription: "Create and improve reusable guidance for Scient agents.",
        displayOrder: 30,
        supportedScopes: ["user"],
        defaultInvocationPolicy: "automatic",
        origin: "scient",
        resources: [],
      },
      {
        id: "scient.pdf-authoring",
        version: "0.3.0",
        category: "Document creation",
        categoryDescription: "Create polished documents and reliable final outputs.",
        displayOrder: 40,
        supportedScopes: ["user"],
        defaultInvocationPolicy: "automatic",
        origin: "scient",
        resources: [],
      },
      {
        id: "scient.html-pdf-authoring",
        version: "0.3.0",
        category: "Document creation",
        categoryDescription: "Create polished documents and reliable final outputs.",
        displayOrder: 50,
        supportedScopes: ["user"],
        defaultInvocationPolicy: "automatic",
        origin: "scient",
        resources: [],
      },
      {
        id: "scient.latex-authoring",
        version: "0.3.0",
        category: "Document creation",
        categoryDescription: "Create polished documents and reliable final outputs.",
        displayOrder: 60,
        supportedScopes: ["user"],
        defaultInvocationPolicy: "automatic",
        origin: "scient",
        resources: [],
      },
    ]);
    expect(BUILT_IN_SKILL_RELEASES.every((release) => release.instructions.length > 0)).toBe(true);
    expect(Object.fromEntries(BUILT_IN_SKILL_DEFAULT_ACTIVE_BY_ID)).toEqual({
      "scient.workspace-readiness-review": true,
      "scient.improve-workspace-readiness": true,
      "scient.skill-authoring": true,
      "scient.pdf-authoring": true,
      "scient.html-pdf-authoring": true,
      "scient.latex-authoring": true,
    });
  });

  it("keeps bundle-safe bytes identical to the human-reviewable release files", async () => {
    for (const source of BUILT_IN_SKILL_SOURCES) {
      const root = NodePath.join(import.meta.dirname, "built-ins", source.directoryName);
      for (const [relativePath, contents] of Object.entries(source.files)) {
        await expect(NodeFSP.readFile(NodePath.join(root, relativePath), "utf8")).resolves.toBe(
          contents,
        );
      }
    }
  });

  it("keeps route selection general and format-specific guidance focused", () => {
    const pdfAuthoring = BUILT_IN_SKILL_RELEASES.find(
      (release) => release.id === "scient.pdf-authoring",
    )!;
    const htmlPdfAuthoring = BUILT_IN_SKILL_RELEASES.find(
      (release) => release.id === "scient.html-pdf-authoring",
    )!;
    const latexAuthoring = BUILT_IN_SKILL_RELEASES.find(
      (release) => release.id === "scient.latex-authoring",
    )!;

    expect(pdfAuthoring.description).toContain("create a PDF, change an existing PDF");
    expect(pdfAuthoring.instructions).toContain("use direct PDF operations");
    expect(pdfAuthoring.instructions).toContain("Consider other available authoring");
    expect(pdfAuthoring.instructions).toContain("Use `latex-authoring` for LaTeX");
    expect(pdfAuthoring.instructions).toContain("`html-pdf-authoring` for HTML-to-PDF");
    expect(pdfAuthoring.instructions).not.toContain("If `scient_pdf_build` is available");
    expect(pdfAuthoring.instructions).not.toContain("`scient_latex_build`");
    expect(pdfAuthoring.instructions).toContain("source alone is not completion");
    expect(pdfAuthoring.instructions).toContain("Prefer direct page rendering");
    expect(pdfAuthoring.instructions).toContain("when a tool returns `outputPath`");
    expect(htmlPdfAuthoring.description).toContain("editable source for a PDF requested in Scient");
    expect(htmlPdfAuthoring.description).toContain("Do not use for ordinary webpage work");
    expect(htmlPdfAuthoring.instructions).toContain("When `scient_pdf_build` is available");
    expect(htmlPdfAuthoring.instructions).toContain(
      "final PDF at the exact `outputPath` returned by the build",
    );
    expect(htmlPdfAuthoring.instructions).toContain("blocks remote resources");
    expect(htmlPdfAuthoring.instructions).toContain(
      "Treat an explicitly requested page count as a real output constraint",
    );
    expect(htmlPdfAuthoring.instructions).toContain(
      "Keep content together only when it can reasonably fit on one page",
    );
    expect(htmlPdfAuthoring.instructions).toContain("choose **Export PDF**");
    expect(htmlPdfAuthoring.instructions).toContain(
      "inspect rendered page images or an equivalent preview of the resulting PDF",
    );
    expect(htmlPdfAuthoring.instructions).toContain(
      "Prefer direct page rendering or a PDF preview tool over computer use",
    );
    expect(htmlPdfAuthoring.instructions).toContain("verify the updated PDF");
    expect(htmlPdfAuthoring.instructions).toContain("If visual inspection is unavailable, say so");
    expect(htmlPdfAuthoring.instructions).not.toContain("`@page`");
    expect(htmlPdfAuthoring.instructions).not.toContain("physical margins");
    expect(htmlPdfAuthoring.instructions).not.toContain("`break-inside`");
    expect(htmlPdfAuthoring.instructions).toContain("This skill grants no tools or authority");
    expect(latexAuthoring.description).toContain("user asks for LaTeX or a `.tex` file");
    expect(latexAuthoring.instructions).toContain("Preserve an existing project's document class");
    expect(latexAuthoring.instructions).toContain("add a `% !TEX root` comment");
    expect(latexAuthoring.instructions).toContain("make its path relative to that file");
    expect(latexAuthoring.instructions).toContain(
      "commands, environments, and required characters are supported",
    );
    expect(latexAuthoring.instructions).toContain("Preserve an existing project's hyperlink");
    expect(latexAuthoring.instructions).toContain("verify the intended navigation");
    expect(latexAuthoring.instructions).not.toContain("unobtrusive, accessible styling");
    expect(latexAuthoring.instructions).not.toContain("default boxed annotations");
    expect(latexAuthoring.instructions).not.toContain("`\\mathscr`");
    expect(latexAuthoring.instructions).not.toContain("`\\middle`");
    expect(latexAuthoring.instructions).not.toContain("hidelinks");
    expect(latexAuthoring.instructions).toContain("LaTeX Source, Split, and PDF surface");
    expect(latexAuthoring.instructions).toContain("`scient_latex_build` is available");
    expect(latexAuthoring.instructions).toContain("wait at least `retryAfterMs`");
    expect(latexAuthoring.instructions).toContain("do not start a parallel build");
    expect(latexAuthoring.instructions).toContain("exact `sourcePath` and `outputPath`");
    expect(latexAuthoring.instructions).toContain("identify it as the compiled root");
    expect(latexAuthoring.instructions).toContain("actual `pageCount`");
    expect(latexAuthoring.instructions).toContain(
      "Automatic opening in Scient does not replace these links",
    );
    expect(latexAuthoring.instructions).toContain("Prefer direct page rendering");
    expect(latexAuthoring.instructions).toContain("verify the updated PDF");
    expect(latexAuthoring.instructions).toContain("If visual inspection is unavailable, say so");
    expect(latexAuthoring.instructions).not.toContain("/PageLabels");
    expect(latexAuthoring.instructions).toContain("is not evidence that compilation succeeded");
    expect(latexAuthoring.instructions).toContain("This skill grants no tools or authority");
    for (const authoringSkill of [pdfAuthoring, htmlPdfAuthoring, latexAuthoring]) {
      expect(authoringSkill.instructions).toContain("Scient chat");
      expect(authoringSkill.instructions).toContain("clickable project-relative Markdown link");
    }
  });
});
