// @effect-diagnostics nodeBuiltinImport:off -- Citation tests exercise real project files.
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { initializeScientProject } from "@scientfactory/project-init";
import {
  editableMetadataFromRecord,
  type ScientSourceCandidate,
  type ScientSourceRecord,
} from "@scientfactory/scient-sources";
import { importScientSource, readScientSourceRecord } from "@scientfactory/scient-sources/store";
import { afterEach, describe, expect, it } from "@effect/vitest";

import { citeLibrarySources } from "./LibraryCitation.ts";
import { updateScientSource } from "./ScientSourcesCoordinator.ts";

const fixtures: string[] = [];

afterEach(async () => {
  await Promise.all(
    fixtures.splice(0).map((root) => NodeFSP.rm(root, { recursive: true, force: true })),
  );
});

async function project(): Promise<string> {
  const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "scient-cite-"));
  fixtures.push(root);
  await initializeScientProject({ root });
  return root;
}

function candidate(
  sourceKey: string,
  title: string,
  identifiers: ScientSourceCandidate["identifiers"],
): ScientSourceCandidate {
  return {
    sourceKey,
    type: "article",
    customType: null,
    title,
    creators: [
      { creatorType: "author", givenName: "Ada", familyName: "Lovelace", literalName: null },
    ],
    issuedRaw: "1843",
    issuedYear: 1843,
    identifiers,
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
  };
}

async function add(root: string, value: ScientSourceCandidate): Promise<ScientSourceRecord> {
  const imported = await importScientSource({
    root,
    operationId: NodeCrypto.randomUUID(),
    candidate: value,
  });
  if (!imported.record) throw new Error("Expected an imported record.");
  return imported.record;
}

describe("citing Library sources", () => {
  it("returns the citation and reports problems without withholding it", async () => {
    const root = await project();
    const missing = await add(
      root,
      candidate("A", "Notes on the engine", [{ scheme: "doi", value: "10.1000/missing" }]),
    );
    await add(root, candidate("B", "Sketch of the engine", []));

    const result = await citeLibrarySources(
      { root, sources: [missing.sourceId, "LOVELACE1843SKETCH", "nobody2000"], format: "markdown" },
      {
        resolveIdentifiers: async (identifiers) =>
          identifiers.map((identifier) => ({ status: "not-found", identifier })),
      },
    );

    expect(result.citation).toBe("[@lovelace1843notes; @lovelace1843sketch]");
    expect(result.notFound).toEqual(["nobody2000"]);
    expect(result.bibliography).toBe("current");
    expect(result.sources[0]).toMatchObject({
      citationKey: "lovelace1843notes",
      status: "problem",
    });
    expect(result.sources[0]?.problems.map((problem) => problem.kind)).toContain(
      "identifier-not-found",
    );
    expect(result.sources[1]?.problems.map((problem) => problem.kind)).toEqual(["no-identifier"]);

    const latex = await citeLibrarySources(
      { root, sources: [missing.sourceId], format: "latex" },
      {
        resolveIdentifiers: async (identifiers) =>
          identifiers.map((identifier) => ({ status: "unavailable", identifier })),
      },
    );
    expect(latex.citation).toBe("\\cite{lovelace1843notes}");
    expect(latex.sources[0]?.problems.map((problem) => problem.kind)).toEqual(["not-checked"]);
  });

  it("carries a deliberate key rename into the project's documents", async () => {
    const root = await project();
    const record = await add(root, candidate("A", "Notes on the engine", []));
    await NodeFSP.mkdir(NodePath.join(root, "chapters"));
    await NodeFSP.writeFile(NodePath.join(root, "paper.md"), "As [@lovelace1843notes] shows.\n");
    await NodeFSP.writeFile(
      NodePath.join(root, "chapters", "one.tex"),
      "See \\cite{lovelace1843notes,other}.\n",
    );
    await NodeFSP.writeFile(NodePath.join(root, "untouched.md"), "No citations here.\n");

    const result = await updateScientSource({
      root,
      sourceId: record.sourceId,
      expectedRevision: record.revision,
      metadata: { ...editableMetadataFromRecord(record), citationKey: "ada-notes" },
    });

    expect(result.outcome).toBe("updated");
    expect(result.citationKeyRenamedIn).toEqual(["paper.md", "chapters/one.tex"]);
    expect(await NodeFSP.readFile(NodePath.join(root, "paper.md"), "utf8")).toBe(
      "As [@ada-notes] shows.\n",
    );
    expect(await NodeFSP.readFile(NodePath.join(root, "chapters", "one.tex"), "utf8")).toBe(
      "See \\cite{ada-notes,other}.\n",
    );
    expect((await readScientSourceRecord(root, record.sourceId))?.citationKey).toBe("ada-notes");
  });
});
