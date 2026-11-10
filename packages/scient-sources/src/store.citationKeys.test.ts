// @effect-diagnostics nodeBuiltinImport:off -- Store tests exercise the real project filesystem boundary.
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { initializeScientProject } from "@scientfactory/project-init";
import { afterEach, describe, expect, it } from "@effect/vitest";

import { editableMetadataFromRecord } from "./editable.ts";
import type { ScientSourceCandidate } from "./model.ts";
import {
  decodePersistedScientSourceRecord,
  importScientSource,
  removeScientSource,
  restoreScientSource,
  updateScientSourceMetadata,
} from "./store.ts";

const fixtures: string[] = [];

afterEach(async () => {
  await Promise.all(
    fixtures.splice(0).map((root) => NodeFSP.rm(root, { recursive: true, force: true })),
  );
});

async function project(): Promise<string> {
  const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "scient-citation-keys-"));
  fixtures.push(root);
  await initializeScientProject({ root });
  return root;
}

function candidate(sourceKey: string, overrides: Partial<ScientSourceCandidate> = {}) {
  return {
    sourceKey,
    type: "article",
    customType: null,
    title: "Deep learning for proteins",
    creators: [
      { creatorType: "author", givenName: "Jane", familyName: "Smith", literalName: null },
    ],
    issuedRaw: "2020",
    issuedYear: 2020,
    identifiers: [{ scheme: "doi", value: `10.1000/${sourceKey.toLowerCase()}` }],
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
    ...overrides,
  } satisfies ScientSourceCandidate;
}

async function add(root: string, value: ScientSourceCandidate) {
  const imported = await importScientSource({
    root,
    operationId: NodeCrypto.randomUUID(),
    candidate: value,
    // Same author, year and first title word on purpose: the keys must clash.
    allowPossibleMetadataMatch: true,
  });
  if (!imported.record) throw new Error("Expected an imported record.");
  return imported.record;
}

describe("Scient source citation keys", () => {
  it("generates unique keys and keeps imported ones", async () => {
    const root = await project();
    const first = await add(root, candidate("A"));
    const second = await add(root, candidate("B"));
    const imported = await add(root, candidate("C", { citationKey: "Smith2020Deep" }));

    expect(first.citationKey).toBe("smith2020deep");
    expect(second.citationKey).toBe("smith2020deepa");
    expect(imported.citationKey).toBe("Smith2020Deepb");
  });

  it("keeps the key through edits that omit it and renames it on purpose", async () => {
    const root = await project();
    const record = await add(root, candidate("A"));
    const { citationKey: _key, ...withoutKey } = editableMetadataFromRecord(record);

    const unchanged = await updateScientSourceMetadata({
      root,
      sourceId: record.sourceId,
      expectedRevision: record.revision,
      metadata: withoutKey,
    });
    expect(unchanged.outcome).toBe("unchanged");

    const edited = await updateScientSourceMetadata({
      root,
      sourceId: record.sourceId,
      expectedRevision: record.revision,
      metadata: { ...withoutKey, title: "Shallow learning" },
    });
    expect(edited.record).toMatchObject({ citationKey: "smith2020deep", revision: 2 });

    const renamed = await updateScientSourceMetadata({
      root,
      sourceId: record.sourceId,
      expectedRevision: 2,
      actor: "agent",
      metadata: { ...editableMetadataFromRecord(edited.record), citationKey: "smith-proteins" },
    });
    expect(renamed.record.citationKey).toBe("smith-proteins");
    expect(renamed.record.fieldProvenance).toContainEqual({
      field: "citationKey",
      origin: "agent",
      sourceField: null,
    });
  });

  it("refuses a rename to another source's key or an unreadable key", async () => {
    const root = await project();
    const first = await add(root, candidate("A"));
    const second = await add(root, candidate("B", { title: "Another title" }));
    const rename = (citationKey: string) =>
      updateScientSourceMetadata({
        root,
        sourceId: second.sourceId,
        expectedRevision: second.revision,
        metadata: { ...editableMetadataFromRecord(second), citationKey },
      });

    await expect(rename(first.citationKey!.toUpperCase())).rejects.toThrow(
      "Another source already uses this citation key.",
    );
    await expect(rename("has space")).rejects.toThrow("citation key");
  });

  it("keeps keys unique when a source comes back from the trash", async () => {
    const root = await project();
    const trashed = await add(root, candidate("A"));
    await removeScientSource({ root, sourceId: trashed.sourceId, expectedRevision: 1 });
    const replacement = await add(root, candidate("B", { title: "Deep sea vents" }));
    expect(replacement.citationKey).toBe("smith2020deep");

    const restored = await restoreScientSource({ root, sourceId: trashed.sourceId });
    expect(restored.record?.citationKey).toBe("smith2020deepa");
  });

  it("still reads records written before citation keys existed", () => {
    const decoded = decodePersistedScientSourceRecord({
      formatVersion: 1,
      sourceId: "legacy",
      projectId: "project",
      revision: 1,
      type: "article",
      title: "Legacy",
      creators: [],
      issuedRaw: null,
      issuedYear: null,
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
      attachments: [],
      fieldProvenance: [],
      importedAt: "2026-01-01T00:00:00.000Z",
    });
    expect(decoded).not.toHaveProperty("citationKey");
  });
});
