// @effect-diagnostics nodeBuiltinImport:off -- Identifier add tests exercise the real project filesystem boundary.
// @effect-diagnostics globalDate:off -- Fixed Date values make retrieval timestamps deterministic.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { initializeScientProject } from "@scientfactory/project-init";
import type { ScientSourceIdentifier } from "@scientfactory/scient-sources";
import { importScientSource, listScientSourceRecords } from "@scientfactory/scient-sources/store";
import { afterEach, describe, expect, it } from "@effect/vitest";
import { vi } from "vite-plus/test";

import {
  addScientSourcesByIdentifier,
  type ResolveSourceIdentifierBatch,
} from "./SourceIdentifierAdd.ts";
import type {
  ResolvedSourceMetadata,
  SourceIdentifierResolution,
} from "./SourceIdentifierResolver.ts";

const fixtures: string[] = [];

afterEach(async () => {
  await Promise.all(
    fixtures.splice(0).map((root) => NodeFSP.rm(root, { recursive: true, force: true })),
  );
});

async function project(): Promise<string> {
  const root = await NodeFSP.mkdtemp(
    NodePath.join(NodeOS.tmpdir(), "scient-source-identifier-add-"),
  );
  fixtures.push(root);
  await initializeScientProject({ root });
  return root;
}

function metadata(
  title: string,
  identifiers: ReadonlyArray<ScientSourceIdentifier>,
): ResolvedSourceMetadata {
  return {
    type: "article",
    title,
    creators: [
      { creatorType: "author", givenName: "Ada", familyName: "Lovelace", literalName: null },
    ],
    issuedRaw: "2021",
    issuedYear: 2021,
    identifiers,
    abstract: null,
    abstractSections: [],
    containerTitle: "Journal of Measurements",
    publisher: null,
    volume: null,
    issue: null,
    pages: null,
    language: null,
    url: null,
  };
}

/** Answers from a table keyed by "scheme:value"; anything else is unavailable. */
function registry(
  answers: Readonly<Record<string, "not-found" | ResolvedSourceMetadata>>,
): ResolveSourceIdentifierBatch {
  return async (identifiers) =>
    identifiers.map((identifier): SourceIdentifierResolution => {
      const answer = answers[`${identifier.scheme}:${identifier.value}`];
      if (answer === "not-found") return { status: "not-found", identifier };
      if (!answer) return { status: "unavailable", identifier };
      return {
        status: "found",
        identifier,
        metadata: answer,
        retrievedAt: "2026-11-10T12:00:00.000Z",
      };
    });
}

describe("addScientSourcesByIdentifier", () => {
  it("adds each found identifier as its own verified source and reports the rest", async () => {
    const root = await project();
    const results = await addScientSourcesByIdentifier({
      root,
      actor: "agent",
      entries: [
        "https://doi.org/10.1000/ABC.123",
        "PMID 99999999",
        "arXiv:1706.03762",
        "Lovelace 2021",
        "doi:10.1000/abc.123",
      ],
      resolveIdentifiers: registry({
        "doi:10.1000/abc.123": metadata("Measured outcomes", [
          { scheme: "doi", value: "10.1000/abc.123" },
        ]),
        "pmid:99999999": "not-found",
      }),
    });

    expect(results.map(({ input, outcome }) => [input, outcome])).toEqual([
      ["https://doi.org/10.1000/ABC.123", "imported"],
      ["PMID 99999999", "identifier-not-found"],
      ["arXiv:1706.03762", "unavailable"],
      ["Lovelace 2021", "unrecognized"],
      ["doi:10.1000/abc.123", "duplicate"],
    ]);
    expect(results[1]?.message).toBe("The PMID 99999999 does not exist at PubMed.");
    const records = await listScientSourceRecords(root);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      sourceId: results[0]?.sourceId,
      title: "Measured outcomes",
      type: "article",
      origin: { actor: "agent", intake: "identifier" },
      verification: { state: "verified", identifier: { scheme: "doi", value: "10.1000/abc.123" } },
    });
    expect(results[4]?.sourceId).toBe(records[0]?.sourceId);
  });

  it("reports an identifier already in the Library without asking its registry", async () => {
    const root = await project();
    const first = await addScientSourcesByIdentifier({
      root,
      actor: "user",
      entries: ["10.1000/abc.123", "ISBN 978-0-262-03384-8"],
      resolveIdentifiers: registry({
        "doi:10.1000/abc.123": metadata("Measured outcomes", [
          { scheme: "doi", value: "10.1000/abc.123" },
        ]),
        "isbn:9780262033848": {
          ...metadata("Introduction to Algorithms", [{ scheme: "isbn", value: "9780262033848" }]),
          type: "book",
        },
      }),
    });
    expect(first.map((item) => item.outcome)).toEqual(["imported", "imported"]);

    const resolveIdentifiers = vi.fn<ResolveSourceIdentifierBatch>(async () => []);
    const again = await addScientSourcesByIdentifier({
      root,
      actor: "agent",
      entries: ["DOI: 10.1000/ABC.123", "0-262-03384-4"],
      resolveIdentifiers,
    });

    expect(again).toMatchObject([
      { outcome: "duplicate", sourceId: first[0]?.sourceId, title: "Measured outcomes" },
      { outcome: "duplicate", sourceId: first[1]?.sourceId, title: "Introduction to Algorithms" },
    ]);
    expect(resolveIdentifiers).toHaveBeenCalledWith([]);
    await expect(listScientSourceRecords(root)).resolves.toHaveLength(2);
  });

  it("does not add a resolved work that matches an existing source's title, author and year", async () => {
    const root = await project();
    await importScientSource({
      root,
      operationId: "user_seed",
      actor: "user",
      intake: "identifier",
      candidate: {
        sourceKey: "seed",
        type: "article",
        customType: null,
        title: "Measured outcomes",
        creators: [
          { creatorType: "author", givenName: "Ada", familyName: "Lovelace", literalName: null },
        ],
        issuedRaw: "2021",
        issuedYear: 2021,
        identifiers: [],
        abstract: null,
        containerTitle: null,
        publisher: null,
        volume: null,
        issue: null,
        pages: null,
        language: null,
        url: null,
        tags: [],
        externalReferences: [],
        fieldProvenance: [],
        pdfAvailable: false,
        pdfFileName: null,
        pdfAttachmentCount: 0,
      },
    });

    const results = await addScientSourcesByIdentifier({
      root,
      actor: "agent",
      entries: ["arXiv:2101.00001"],
      resolveIdentifiers: registry({
        "arxiv:2101.00001": metadata("Measured outcomes", [
          { scheme: "arxiv", value: "2101.00001" },
        ]),
      }),
    });

    expect(results).toMatchObject([
      {
        outcome: "duplicate",
        message: "A source with the same title, first author and year is already in the Library.",
      },
    ]);
    await expect(listScientSourceRecords(root)).resolves.toHaveLength(1);
  });
});
