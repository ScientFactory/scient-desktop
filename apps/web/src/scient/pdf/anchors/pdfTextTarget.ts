import {
  ArtifactAuthority,
  PDF_TARGET_LIMITS,
  PDF_TEXT_PROFILE,
  PdfTarget,
  type PdfDocumentIdentity,
  type PdfMaterial,
  type PdfSourceDescriptor,
} from "@scientfactory/document-artifacts";
import { sha256 } from "@noble/hashes/sha2";
import { version as pdfjsVersion } from "pdfjs-dist/legacy/build/pdf.mjs";

import type { PdfSelectedPage, PdfSelectionRefusal } from "./pdfTextLayer";

/** The extractor version stored with every target; a pdf.js upgrade invalidates offsets. */
export const PDF_EXTRACTOR_VERSION = pdfjsVersion;

export function pdfTextHash(text: string): string {
  return [...sha256(new TextEncoder().encode(text))]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * The durable identity of the PDF a reader shows, or null when it has none
 * worth quoting (an attachment still in the composer: it travels with the
 * message being written).
 */
export function pdfDocumentIdentity(source: PdfSourceDescriptor): PdfDocumentIdentity | null {
  const base = {
    authority: ArtifactAuthority.make(source.authority),
    logicalDocumentKey: source.logicalDocumentKey,
    title: source.title,
    fileName: source.fileName,
  };
  switch (source._tag) {
    case "workspace-pdf":
      return {
        ...base,
        locator: source.origin
          ? {
              _tag: "source",
              workspaceRoot: source.origin.workspaceRoot,
              sourceId: source.origin.sourceId,
              attachmentId: source.origin.attachmentId,
              relativePath: source.relativePath,
            }
          : {
              _tag: "workspace",
              workspaceRoot: source.workspaceRoot,
              relativePath: source.relativePath,
            },
      };
    case "generated-pdf":
      return {
        ...base,
        locator: {
          _tag: "generated",
          artifactId: source.artifactId,
          revisionId: source.revisionId,
          bindingGeneration: source.bindingGeneration,
        },
      };
    case "environment-pdf":
      return { ...base, locator: { _tag: "environment", path: source.path } };
    case "attachment-pdf":
      return source.locator._tag === "sent"
        ? {
            ...base,
            locator: {
              _tag: "attachment",
              threadId: source.locator.threadId,
              attachmentId: source.locator.attachmentId,
              ...(source.locator.sizeBytes === undefined
                ? {}
                : { sizeBytes: source.locator.sizeBytes }),
            },
          }
        : null;
  }
}

export type PdfTextTargetResult =
  | { readonly _tag: "Target"; readonly target: PdfTarget }
  | { readonly _tag: "Refused"; readonly reason: PdfSelectionRefusal };

/** Builds the stored target from a synchronous selection read. */
export function pdfTextTarget(input: {
  readonly document: PdfDocumentIdentity;
  readonly material: PdfMaterial | null;
  readonly pages: ReadonlyArray<PdfSelectedPage>;
}): PdfTextTargetResult {
  const { context } = PDF_TARGET_LIMITS;
  const consecutive = input.pages.every(
    (page, index, pages) => index === 0 || page.page === pages[index - 1]!.page + 1,
  );
  if (!consecutive) return { _tag: "Refused", reason: "invalid-selection" };
  try {
    return {
      _tag: "Target",
      target: PdfTarget.make({
        version: 1,
        document: input.document,
        material: input.material,
        extractor: { profile: PDF_TEXT_PROFILE, version: PDF_EXTRACTOR_VERSION },
        selector: {
          type: "text",
          pages: input.pages.map((page) => ({
            page: page.page,
            viewBox: [...page.viewBox],
            rotation: page.rotation,
            userUnit: page.userUnit,
            pageTextHash: pdfTextHash(page.text),
            start: page.start,
            end: page.end,
            quote: page.text.slice(page.start, page.end),
            prefix: page.text.slice(Math.max(0, page.start - context), page.start),
            suffix: page.text.slice(page.end, page.end + context),
          })),
        },
      }),
    };
  } catch {
    return { _tag: "Refused", reason: "invalid-selection" };
  }
}
