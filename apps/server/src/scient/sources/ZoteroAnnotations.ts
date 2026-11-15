import { zoteroGroupIdOfLibrary, type ScientSourceRecord } from "@scientfactory/scient-sources";
import {
  isScientLibraryLocation,
  type ScientSourceStoreLocation,
} from "@scientfactory/scient-sources/library-root";
import { sourceAttachmentAbsolutePath } from "@scientfactory/scient-sources/store";
import { ScientUnplacedAnnotation } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

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
const keptWhole = Schema.is(ScientUnplacedAnnotation);

/**
 * A highlight's ID here, the same on every import and refresh: a Zotero key is unique only in
 * its library. That is the library the source's link names, which stays as it was at import
 * (Zotero on this computer reports `0` for My Library until it signs in to sync).
 */
function zoteroAnnotationId(libraryId: string, key: string): string {
  const groupId = zoteroGroupIdOfLibrary(libraryId);
  return `ann_zotero_${groupId === null ? `user_${libraryId}` : `group_${groupId}`}_${key}`;
}

/**
 * Places each highlight and underline of the item in `libraryId` by its quoted text on its
 * page of these bytes, when it is found there once; a phrase that repeats on its page is never
 * guessed between. Everything else is kept, with its page, quote and comment, as not placed,
 * unless it is longer than that list holds: `tooLong` counts those, so they are said, not cut.
 */
export function placeZoteroAnnotations(
  annotations: ReadonlyArray<ZoteroPdfAnnotation>,
  libraryId: string,
  text: { readonly extractorVersion: string; readonly pages: ReadonlyArray<PdfPageText> } | null,
  now: string,
): {
  readonly placed: ReadonlyArray<ImportedAnnotation>;
  readonly unplaced: ReadonlyArray<ScientUnplacedAnnotation>;
  readonly tooLong: number;
} {
  const placed: ImportedAnnotation[] = [];
  const unplaced: ScientUnplacedAnnotation[] = [];
  let tooLong = 0;
  for (const annotation of annotations) {
    const annotationId = zoteroAnnotationId(libraryId, annotation.key);
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
    const kept: ScientUnplacedAnnotation = {
      annotationId,
      revision: 1,
      kind: annotation.kind,
      page: annotation.page,
      quote: annotation.text,
      comment: annotation.comment,
      ...(annotation.color ? { color: annotation.color } : {}),
      createdAt: at,
      deletedAt: null,
    };
    if (keptWhole(kept)) unplaced.push(kept);
    else tooLong += 1;
  }
  return { placed, unplaced, tooLong };
}

/**
 * Brings Zotero's highlights and comments onto the PDFs of a source here, each once (see
 * `addImportedAnnotations`). `pdfs` says which PDF here each Zotero file is, by its sha256.
 * Says how many were added, how many of those were not placed, how many are on a file that
 * is not here, and how many were too long to keep.
 */
export async function bringZoteroAnnotations(input: {
  readonly root: ScientSourceStoreLocation;
  readonly record: ScientSourceRecord;
  readonly annotations: ReadonlyArray<ZoteroPdfAnnotation>;
  readonly pdfs: ReadonlyMap<string, string>;
  readonly now: string;
}): Promise<{
  readonly added: number;
  readonly unplaced: number;
  readonly elsewhere: number;
  readonly tooLong: number;
}> {
  const libraryId = input.record.externalReferences.find(
    (reference) => reference.system === "zotero",
  )?.libraryId;
  if (libraryId === undefined) throw new Error("This source is not linked to Zotero.");
  let added = 0;
  let unplaced = 0;
  let elsewhere = 0;
  let tooLong = 0;
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
    const marks = placeZoteroAnnotations(annotations, libraryId, text, input.now);
    const written = await importScientAnnotations({
      canonicalRoot: home,
      material,
      placed: marks.placed,
      unplaced: marks.unplaced,
    });
    added += written.placed + written.unplaced;
    unplaced += written.unplaced;
    tooLong += marks.tooLong;
  }
  return { added, unplaced, elsewhere, tooLong };
}
