import { zoteroGroupIdOfLibrary, type ScientSourceRecord } from "@scientfactory/scient-sources";
import {
  isScientLibraryLocation,
  type ScientSourceStoreLocation,
} from "@scientfactory/scient-sources/library-root";
import { sourceAttachmentAbsolutePath } from "@scientfactory/scient-sources/store";
import type { ScientUnplacedAnnotation } from "@t3tools/contracts";

import {
  annotationProjectRoot,
  importScientAnnotations,
  type ImportedAnnotation,
} from "../annotations/annotationStore.ts";
import { anchorPdfQuote, type PdfPageText } from "../annotations/pdfQuoteAnchor.ts";
import { readSourcePdfPageTexts } from "./SourceFullText.ts";
import type { ZoteroPdfAnnotation } from "./ZoteroItems.ts";

/** A highlight's note holds this much; a longer comment is kept with the ones not placed. */
const NOTE_CHARACTERS = 8_000;

/** A highlight's ID here, the same on every import: a Zotero key is unique only in its library. */
function zoteroAnnotationId(annotation: ZoteroPdfAnnotation): string {
  const groupId = zoteroGroupIdOfLibrary(annotation.libraryId);
  const library = groupId === null ? `user_${annotation.libraryId}` : `group_${groupId}`;
  return `ann_zotero_${library}_${annotation.key}`;
}

/**
 * Places each highlight and underline by its quoted text on its page of these bytes, when it
 * is found there once; a phrase that repeats on its page is never guessed between. Everything
 * else is kept, with its page, quote and comment, as not placed.
 */
export function placeZoteroAnnotations(
  annotations: ReadonlyArray<ZoteroPdfAnnotation>,
  text: { readonly extractorVersion: string; readonly pages: ReadonlyArray<PdfPageText> } | null,
  now: string,
): {
  readonly placed: ReadonlyArray<ImportedAnnotation>;
  readonly unplaced: ReadonlyArray<ScientUnplacedAnnotation>;
} {
  const placed: ImportedAnnotation[] = [];
  const unplaced: ScientUnplacedAnnotation[] = [];
  for (const annotation of annotations) {
    const annotationId = zoteroAnnotationId(annotation);
    const at = annotation.addedAt ?? now;
    const anchoring =
      text &&
      annotation.page !== null &&
      (annotation.kind === "highlight" || annotation.kind === "underline") &&
      annotation.text.trim() &&
      annotation.comment.length <= NOTE_CHARACTERS
        ? anchorPdfQuote(text.pages, annotation.text, text.extractorVersion, annotation.page)
        : null;
    if (anchoring?._tag === "Found") {
      placed.push({
        annotationId,
        anchor: anchoring.anchor,
        note: annotation.comment,
        ...(annotation.color ? { color: annotation.color } : {}),
        ...(annotation.kind === "underline" ? { underline: true as const } : {}),
        at,
      });
      continue;
    }
    unplaced.push({
      annotationId,
      revision: 1,
      kind: annotation.kind,
      page: annotation.page,
      quote: annotation.text,
      comment: annotation.comment,
      ...(annotation.color ? { color: annotation.color } : {}),
      createdAt: at,
      deletedAt: null,
    });
  }
  return { placed, unplaced };
}

/**
 * Brings Zotero's highlights and comments onto the PDFs of a source here, each once (see
 * `addImportedAnnotations`). `pdfs` says which PDF here each Zotero file is, by its sha256.
 * Says how many were added, how many of those were not placed, and how many are on a file
 * that is not here.
 */
export async function bringZoteroAnnotations(input: {
  readonly root: ScientSourceStoreLocation;
  readonly record: ScientSourceRecord;
  readonly annotations: ReadonlyArray<ZoteroPdfAnnotation>;
  readonly pdfs: ReadonlyMap<string, string>;
  readonly now: string;
}): Promise<{ readonly added: number; readonly unplaced: number; readonly elsewhere: number }> {
  let added = 0;
  let unplaced = 0;
  let elsewhere = 0;
  const byFile = Map.groupBy(input.annotations, (annotation) => annotation.attachmentKey);
  for (const [attachmentKey, annotations] of byFile) {
    const sha256 = input.pdfs.get(attachmentKey);
    const attachment = input.record.attachments.find((candidate) => candidate.sha256 === sha256);
    if (!attachment) {
      elsewhere += annotations.length;
      continue;
    }
    const home = isScientLibraryLocation(input.root)
      ? input.root
      : await annotationProjectRoot(input.root);
    const material = { sha256: attachment.sha256, byteLength: attachment.byteLength };
    const text = await readSourcePdfPageTexts(home, {
      pdfPath: sourceAttachmentAbsolutePath(input.root, attachment),
      ...material,
    }).catch(() => null);
    const written = await importScientAnnotations({
      canonicalRoot: home,
      material,
      ...placeZoteroAnnotations(annotations, text, input.now),
    });
    added += written.placed + written.unplaced;
    unplaced += written.unplaced;
  }
  return { added, unplaced, elsewhere };
}
