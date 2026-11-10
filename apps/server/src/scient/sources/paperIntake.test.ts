// @effect-diagnostics nodeBuiltinImport:off -- Intake tests exercise the real project filesystem boundary.
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { initializeScientProject } from "@scientfactory/project-init";
import { importScientSource, listScientSourceRecords } from "@scientfactory/scient-sources/store";
import { afterEach, describe, expect, it } from "@effect/vitest";

import { addPaperToLibrary } from "./paperIntake.ts";
import {
  verifiableSourceIdentifier,
  type ResolveSourceIdentifier,
  type ResolvedSourceMetadata,
} from "./SourceIdentifierResolver.ts";

const fixtures: string[] = [];

afterEach(async () => {
  await Promise.all(
    fixtures.splice(0).map((root) => NodeFSP.rm(root, { recursive: true, force: true })),
  );
});

async function project() {
  const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "scient-paper-intake-"));
  fixtures.push(root);
  await initializeScientProject({ root });
  return root;
}

async function savedPaper(root: string, name: string, body: string) {
  await NodeFSP.mkdir(NodePath.join(root, "papers"), { recursive: true });
  await NodeFSP.writeFile(NodePath.join(root, "papers", name), `%PDF-1.7\n${body}\n`, "utf8");
  return `papers/${name}`;
}

const registryRecord: ResolvedSourceMetadata = {
  type: "article",
  title: "Array programming with NumPy",
  creators: [
    { creatorType: "author", givenName: "Charles R.", familyName: "Harris", literalName: null },
  ],
  issuedRaw: "2020-09-16",
  issuedYear: 2020,
  identifiers: [{ scheme: "doi", value: "10.1038/s41586-020-2649-2" }],
  abstract: "Array programming provides a powerful syntax.",
  abstractSections: [],
  containerTitle: "Nature",
  publisher: "Springer",
  volume: "585",
  issue: "7825",
  pages: "357-362",
  language: "en",
  url: "https://doi.org/10.1038/s41586-020-2649-2",
};

const registry =
  (answer: "found" | "not-found" | "unavailable"): ResolveSourceIdentifier =>
  async (identifiers) => {
    const identifier = verifiableSourceIdentifier(identifiers);
    if (!identifier) return null;
    return answer === "found"
      ? {
          status: "found",
          identifier,
          metadata: registryRecord,
          retrievedAt: "2026-11-10T00:00:00.000Z",
        }
      : { status: answer, identifier };
  };

const doi = "10.1038/s41586-020-2649-2";

describe("addPaperToLibrary", () => {
  it("adds a downloaded paper from its registry record, with how it was reached", async () => {
    const root = await project();
    const pdf = await savedPaper(root, "Harris-2020.pdf", "numpy");
    const result = await addPaperToLibrary({
      root,
      pdfRelativePath: pdf,
      doi,
      actor: "agent",
      retrieval: { route: "open-access", version: "accepted" },
      resolveIdentifier: registry("found"),
      fallback: { title: "A title the lookup guessed", year: 2019 },
      enrich: false,
    });

    expect(result).toMatchObject({ outcome: "added" });
    const [record] = await listScientSourceRecords(root);
    expect(record).toMatchObject({
      title: "Array programming with NumPy",
      issuedYear: 2020,
      containerTitle: "Nature",
      origin: { actor: "agent", intake: "paper" },
      verification: { state: "verified" },
      attachments: [{ retrieval: { route: "open-access", version: "accepted" } }],
    });
  });

  it("keeps the lookup's title, marked unchecked, when the registry cannot be reached", async () => {
    const root = await project();
    const pdf = await savedPaper(root, "offline.pdf", "offline");
    await addPaperToLibrary({
      root,
      pdfRelativePath: pdf,
      doi,
      actor: "user",
      resolveIdentifier: registry("unavailable"),
      fallback: { title: "Array programming with NumPy", year: 2020 },
      enrich: false,
    });

    const [record] = await listScientSourceRecords(root);
    expect(record).toMatchObject({
      title: "Array programming with NumPy",
      origin: { actor: "user", intake: "paper" },
      verification: { state: "unchecked" },
    });
    expect(record?.fieldProvenance).toContainEqual({
      field: "title",
      origin: "openalex",
      sourceField: "title",
    });
  });

  it("files the PDF on the source that already has the DOI", async () => {
    const root = await project();
    const existing = await importScientSource({
      root,
      operationId: NodeCrypto.randomUUID(),
      candidate: {
        sourceKey: "existing",
        type: "article",
        customType: null,
        title: "Array programming with NumPy",
        creators: [],
        issuedRaw: null,
        issuedYear: 2020,
        identifiers: [{ scheme: "doi", value: "https://doi.org/10.1038/S41586-020-2649-2" }],
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
      actor: "user",
      intake: "identifier",
    });
    const pdf = await savedPaper(root, "Harris-2020.pdf", "numpy");
    const ask = () =>
      addPaperToLibrary({
        root,
        pdfRelativePath: pdf,
        doi,
        actor: "agent",
        retrieval: { route: "university", version: "published" },
        resolveIdentifier: registry("found"),
        enrich: false,
      });

    expect(await ask()).toEqual({
      outcome: "attached",
      sourceId: existing.record?.sourceId,
      revision: 2,
    });
    expect(await ask()).toMatchObject({ outcome: "already-attached", revision: 2 });
    const records = await listScientSourceRecords(root);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      updatedBy: "agent",
      attachments: [{ retrieval: { route: "university", version: "published" } }],
    });
  });

  it("adds nothing when the DOI does not exist, and says why", async () => {
    const root = await project();
    const pdf = await savedPaper(root, "unknown.pdf", "unknown");
    const result = await addPaperToLibrary({
      root,
      pdfRelativePath: pdf,
      doi: "10.9999/does-not-exist",
      actor: "agent",
      resolveIdentifier: registry("not-found"),
      enrich: false,
    });

    expect(result).toMatchObject({ outcome: "not-added" });
    expect(result.outcome === "not-added" && result.message).toContain("does not exist");
    expect(await listScientSourceRecords(root)).toEqual([]);
  });
});
