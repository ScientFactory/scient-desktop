// @effect-diagnostics nodeBuiltinImport:off -- Tests exercise the real project filesystem boundary.
// @effect-diagnostics globalDate:off -- Fixed Date values make check timestamps deterministic.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { initializeScientProject } from "@scientfactory/project-init";
import {
  editableMetadataFromRecord,
  type ScientSourceCandidate,
} from "@scientfactory/scient-sources";
import {
  readScientSourceRecord,
  updateScientSourceMetadata,
} from "@scientfactory/scient-sources/store";
import { afterEach, describe, expect, it } from "@effect/vitest";

import type { MetadataRequest } from "./metadataHttp.ts";
import { addAgentSource, checkSourceIdentifier } from "./ScientSourcesCoordinator.ts";
import {
  resolveSourceIdentifier,
  verifiableSourceIdentifier,
  type ResolveSourceIdentifier,
} from "./SourceIdentifierResolver.ts";

const fixtures: string[] = [];
afterEach(async () => {
  await Promise.all(
    fixtures.splice(0).map((root) => NodeFSP.rm(root, { recursive: true, force: true })),
  );
});

// doi.org CSL-JSON for 10.1016/S0140-6736(97)11096-0, trimmed, as recorded on 2026-11-10.
const RETRACTED_CSL = {
  type: "journal-article",
  title:
    "RETRACTED: Ileal-lymphoid-nodular hyperplasia, non-specific colitis, and pervasive developmental disorder in children",
  author: [
    { given: "AJ", family: "Wakefield", sequence: "first" },
    { given: "SH", family: "Murch", sequence: "additional" },
  ],
  issued: { "date-parts": [[1998, 2]] },
  DOI: "10.1016/s0140-6736(97)11096-0",
  "container-title": "The Lancet",
  volume: "351",
  issue: "9103",
  page: "637-641",
  "updated-by": [
    {
      DOI: "10.1016/s0140-6736(04)15715-2",
      type: "correction",
      label: "Correction",
      source: "retraction-watch",
      updated: { "date-parts": [[2004, 3, 6]], "date-time": "2004-03-06T00:00:00Z" },
      "record-id": "17269",
    },
    {
      DOI: "10.1016/s0140-6736(10)60175-4",
      type: "retraction",
      label: "Retraction",
      source: "retraction-watch",
      updated: { "date-parts": [[2010, 2, 6]], "date-time": "2010-02-06T00:00:00Z" },
      "record-id": "4036",
    },
    { type: "new_version" },
    "not an object",
  ],
};

const now = () => new Date("2026-11-10T12:00:00.000Z");
const doi = [{ scheme: "doi", value: "10.1016/S0140-6736(97)11096-0" }];

const respond =
  (status: number, body: unknown): MetadataRequest =>
  async (url) => ({ status, body: JSON.stringify(body), url });

const lookupWith =
  (request: MetadataRequest): ResolveSourceIdentifier =>
  (identifiers) =>
    resolveSourceIdentifier(identifiers, { request, now });

const unavailable: ResolveSourceIdentifier = async (identifiers) => {
  const identifier = verifiableSourceIdentifier(identifiers);
  return identifier ? { status: "unavailable", identifier } : null;
};

async function project(): Promise<string> {
  const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "scient-source-editorial-"));
  fixtures.push(root);
  await initializeScientProject({ root });
  return root;
}

const candidate: ScientSourceCandidate = {
  sourceKey: "editorial",
  type: "other",
  customType: null,
  title: null,
  creators: [],
  issuedRaw: null,
  issuedYear: null,
  identifiers: doi,
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

describe("retraction and correction status", () => {
  it("reads Crossref's update notices from doi.org metadata", async () => {
    const resolution = await resolveSourceIdentifier(doi, {
      request: respond(200, RETRACTED_CSL),
      now,
    });
    if (resolution?.status !== "found") throw new Error("Expected a found DOI.");
    expect(resolution.metadata.editorialNotices).toEqual([
      {
        kind: "correction",
        doi: "10.1016/s0140-6736(04)15715-2",
        date: "2004-03-06",
        source: "retraction-watch",
      },
      {
        kind: "retraction",
        doi: "10.1016/s0140-6736(10)60175-4",
        date: "2010-02-06",
        source: "retraction-watch",
      },
    ]);
  });

  it("reads PubMed's retracted-publication type", async () => {
    const resolution = await resolveSourceIdentifier([{ scheme: "pmid", value: "9500320" }], {
      request: respond(200, {
        result: {
          uids: ["9500320"],
          "9500320": {
            title: "Ileal-lymphoid-nodular hyperplasia",
            pubtype: ["Journal Article", "Retracted Publication"],
          },
        },
      }),
      now,
    });
    if (resolution?.status !== "found") throw new Error("Expected a found PMID.");
    expect(resolution.metadata.editorialNotices).toEqual([
      { kind: "retraction", source: "pubmed" },
    ]);
  });

  it("stores the status on an add and keeps it current on each check", async () => {
    const root = await project();
    const added = await addAgentSource({
      root,
      candidate,
      resolveIdentifier: lookupWith(respond(200, RETRACTED_CSL)),
      actor: "user",
      intake: "identifier",
    });
    if (added.outcome !== "imported" || !added.record) throw new Error("Expected an import.");
    expect(added.record).toMatchObject({
      origin: { actor: "user" },
      verification: { state: "verified" },
      editorialStatus: { state: "retracted", checkedAt: "2026-11-10T12:00:00.000Z" },
    });
    const sourceId = added.record.sourceId;

    // The same answer again writes no revision.
    await expect(
      checkSourceIdentifier({
        root,
        sourceId,
        actor: "agent",
        resolveIdentifier: lookupWith(respond(200, RETRACTED_CSL)),
      }),
    ).resolves.toMatchObject({ outcome: "unchanged", registry: "found", record: { revision: 1 } });

    // An unreachable registry keeps the earlier verdict for the same identifier.
    await expect(
      checkSourceIdentifier({ root, sourceId, actor: "agent", resolveIdentifier: unavailable }),
    ).resolves.toMatchObject({ outcome: "unchanged", registry: "unavailable" });

    const { "updated-by": _notices, ...cleared } = RETRACTED_CSL;
    await expect(
      checkSourceIdentifier({
        root,
        sourceId,
        actor: "agent",
        resolveIdentifier: lookupWith(respond(200, cleared)),
      }),
    ).resolves.toMatchObject({
      outcome: "updated",
      record: { revision: 2, updatedBy: "agent", editorialStatus: { state: "none", notices: [] } },
    });

    await expect(
      checkSourceIdentifier({
        root,
        sourceId,
        actor: "user",
        resolveIdentifier: lookupWith(respond(404, "")),
      }),
    ).resolves.toMatchObject({
      registry: "not-found",
      record: { verification: { state: "unverified", problem: "not-found" } },
    });
    expect((await readScientSourceRecord(root, sourceId))?.editorialStatus).toBeUndefined();
  });

  it("flags an identifier that now names a different work, and clears status on identifier edits", async () => {
    const root = await project();
    const added = await addAgentSource({
      root,
      candidate,
      resolveIdentifier: lookupWith(respond(200, RETRACTED_CSL)),
    });
    if (added.outcome !== "imported" || !added.record) throw new Error("Expected an import.");
    const other = { ...RETRACTED_CSL, title: "Quantum error correction with surface codes" };
    const mismatch = await checkSourceIdentifier({
      root,
      sourceId: added.record.sourceId,
      actor: "agent",
      resolveIdentifier: lookupWith(respond(200, other)),
    });
    expect(mismatch).toMatchObject({
      registry: "mismatch",
      record: { verification: { state: "unverified", problem: "mismatch" } },
    });
    expect(mismatch.record.editorialStatus).toBeUndefined();

    const verified = await checkSourceIdentifier({
      root,
      sourceId: added.record.sourceId,
      actor: "agent",
      resolveIdentifier: lookupWith(respond(200, RETRACTED_CSL)),
    });
    expect(verified.record.editorialStatus?.state).toBe("retracted");
    const edited = await updateScientSourceMetadata({
      root,
      sourceId: added.record.sourceId,
      expectedRevision: verified.record.revision,
      metadata: {
        ...editableMetadataFromRecord(verified.record),
        identifiers: [{ scheme: "doi", value: "10.1000/another" }],
      },
    });
    expect(edited.record).not.toHaveProperty("editorialStatus");
    expect(edited.record).not.toHaveProperty("verification");
  });
});
