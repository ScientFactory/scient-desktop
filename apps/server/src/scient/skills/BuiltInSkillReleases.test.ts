// @effect-diagnostics nodeBuiltinImport:off -- Test compares embedded bytes with review files.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import { describe, expect, it } from "@effect/vitest";

import {
  BUILT_IN_DOCUMENT_LAB_SKILL_RELEASES,
  BUILT_IN_SKILL_DEFAULT_ACTIVE_BY_ID,
  BUILT_IN_SKILL_RELEASES,
} from "./BuiltInSkillReleases.ts";
import { BUILT_IN_DOCUMENT_LAB_SKILL_SOURCES } from "./BuiltInDocumentLabSkillSources.ts";
import { BUILT_IN_SKILL_SOURCES } from "./BuiltInSkillSources.ts";

describe("Scient built-in skill releases", () => {
  it("embeds every reviewed release with explicit product-owned defaults", () => {
    expect(BUILT_IN_SKILL_RELEASES.every((release) => release.instructions.length > 0)).toBe(true);
    expect(BUILT_IN_DOCUMENT_LAB_SKILL_RELEASES.map((release) => release.name)).toEqual([
      "word-docx",
      "excel-xlsx",
      "powerpoint-pptx",
      "pdf-files",
      "google-workspace",
      "document-review",
      "document-template",
    ]);
    expect(Object.fromEntries(BUILT_IN_SKILL_DEFAULT_ACTIVE_BY_ID)).toEqual({
      "scient.workspace-readiness-review": true,
      "scient.improve-workspace-readiness": true,
      "scient.skill-authoring": true,
      "scient.connector-authoring": true,
      "scient.pdf-authoring": true,
      "scient.latex-authoring": true,
      "scient.overleaf-sync": true,
      "scient.references": true,
      "scient.systematic-review": true,
      "scient.compare-sources": true,
      "scient.statistics-review": true,
      "scient.check-reported-numbers": true,
      "scient.reviewer-response": true,
      "scient.ml-evaluation-audit": true,
      "scient.reporting-guideline-check": true,
      "scient.diagnose-analysis": true,
      "scient.grill-me": true,
      "scient.to-questionnaire": true,
      "scient.teach": true,
      "scient.transcripts": true,
    });
  });

  it("keeps bundle-safe bytes identical to the human-reviewable release files", async () => {
    for (const source of [...BUILT_IN_SKILL_SOURCES, ...BUILT_IN_DOCUMENT_LAB_SKILL_SOURCES]) {
      const root = NodePath.join(import.meta.dirname, "built-ins", source.directoryName);
      for (const [relativePath, contents] of Object.entries(source.files)) {
        await expect(NodeFSP.readFile(NodePath.join(root, relativePath), "utf8")).resolves.toBe(
          contents,
        );
      }
    }
  });
});
