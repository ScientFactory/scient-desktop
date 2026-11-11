// @effect-diagnostics nodeBuiltinImport:off -- This test exercises the real project filesystem boundary.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { initializeScientProject } from "@scientfactory/project-init";
import {
  editableMetadataFromRecord,
  type ScientSourceCandidate,
} from "@scientfactory/scient-sources";
import {
  importScientSource,
  readScientSourceRecord,
  updateScientSourceMetadata,
} from "@scientfactory/scient-sources/store";
import { afterEach, describe, expect, it } from "@effect/vitest";

import { zoteroItem } from "./Zotero.testkit.ts";
import type { ZoteroRawItem } from "./ZoteroItems.ts";
import { refreshZoteroSources, sendSourcesToZotero } from "./ZoteroSync.ts";
import type { ZoteroWebHttp, ZoteroWebRequest } from "./ZoteroWebAdapter.ts";
import { zoteroPatchFor } from "./ZoteroWrite.ts";

const roots: string[] = [];
const USER = 475425;

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => NodeFSP.rm(root, { recursive: true, force: true })),
  );
});

/** An in-memory zotero.org personal library that checks versions like the real API. */
function zoteroOrg(
  options: { readonly write?: boolean; readonly groups?: Record<string, object> } = {},
) {
  const items = new Map<string, ZoteroRawItem>();
  const writes: ZoteroWebRequest[] = [];
  let version = 10;
  const keys = ["NEWA2345", "NEWB2345", "NEWC2345", "NEWD2345"];
  const json = (body: unknown, headers: Record<string, string> = {}) => ({
    status: 200,
    headers,
    body: JSON.stringify(body),
  });
  const http: ZoteroWebHttp = {
    download: async () => ({ status: 404 }),
    request: async (request) => {
      const path = request.url.pathname;
      if (path === "/keys/current") {
        return json({
          userID: USER,
          username: "ada",
          access: {
            user: { library: true, files: true, write: options.write ?? true },
            ...(options.groups ? { groups: options.groups } : {}),
          },
        });
      }
      if (path === `/users/${USER}/groups`) {
        return json([{ id: 77, data: { name: "Lab", libraryEditing: "members" } }], {
          "total-results": "1",
        });
      }
      if (request.method === "POST" && path === `/users/${USER}/items`) {
        writes.push(request);
        const successful: Record<string, { key: string; version: number }> = {};
        for (const [index, entry] of (JSON.parse(request.body ?? "[]") as object[]).entries()) {
          version += 1;
          const key = keys.shift() ?? "NEWZ2345";
          items.set(key, {
            key,
            version,
            library: { type: "user", id: USER },
            data: { ...(entry as ZoteroRawItem["data"]), key, version },
          });
          successful[String(index)] = { key, version };
        }
        return json({ successful, failed: {} });
      }
      const match = /^\/users\/\d+\/items\/([A-Z0-9]{8})(\/children)?$/u.exec(path);
      const item = match?.[1] ? items.get(match[1]) : undefined;
      if (request.method === "PATCH" && item) {
        writes.push(request);
        if (request.headers["If-Unmodified-Since-Version"] !== String(item.version)) {
          return { status: 412, headers: {}, body: "" };
        }
        version += 1;
        items.set(item.key, {
          ...item,
          version,
          data: { ...item.data, ...(JSON.parse(request.body ?? "{}") as object), version },
        });
        return { status: 204, headers: { "last-modified-version": String(version) }, body: "" };
      }
      if (match?.[2]) {
        const children = [...items.values()].filter((child) => child.data.parentItem === match[1]);
        return json(children, { "total-results": String(children.length) });
      }
      return item ? json(item) : { status: 404, headers: {}, body: "" };
    },
  };
  const editInZotero = (key: string, data: Partial<ZoteroRawItem["data"]>) => {
    const item = items.get(key);
    if (!item) throw new Error("missing");
    version += 1;
    items.set(key, { ...item, version, data: { ...item.data, ...data, version } });
  };
  return {
    items,
    writes,
    editInZotero,
    zotero: {
      webKey: async () => "synthetic-key",
      http,
      inspectLocal: async () => ({
        state: "unreachable" as const,
        apiVersion: null,
        message: "Open Zotero on the computer running this project, then check again.",
      }),
    },
  };
}

const candidate: ScientSourceCandidate = {
  sourceKey: "agent_send_test",
  type: "article",
  customType: null,
  title: "Written in Scient",
  creators: [
    { creatorType: "author", givenName: "Ada", familyName: "Lovelace", literalName: null },
  ],
  issuedRaw: "1843",
  issuedYear: 1843,
  identifiers: [
    { scheme: "doi", value: "10.1000/notes" },
    { scheme: "pmid", value: "123456" },
  ],
  abstract: null,
  containerTitle: "Scientific Memoirs",
  publisher: null,
  volume: "3",
  issue: null,
  pages: "666-731",
  language: null,
  url: null,
  tags: ["engine"],
  externalReferences: [],
  fieldProvenance: [],
  pdfAvailable: false,
  pdfFileName: null,
  pdfAttachmentCount: 0,
  note: "Read **twice**",
};

async function sourceInScient() {
  const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "scient-zotero-send-"));
  roots.push(root);
  await initializeScientProject({ root });
  const imported = await importScientSource({
    root,
    operationId: "agent_fixture",
    candidate,
    actor: "agent",
    intake: "identifier",
  });
  if (!imported.record) throw new Error("The fixture source was not added.");
  return { root, sourceId: imported.record.sourceId };
}

describe("Send to Zotero", () => {
  it("creates the item with its note and links the source to it", async () => {
    const { root, sourceId } = await sourceInScient();
    const org = zoteroOrg();

    const result = await sendSourcesToZotero({
      root,
      sourceIds: [sourceId],
      actor: "user",
      zotero: org.zotero,
    });

    expect(result.items).toEqual([
      expect.objectContaining({ outcome: "created", itemKey: "NEWA2345" }),
    ]);
    const created = org.items.get("NEWA2345")?.data;
    expect(created).toMatchObject({
      itemType: "journalArticle",
      title: "Written in Scient",
      publicationTitle: "Scientific Memoirs",
      DOI: "10.1000/notes",
      creators: [{ creatorType: "author", firstName: "Ada", lastName: "Lovelace" }],
      tags: [{ tag: "engine" }],
    });
    expect(created?.extra).toContain("PMID: 123456");
    expect(org.items.get("NEWB2345")?.data).toMatchObject({
      itemType: "note",
      parentItem: "NEWA2345",
      note: "<p>Read <strong>twice</strong></p>",
    });
    const record = await readScientSourceRecord(root, sourceId);
    expect(record?.externalReferences).toEqual([
      expect.objectContaining({ system: "zotero", libraryId: String(USER), itemKey: "NEWA2345" }),
    ]);
  });

  it("sends only what changed here, and nothing when nothing did", async () => {
    const { root, sourceId } = await sourceInScient();
    const org = zoteroOrg();
    await sendSourcesToZotero({ root, sourceIds: [sourceId], actor: "user", zotero: org.zotero });
    const record = await readScientSourceRecord(root, sourceId);
    if (!record) throw new Error("missing");
    await updateScientSourceMetadata({
      root,
      sourceId,
      expectedRevision: record.revision,
      metadata: { ...editableMetadataFromRecord(record), title: "Retitled in Scient" },
    });
    org.writes.length = 0;

    const updated = await sendSourcesToZotero({
      root,
      sourceIds: [sourceId],
      actor: "agent",
      zotero: org.zotero,
    });
    const unchanged = await sendSourcesToZotero({
      root,
      sourceIds: [sourceId],
      actor: "agent",
      zotero: org.zotero,
    });

    expect(updated.items[0]?.outcome).toBe("updated");
    expect(org.writes.map((request) => [request.method, JSON.parse(request.body ?? "{}")])).toEqual(
      [["PATCH", { title: "Retitled in Scient" }]],
    );
    expect(unchanged.items[0]?.outcome).toBe("unchanged");
  });

  it("keeps identifiers in Zotero's Extra that Scient does not have", async () => {
    const { root, sourceId } = await sourceInScient();
    const record = await readScientSourceRecord(root, sourceId);
    if (!record) throw new Error("missing");
    const extra = "PMID: 123456\nPMCID: PMC123456\narXiv: 2101.00001\nUser annotation";
    const current = zoteroItem("OLDA2345", {
      itemType: "journalArticle",
      title: "Written in Scient",
      DOI: "10.1000/notes",
      extra,
    });

    const sent = String(zoteroPatchFor({ record, current }).extra ?? extra);

    expect(sent).toContain("PMCID: PMC123456");
    expect(sent).toContain("arXiv: 2101.00001");
    expect(sent).toContain("User annotation");
  });

  it("does not overwrite an item changed in Zotero since Scient read it", async () => {
    const { root, sourceId } = await sourceInScient();
    const org = zoteroOrg();
    await sendSourcesToZotero({ root, sourceIds: [sourceId], actor: "user", zotero: org.zotero });
    org.editInZotero("NEWA2345", { title: "Edited in Zotero" });
    org.writes.length = 0;

    const result = await sendSourcesToZotero({
      root,
      sourceIds: [sourceId],
      actor: "user",
      zotero: org.zotero,
    });

    expect(result.items[0]).toMatchObject({ outcome: "changed-in-zotero" });
    expect(org.writes).toEqual([]);
    expect(org.items.get("NEWA2345")?.data.title).toBe("Edited in Zotero");

    await refreshZoteroSources({ root, actor: "user", zotero: org.zotero });
    expect((await readScientSourceRecord(root, sourceId))?.title).toBe("Edited in Zotero");
  });

  it("explains a key that can only read", async () => {
    const { root, sourceId } = await sourceInScient();
    const org = zoteroOrg({ write: false });

    await expect(
      sendSourcesToZotero({ root, sourceIds: [sourceId], actor: "user", zotero: org.zotero }),
    ).rejects.toThrow(/can only read/u);
  });

  it("refuses a group the key may only read, and writes nothing", async () => {
    const { root, sourceId } = await sourceInScient();
    const org = zoteroOrg({ groups: { "77": { library: true, write: false } } });

    await expect(
      sendSourcesToZotero({
        root,
        sourceIds: [sourceId],
        groupId: "77",
        actor: "user",
        zotero: org.zotero,
      }),
    ).rejects.toThrow(/cannot write to this group/u);
    expect(org.writes).toEqual([]);
  });
});
