// @effect-diagnostics nodeBuiltinImport:off -- Agent add tests exercise the real project filesystem boundary.
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { initializeScientProject } from "@scientfactory/project-init";
import type { ScientSourceCandidate } from "@scientfactory/scient-sources";
import {
  listScientSourceRecords,
  readScientSourceStagedMaterial,
  SCIENT_SOURCE_OPERATIONS_DIRECTORY,
  stagedScientSourcePdfAbsolutePath,
} from "@scientfactory/scient-sources/store";
import { afterEach, describe, expect, it } from "@effect/vitest";

import {
  addAgentSource,
  attachSourcePdf,
  advanceSourceImport,
  beginLocalPdfImport,
  retrySourceImport,
  uploadLocalPdfSource,
} from "./ScientSourcesCoordinator.ts";

const fixtures: string[] = [];

afterEach(async () => {
  await Promise.all(
    fixtures.splice(0).map((root) => NodeFSP.rm(root, { recursive: true, force: true })),
  );
});

async function project(): Promise<string> {
  const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "scient-source-agent-add-"));
  fixtures.push(root);
  await initializeScientProject({ root });
  return root;
}

function candidate(sourceKey: string, doi: string): ScientSourceCandidate {
  return {
    sourceKey,
    type: "article",
    customType: null,
    title: "Agent added article",
    creators: [
      { creatorType: "author", givenName: "Ada", familyName: "Lovelace", literalName: null },
    ],
    issuedRaw: "2026",
    issuedYear: 2026,
    identifiers: [{ scheme: "doi", value: doi }],
    abstract: null,
    containerTitle: "Journal",
    publisher: null,
    volume: null,
    issue: null,
    pages: null,
    language: "en",
    url: null,
    tags: [],
    externalReferences: [],
    fieldProvenance: [],
    pdfAvailable: false,
    pdfFileName: null,
    pdfAttachmentCount: 0,
  };
}

describe("agent identifier add", () => {
  it("imports a metadata-only agent source as pending review without a durable import operation file", async () => {
    const root = await project();
    const added = await addAgentSource({
      root,
      candidate: candidate("AGENT1", "10.1000/agent-one"),
    });

    expect(added).toMatchObject({
      outcome: "imported",
      record: {
        origin: {
          actor: "agent",
          intake: "identifier",
          review: "pending",
        },
        attachments: [],
      },
    });
    expect(added.record?.origin?.operationId).toMatch(/^agent_/);
    const operationsDirectory = NodePath.join(root, SCIENT_SOURCE_OPERATIONS_DIRECTORY);
    await expect(NodeFSP.readdir(operationsDirectory)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("treats a repeated add of the same source key as an idempotent duplicate", async () => {
    const root = await project();
    const first = await addAgentSource({
      root,
      candidate: candidate("AGENT1", "10.1000/agent-repeat"),
    });
    const second = await addAgentSource({
      root,
      candidate: candidate("AGENT1", "10.1000/agent-repeat"),
    });

    expect(first.outcome).toBe("imported");
    expect(first.record?.sourceId).toBeTruthy();
    expect(second.outcome).toBe("duplicate");
    expect(second.record).toBeNull();
    expect(second.duplicate.matchingSourceIds).toEqual([first.record?.sourceId]);
    await expect(listScientSourceRecords(root)).resolves.toHaveLength(1);
  });

  it("copies a project PDF into canonical storage when an agent adds metadata", async () => {
    const root = await project();
    const pdfPath = NodePath.join(root, "papers", "original-name.pdf");
    await NodeFSP.mkdir(NodePath.dirname(pdfPath), { recursive: true });
    await NodeFSP.writeFile(pdfPath, "%PDF-1.7\nagent attachment\n", "utf8");

    const added = await addAgentSource({
      root,
      candidate: candidate("AGENTPDF", "10.1000/agent-pdf"),
      pdfPath,
      pdfFileName: "original-name.pdf",
    });

    expect(added).toMatchObject({
      outcome: "imported",
      record: {
        origin: { actor: "agent", intake: "local-pdf", review: "pending" },
        attachments: [{ fileName: "original-name.pdf", mediaType: "application/pdf" }],
      },
    });
    const attachment = added.record?.attachments[0];
    expect(attachment).toBeDefined();
    if (!attachment) return;
    await expect(
      NodeFSP.readFile(NodePath.join(root, ".scient", "sources", attachment.relativePath), "utf8"),
    ).resolves.toBe("%PDF-1.7\nagent attachment\n");
  });

  it("attaches a PDF to a pending metadata-only agent source with revision protection", async () => {
    const root = await project();
    const added = await addAgentSource({
      root,
      candidate: candidate("AGENTATTACH", "10.1000/agent-attach"),
    });
    const sourceId = added.record?.sourceId;
    const revision = added.record?.revision;
    expect(sourceId).toBeTruthy();
    expect(revision).toBe(1);
    if (!sourceId || revision === undefined) return;

    const pdfPath = NodePath.join(root, "ledger", "paper.pdf");
    await NodeFSP.mkdir(NodePath.dirname(pdfPath), { recursive: true });
    await NodeFSP.writeFile(pdfPath, "%PDF-1.7\nlater attachment\n", "utf8");

    const stale = await attachSourcePdf({
      root,
      sourceId,
      expectedRevision: revision + 1,
      pdfPath,
      fileName: "paper.pdf",
    });
    expect(stale.outcome).toBe("stale");

    const attached = await attachSourcePdf({
      root,
      sourceId,
      expectedRevision: revision,
      pdfPath,
      fileName: "paper.pdf",
    });
    expect(attached).toMatchObject({
      outcome: "attached",
      record: { revision: 2, attachments: [{ fileName: "paper.pdf" }] },
    });
    const repeated = await attachSourcePdf({
      root,
      sourceId,
      expectedRevision: 2,
      pdfPath,
      fileName: "paper.pdf",
    });
    expect(repeated.outcome).toBe("unchanged");
  });

  it("does not create a second record for the same DOI under a different source key", async () => {
    const root = await project();
    await addAgentSource({
      root,
      candidate: candidate("AGENT1", "10.1000/agent-doi"),
    });
    const second = await addAgentSource({
      root,
      candidate: candidate("AGENT2", "10.1000/agent-doi"),
    });

    expect(second).toMatchObject({
      outcome: "duplicate",
      duplicate: { kind: "same-identifier" },
    });
    await expect(listScientSourceRecords(root)).resolves.toHaveLength(1);
  });

  it("can add a metadata source while a failed local import is waiting for retry", async () => {
    const root = await project();
    const pdfPath = NodePath.join(root, "waiting.pdf");
    await NodeFSP.writeFile(pdfPath, "%PDF-1.7\nwaiting\n", "utf8");
    const uploaded = await uploadLocalPdfSource({
      root,
      sourcePath: pdfPath,
      fileName: "waiting.pdf",
    });
    const material = await readScientSourceStagedMaterial(root, uploaded.item.candidate.sourceKey);
    await NodeFSP.writeFile(
      await stagedScientSourcePdfAbsolutePath(root, material),
      "%PDF-1.7\nchanged\n",
      "utf8",
    );
    const operationId = NodeCrypto.randomUUID();
    await beginLocalPdfImport({
      root,
      operationId,
      itemKeys: [uploaded.item.candidate.sourceKey],
      possibleMetadataMatchOverrides: [],
    });
    const failed = await advanceSourceImport({ root, operationId });
    expect(failed.items[0]?.state).toBe("failed");

    const added = await addAgentSource({
      root,
      candidate: candidate("AGENTWAIT", "10.1000/agent-wait"),
    });
    expect(added.outcome).toBe("imported");

    await NodeFSP.writeFile(
      await stagedScientSourcePdfAbsolutePath(
        root,
        await readScientSourceStagedMaterial(root, uploaded.item.candidate.sourceKey),
      ),
      "%PDF-1.7\nwaiting\n",
      "utf8",
    );
    await retrySourceImport({
      root,
      operationId,
      itemKeys: [uploaded.item.candidate.sourceKey],
    });
    const completed = await advanceSourceImport({ root, operationId });
    expect(completed).toMatchObject({
      state: "completed",
      items: [{ state: "imported" }],
    });
    await expect(listScientSourceRecords(root)).resolves.toHaveLength(2);
  });
});
