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
        version: "0.1.0",
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
        version: "0.1.0",
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
        version: "0.1.0",
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

    expect(pdfAuthoring.instructions).toContain("Honor the user's requested source format");
    expect(pdfAuthoring.instructions).toContain("not its topic or length alone");
    expect(pdfAuthoring.instructions).toContain("use `html-pdf-authoring` when available");
    expect(pdfAuthoring.instructions).toContain("use `latex-authoring` when available");
    expect(pdfAuthoring.instructions).not.toContain("If `scient_pdf_build` is available");
    expect(pdfAuthoring.instructions).toContain("exact `outputPath` returned by a build operation");
    expect(htmlPdfAuthoring.description).toContain(
      "Use only when PDF or printable output is the purpose of the HTML work",
    );
    expect(htmlPdfAuthoring.description).toContain("not for ordinary webpage creation or editing");
    expect(htmlPdfAuthoring.instructions).toContain("If `scient_pdf_build` is available");
    expect(htmlPdfAuthoring.instructions).toContain(
      "only when HTML is being created or modified specifically to produce a PDF",
    );
    expect(htmlPdfAuthoring.instructions).toContain("returned `outputPath`");
    expect(htmlPdfAuthoring.instructions).toContain("blocks remote resources");
    expect(htmlPdfAuthoring.instructions).toContain("inside `@media screen`");
    expect(htmlPdfAuthoring.instructions).toContain("physical PDF margins only with `@page`");
    expect(htmlPdfAuthoring.instructions).toContain('actual `<a href="...">` element');
    expect(htmlPdfAuthoring.instructions).toContain("actual clickable link annotations");
    expect(htmlPdfAuthoring.instructions).toContain("project-relative Markdown links");
    expect(htmlPdfAuthoring.instructions).toContain("This skill grants no tools or authority");
    expect(latexAuthoring.description).toContain("user requests LaTeX or a .tex source");
    expect(latexAuthoring.instructions).toContain("preserve an existing project's document class");
    expect(latexAuthoring.instructions).toContain("use `% !TEX root = main.tex`");
    expect(latexAuthoring.instructions).toContain("prefer `\\usepackage[hidelinks]{hyperref}`");
    expect(latexAuthoring.instructions).toContain("instead of default boxed annotations");
    expect(latexAuthoring.instructions).toContain("provide a project-relative Markdown link");
    expect(latexAuthoring.instructions).toContain("is not evidence that compilation succeeded");
    expect(latexAuthoring.instructions).toContain(
      "grants no tools, packages, credentials, or permissions",
    );
    expect(pdfAuthoring.instructions).toContain("project-relative Markdown links");
  });
});
