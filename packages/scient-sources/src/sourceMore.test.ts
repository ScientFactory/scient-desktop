// @effect-diagnostics nodeBuiltinImport:off -- These tests use a real project folder.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { initializeScientProject } from "@scientfactory/project-init";
import { afterEach, describe, expect, it } from "@effect/vitest";

import {
  applyEditableMetadata,
  editableMetadataFromRecord,
  validateScientSourceEditableMetadata,
} from "./editable.ts";
import { assessSourceMetadataDuplicate } from "./duplicates.ts";
import type { ScientSourceCandidate } from "./model.ts";
import { sourceEditionsDiffer } from "./normalize.ts";
import { normalizeScientSourceMore } from "./sourceMore.ts";
import {
  importScientSource,
  listScientSourceRevisions,
  readScientSourceRecord,
  revertScientSource,
  updateScientSourceMetadata,
} from "./store.ts";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => NodeFSP.rm(root, { recursive: true, force: true })),
  );
});

const book: ScientSourceCandidate = {
  sourceKey: "book-1",
  type: "book",
  title: "Statistical methods in medical research",
  creators: [
    { creatorType: "author", givenName: "Peter", familyName: "Armitage", literalName: null },
  ],
  issuedRaw: "2002",
  issuedYear: 2002,
  identifiers: [],
  abstract: null,
  containerTitle: null,
  publisher: "Blackwell Science",
  volume: null,
  issue: null,
  pages: null,
  language: null,
  url: null,
  more: { edition: "4", "publisher-place": "Oxford" },
  tags: [],
  externalReferences: [],
  fieldProvenance: [{ field: "more.edition", origin: "zotero", sourceField: "edition" }],
  pdfAvailable: false,
  pdfFileName: null,
  pdfAttachmentCount: 0,
};

async function imported() {
  const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "scient-source-more-"));
  roots.push(root);
  await initializeScientProject({ root });
  const result = await importScientSource({
    root,
    operationId: "op_more",
    candidate: book,
    actor: "user",
    intake: "zotero",
  });
  return { root, record: result.record! };
}

describe("the details a source has beyond its own fields", () => {
  it("keeps only what fits, whole, and says what it left", () => {
    expect(
      normalizeScientSourceMore({
        "publisher-place": "  Oxford ",
        edition: "4",
        "number-of-pages": " ",
        "not-a-detail": "x",
        version: "v".repeat(2_001),
      }),
    ).toEqual({
      // In the list's own order, trimmed, with the empty one gone.
      more: { edition: "4", "publisher-place": "Oxford" },
      left: ["not-a-detail", "version"],
    });
    expect(normalizeScientSourceMore(undefined)).toEqual({ more: null, left: [] });
  });

  it("arrives with the source, and an edit that does not name them leaves them alone", async () => {
    const { root, record } = await imported();
    expect(record.more).toEqual({ edition: "4", "publisher-place": "Oxford" });

    const { more: _more, ...withoutMore } = editableMetadataFromRecord(record);
    const retitled = await updateScientSourceMetadata({
      root,
      sourceId: record.sourceId,
      expectedRevision: record.revision,
      metadata: { ...withoutMore, title: "Statistical methods" },
      actor: "user",
    });
    expect(retitled.record).toMatchObject({
      title: "Statistical methods",
      more: { edition: "4", "publisher-place": "Oxford" },
    });
  });

  it("changes, adds and removes one at a time, says who did, and History takes it back", async () => {
    const { root, record } = await imported();
    const edited = await updateScientSourceMetadata({
      root,
      sourceId: record.sourceId,
      expectedRevision: record.revision,
      metadata: {
        ...editableMetadataFromRecord(record),
        // The edition corrected, the place removed, the page count added.
        more: { edition: "4th revised", "number-of-pages": "817" },
      },
      actor: "agent",
    });
    expect(edited.record?.more).toEqual({ edition: "4th revised", "number-of-pages": "817" });
    expect(
      edited.record?.fieldProvenance.filter((entry) => entry.field.startsWith("more")),
    ).toEqual([
      { field: "more.edition", origin: "agent", sourceField: null },
      { field: "more.publisher-place", origin: "agent", sourceField: null },
      { field: "more.number-of-pages", origin: "agent", sourceField: null },
    ]);
    expect(
      (await listScientSourceRevisions(root, record.sourceId))?.map((entry) => entry.changes),
    ).toEqual([["more"], []]);

    // All of them removed: the part is gone from the record, not left empty.
    const cleared = await updateScientSourceMetadata({
      root,
      sourceId: record.sourceId,
      expectedRevision: edited.record!.revision,
      metadata: { ...editableMetadataFromRecord(edited.record!), more: {} },
      actor: "user",
    });
    expect(cleared.record).not.toHaveProperty("more");

    const reverted = await revertScientSource({
      root,
      sourceId: record.sourceId,
      expectedRevision: cleared.record!.revision,
      toRevision: record.revision,
    });
    expect(reverted.outcome).toBe("reverted");
    expect((await readScientSourceRecord(root, record.sourceId))?.more).toEqual({
      edition: "4",
      "publisher-place": "Oxford",
    });
  });

  it("takes another edition or version of the same title for another source", () => {
    const existing = (more: Record<string, string>) => [
      {
        formatVersion: 1 as const,
        sourceId: "source_1",
        projectId: "project_1",
        revision: 1,
        ...withMore(more),
        externalReferences: [],
        attachments: [],
        fieldProvenance: [],
        importedAt: "2026-11-15T09:00:00.000Z",
      },
    ];
    const kind = (here: Record<string, string>, coming: Record<string, string>) =>
      assessSourceMetadataDuplicate({ source: withMore(coming), existing: existing(here) }).kind;
    // Same title, author and year: the edition tells them apart, however it is written.
    expect(kind({ edition: "2" }, { edition: "3rd ed." })).toBe("new");
    expect(kind({ version: "1.1-35" }, { version: "1.1-36" })).toBe("new");
    expect(kind({ edition: "2" }, { edition: "2nd" })).toBe("possible-metadata-match");
    // A source that names no edition may still be the same book: a person decides.
    expect(kind({ edition: "2" }, {})).toBe("possible-metadata-match");
    expect(kind({}, {})).toBe("possible-metadata-match");
    expect(
      sourceEditionsDiffer({ more: { edition: "Second" } }, { more: { edition: "third" } }),
    ).toBe(true);
  });

  it("refuses a detail that is too long instead of cutting it", () => {
    const issues = validateScientSourceEditableMetadata({
      ...withMore({ edition: "e".repeat(2_001), "not-a-detail": "x" }),
    });
    expect(issues).toEqual([
      { field: "more.not-a-detail", message: "This detail has no name Scient knows." },
      { field: "more.edition", message: "Edition is too long to keep." },
    ]);
    expect(validateScientSourceEditableMetadata(withMore({ edition: "4" }))).toEqual([]);
    // Applying never drops one either: what is given is what is kept.
    expect(
      applyEditableMetadata({
        record: {
          formatVersion: 1,
          sourceId: "source_1",
          projectId: "project_1",
          revision: 1,
          ...withMore({}),
          externalReferences: [],
          attachments: [],
          fieldProvenance: [],
          importedAt: "2026-11-15T09:00:00.000Z",
        },
        metadata: withMore({ extra: "OCLC: 12345\nbought second hand" }),
        updatedAt: "2026-11-15T10:00:00.000Z",
      }).more,
    ).toEqual({ extra: "OCLC: 12345\nbought second hand" });
  });
});

function withMore(more: Record<string, string>) {
  const { sourceKey: _key, fieldProvenance: _p, externalReferences: _e, ...fields } = book;
  const { pdfAvailable: _a, pdfFileName: _f, pdfAttachmentCount: _c, ...metadata } = fields;
  return { ...metadata, more };
}
