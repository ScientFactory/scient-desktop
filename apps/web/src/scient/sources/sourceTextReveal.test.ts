import { relocatePdfText } from "@scientfactory/document-artifacts";
import { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { workspacePdfSource } from "../pdf/pdfSource";
import { sourceTextRevealTarget } from "./sourceTextReveal";

const pageText = "Results\nEarly antibiotics reduced mortality\nin septic shock.\n";
const material = { sha256: "ab".repeat(32), byteLength: 2_048 };
const source = workspacePdfSource({
  environmentId: EnvironmentId.make("environment-1"),
  fileName: "trial.pdf",
  workspaceRoot: "/project",
  relativePath: `.scient/sources/files/sha256/ab/${material.sha256}.pdf`,
  origin: {
    _tag: "source",
    workspaceRoot: "/project",
    sourceId: "source-1",
    attachmentId: "pdf-1",
  },
  material,
});

const hit = {
  sourceId: "source-1",
  attachmentId: "pdf-1",
  fileName: "trial.pdf",
  title: "Trial",
  page: 2,
  start: 14,
  end: 25,
  passage: "Results Early antibiotics reduced mortality in septic shock.",
  matchedTerms: ["antibiotics"],
  selector: {
    extractorVersion: "6.2.108",
    viewBox: [0, 0, 612, 792] as const,
    rotation: 0,
    userUnit: 1,
    pageTextHash: "cd".repeat(32),
    quote: "antibiotics",
    prefix: "Results\nEarly ",
    suffix: " reduced mortality\nin septic shock.\n",
  },
};

describe("Library search reveal", () => {
  it("turns a search hit into a reader quote that is found again by its text", () => {
    const target = sourceTextRevealTarget(source, hit);
    expect(target).toMatchObject({
      material,
      document: { locator: { _tag: "source", sourceId: "source-1", attachmentId: "pdf-1" } },
      extractor: { version: "6.2.108" },
    });
    expect(
      relocatePdfText(target!, {
        pages: [
          { page: 1, text: "Introduction\n" },
          { page: 2, text: pageText },
        ],
        complete: true,
      }),
    ).toEqual({ _tag: "Found", ranges: [{ page: 2, start: 14, end: 25 }] });
  });

  it("opens the PDF without a highlight when the stored page cannot form a quote", () => {
    expect(
      sourceTextRevealTarget(source, {
        ...hit,
        selector: { ...hit.selector, viewBox: [0, 0, 0, 0] as const },
      }),
    ).toBeNull();
  });
});
