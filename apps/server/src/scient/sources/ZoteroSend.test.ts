// @effect-diagnostics nodeBuiltinImport:off -- This test exercises the real project filesystem boundary.
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { initializeScientProject } from "@scientfactory/project-init";
import {
  editableMetadataFromRecord,
  type ScientSourceCandidate,
} from "@scientfactory/scient-sources";
import {
  attachScientSourcePdf,
  importScientSource,
  readScientSourceRecord,
  readScientSourceZoteroSync,
  updateScientSourceMetadata,
  updateScientSourceNote,
  writeScientSourceZoteroSync,
} from "@scientfactory/scient-sources/store";
import { afterEach, describe, expect, it } from "@effect/vitest";
import { vi } from "vite-plus/test";

import { fakeZoteroTransport, zoteroItem } from "./Zotero.testkit.ts";
import type { ZoteroAccess } from "./ZoteroConnections.ts";
import type { ZoteroRawItem } from "./ZoteroItems.ts";
import { refreshZoteroSources, sendSourcesToZotero } from "./ZoteroSync.ts";
import type { ZoteroWebHttp, ZoteroWebRequest } from "./ZoteroWebAdapter.ts";
import { zoteroPatchFor } from "./ZoteroWrite.ts";

const roots: string[] = [];
const USER = 475425;

/** Runs once as the next base is read, before that read is answered. */
const baseRead = vi.hoisted(() => ({ next: null as null | (() => Promise<void>) }));
vi.mock("@scientfactory/scient-sources/store", async (importOriginal) => {
  const store = await importOriginal<typeof import("@scientfactory/scient-sources/store")>();
  return {
    ...store,
    readScientSourceZoteroSync: async (
      ...args: Parameters<typeof store.readScientSourceZoteroSync>
    ) => {
      const read = store.readScientSourceZoteroSync(...args);
      const meanwhile = baseRead.next;
      baseRead.next = null;
      const answer = await read;
      await meanwhile?.();
      return answer;
    },
  };
});

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => NodeFSP.rm(root, { recursive: true, force: true })),
  );
});

/** An in-memory zotero.org personal library that checks versions like the real API. */
/** What zotero.org says each item type accepts, for the types these tests send. */
const TEMPLATES: Readonly<
  Record<string, { readonly fields: ReadonlyArray<string>; readonly roles: ReadonlyArray<string> }>
> = {
  book: {
    fields: [
      "title",
      "abstractNote",
      "series",
      "seriesNumber",
      "volume",
      "numberOfVolumes",
      "edition",
      "place",
      "publisher",
      "date",
      "numPages",
      "language",
      "ISBN",
      "shortTitle",
      "url",
      "accessDate",
      "extra",
    ],
    roles: ["author", "contributor", "editor", "seriesEditor", "translator"],
  },
  case: {
    fields: [
      "caseName",
      "abstractNote",
      "court",
      "dateDecided",
      "docketNumber",
      "reporter",
      "reporterVolume",
      "firstPage",
      "history",
      "language",
      "url",
      "extra",
    ],
    roles: ["author", "counsel", "contributor"],
  },
  presentation: {
    fields: [
      "title",
      "abstractNote",
      "presentationType",
      "date",
      "place",
      "meetingName",
      "url",
      "extra",
    ],
    roles: ["presenter", "contributor"],
  },
  computerProgram: {
    fields: [
      "title",
      "abstractNote",
      "versionNumber",
      "date",
      "system",
      "place",
      "company",
      "programmingLanguage",
      "ISBN",
      "url",
      "rights",
      "extra",
    ],
    roles: ["programmer", "contributor"],
  },
};

function zoteroOrg(
  options: {
    readonly write?: boolean;
    readonly groups?: Record<string, object>;
    readonly groupId?: string;
    /** False: zotero.org does not say what a type accepts, as before these were asked for. */
    readonly templates?: boolean;
    /** False: the key has no file access. */
    readonly files?: boolean;
    /** Bytes the storage holds before it is full. */
    readonly quota?: number;
    /** How many uploads to the storage fail before one goes through. */
    readonly storageFailures?: number;
    /** How many reads of an item fail before one goes through. */
    readonly readFailures?: number;
  } = {},
) {
  const libraryPath = options.groupId ? `/groups/${options.groupId}` : `/users/${USER}`;
  const items = new Map<string, ZoteroRawItem>();
  const writes: ZoteroWebRequest[] = [];
  const requests: ZoteroWebRequest[] = [];
  let version = 10;
  let keyCount = 0;
  const nextKey = () => `NEW${"ABCDEFGHIJKLMNOP"[keyCount++] ?? "Z"}2345`;
  const md5 = (bytes: Buffer) => NodeCrypto.createHash("md5").update(bytes).digest("hex");
  // Zotero's file storage, by MD5, and the uploads it has authorised.
  const stored = new Map<string, Buffer>();
  const authorised = new Map<string, { readonly md5: string; readonly filename: string }>();
  let storageFailures = options.storageFailures ?? 0;
  let readFailures = options.readFailures ?? 0;
  const usedTokens = new Set<string>();
  const json = (body: unknown, headers: Record<string, string> = {}) => ({
    status: 200,
    headers,
    body: JSON.stringify(body),
  });
  const empty = (status: number) => ({ status, headers: {}, body: "" });
  const http: ZoteroWebHttp = {
    download: async () => ({ status: 404 }),
    upload: async (url, contentType, body) => {
      if (url.protocol !== "https:" || !contentType.startsWith("multipart/form-data")) return 400;
      if (body.prefix !== "--b\r\n" || body.suffix !== "\r\n--b--") return 400;
      if (storageFailures-- > 0) return 500;
      const bytes = await NodeFSP.readFile(body.path);
      stored.set(md5(bytes), bytes);
      return 201;
    },
    request: async (request) => {
      requests.push(request);
      const path = request.url.pathname;
      if (path === "/keys/current") {
        return json({
          userID: USER,
          username: "ada",
          access: {
            user: { library: true, files: options.files ?? true, write: options.write ?? true },
            ...(options.groups ? { groups: options.groups } : {}),
          },
        });
      }
      const asked = TEMPLATES[request.url.searchParams.get("itemType") ?? ""];
      if (options.templates !== false && asked && path === "/items/new") {
        return json(
          Object.fromEntries([
            ["itemType", request.url.searchParams.get("itemType")],
            ...asked.fields.map((field) => [field, ""]),
            ["creators", []],
            ["tags", []],
          ]),
        );
      }
      if (options.templates !== false && asked && path === "/itemTypeCreatorTypes") {
        return json(asked.roles.map((creatorType) => ({ creatorType, localized: creatorType })));
      }
      if (path === `/users/${USER}/groups`) {
        return json([{ id: 77, data: { name: "Lab", libraryEditing: "members" } }], {
          "total-results": "1",
        });
      }
      if (request.method === "POST" && path === `${libraryPath}/items`) {
        writes.push(request);
        const token = request.headers["Zotero-Write-Token"];
        if (token && usedTokens.has(token)) {
          return { status: 412, headers: {}, body: "Write token already used" };
        }
        if (token) usedTokens.add(token);
        const successful: Record<string, ZoteroRawItem> = {};
        for (const [index, entry] of (JSON.parse(request.body ?? "[]") as object[]).entries()) {
          version += 1;
          const key = nextKey();
          const createdItem: ZoteroRawItem = {
            key,
            version,
            library: options.groupId
              ? { type: "group", id: Number(options.groupId) }
              : { type: "user", id: USER },
            data: { ...(entry as ZoteroRawItem["data"]), key, version },
          };
          items.set(key, createdItem);
          successful[String(index)] = createdItem;
        }
        return json({ successful, failed: {} });
      }
      const file = /^\/(?:users|groups)\/\d+\/items\/([A-Z0-9]{8})\/file$/u.exec(path);
      const attachment = file?.[1] ? items.get(file[1]) : undefined;
      if (request.method === "POST" && attachment) {
        if (request.headers["If-None-Match"] !== "*") return empty(428);
        if (options.files === false) return empty(403);
        const form = new URLSearchParams(request.body ?? "");
        const fill = (hash: string, filename: string) => {
          version += 1;
          items.set(attachment.key, {
            ...attachment,
            version,
            data: { ...attachment.data, md5: hash, filename, version } as ZoteroRawItem["data"],
          });
        };
        const upload = authorised.get(form.get("upload") ?? "");
        if (upload) {
          // Zotero checks that the bytes it was sent are the ones it was told of.
          if (!stored.has(upload.md5)) return empty(400);
          fill(upload.md5, upload.filename);
          return empty(204);
        }
        const hash = form.get("md5") ?? "";
        const filename = form.get("filename") ?? "";
        if (stored.has(hash)) {
          fill(hash, filename);
          return json({ exists: 1 });
        }
        const used = [...stored.values()].reduce((sum, bytes) => sum + bytes.length, 0);
        if (used + Number(form.get("filesize")) > (options.quota ?? Infinity)) return empty(413);
        const uploadKey = `upload${authorised.size + 1}`;
        authorised.set(uploadKey, { md5: hash, filename });
        return json({
          url: "https://storage.example/zotero",
          contentType: "multipart/form-data; boundary=b",
          prefix: "--b\r\n",
          suffix: "\r\n--b--",
          uploadKey,
        });
      }
      const versioned = { "last-modified-version": String(version) };
      if (request.method === "GET" && path === `${libraryPath}/items`) {
        const query = request.url.searchParams;
        const since = query.get("since");
        const all = [...items.values()];
        if (query.get("format") === "versions" && since !== null) {
          return json(
            Object.fromEntries(
              all
                .filter((entry) => entry.version > Number(since))
                .map((entry) => [entry.key, entry.version]),
            ),
            versioned,
          );
        }
        const keys = query.get("itemKey")?.split(",");
        const listed = keys
          ? all.filter((entry) => keys.includes(entry.key))
          : all.slice(0, Number(query.get("limit") ?? 100));
        return json(listed, { ...versioned, "total-results": String(listed.length) });
      }
      if (request.method === "GET" && path === `${libraryPath}/deleted`) {
        return json(
          { collections: [], searches: [], items: [], tags: [], settings: [] },
          versioned,
        );
      }
      const match = /^\/(?:users|groups)\/\d+\/items\/([A-Z0-9]{8})(\/children)?$/u.exec(path);
      const item = match?.[1] ? items.get(match[1]) : undefined;
      if (request.method === "DELETE" && item) {
        if (request.headers["If-Unmodified-Since-Version"] !== String(item.version)) {
          return empty(412);
        }
        items.delete(item.key);
        return empty(204);
      }
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
      if (item && readFailures-- > 0) return empty(500);
      return item ? json(item) : { status: 404, headers: {}, body: "" };
    },
  };
  const editInZotero = (key: string, data: Partial<ZoteroRawItem["data"]>) => {
    const item = items.get(key);
    if (!item) throw new Error("missing");
    version += 1;
    items.set(key, { ...item, version, data: { ...item.data, ...data, version } });
  };
  const addInZotero = (item: ZoteroRawItem) => {
    version += 1;
    items.set(item.key, { ...item, version, data: { ...item.data, version } });
  };
  return {
    items,
    stored,
    writes,
    requests,
    editInZotero,
    addInZotero,
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

async function sourceInScient(fields: Partial<ScientSourceCandidate> = {}) {
  const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "scient-zotero-send-"));
  roots.push(root);
  await initializeScientProject({ root });
  const imported = await importScientSource({
    root,
    operationId: "agent_fixture",
    candidate: { ...candidate, ...fields },
    actor: "agent",
    intake: "identifier",
  });
  if (!imported.record) throw new Error("The fixture source was not added.");
  return { root, sourceId: imported.record.sourceId };
}

async function editHere(root: string, sourceId: string, change: { readonly title: string }) {
  const record = await readScientSourceRecord(root, sourceId);
  if (!record) throw new Error("missing");
  await updateScientSourceMetadata({
    root,
    sourceId,
    expectedRevision: record.revision,
    metadata: { ...editableMetadataFromRecord(record), ...change },
  });
}

/** A source in Scient with one PDF, "paper.pdf", whose bytes carry `text`. */
async function sourceWithPdf(text: string) {
  const { root, sourceId } = await sourceInScient();
  const pdfPath = NodePath.join(root, "incoming.pdf");
  await NodeFSP.writeFile(pdfPath, `%PDF-1.4\n% ${text}\n%%EOF\n`);
  const record = await readScientSourceRecord(root, sourceId);
  const attached = await attachScientSourcePdf({
    root,
    sourceId,
    expectedRevision: record!.revision,
    pdfPath,
    fileName: "paper.pdf",
    actor: "user",
  });
  if (attached.outcome !== "attached") throw new Error("The fixture PDF was not attached.");
  return { root, sourceId };
}

const sendWithPdfs = (
  source: { readonly root: string; readonly sourceId: string },
  org: { readonly zotero: ZoteroAccess },
) =>
  sendSourcesToZotero({
    root: source.root,
    sourceIds: [source.sourceId],
    pdfs: true,
    actor: "user",
    zotero: org.zotero,
  });

const attachmentsIn = (org: { readonly items: ReadonlyMap<string, ZoteroRawItem> }) =>
  [...org.items.values()]
    .filter((item) => item.data.itemType === "attachment")
    .map(({ data }) => ({
      parentItem: data.parentItem,
      filename: data.filename,
      md5: "md5" in data && typeof data.md5 === "string" ? data.md5 : null,
    }));

/** `org`'s zotero.org, running `after` once each request has its answer. */
const afterEachRequest = (
  org: { readonly zotero: ZoteroAccess & { readonly http: ZoteroWebHttp } },
  after: (request: ZoteroWebRequest) => Promise<void> | void,
): ZoteroAccess => ({
  ...org.zotero,
  http: {
    ...org.zotero.http,
    request: async (request) => {
      const response = await org.zotero.http.request(request);
      await after(request);
      return response;
    },
  },
});

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

  it.each([
    { libraryId: String(USER + 1), kind: "another personal owner" },
    { libraryId: "groups/77", kind: "a group" },
  ])(
    "creates in My Library without reading or replacing a link to $kind",
    async ({ libraryId }) => {
      const oldReference = {
        system: "zotero",
        libraryId,
        itemKey: "SAME2345",
        itemVersion: 10,
        rawItemType: "journalArticle",
      };
      const { root, sourceId } = await sourceInScient({ externalReferences: [oldReference] });
      const before = await readScientSourceRecord(root, sourceId);
      if (!before) throw new Error("The fixture source was not added.");
      await writeScientSourceZoteroSync(root, {
        formatVersion: 1,
        sourceId,
        libraryId,
        annotationLibraryId: libraryId.startsWith("groups/") ? libraryId : "0",
        itemKey: oldReference.itemKey,
        itemVersion: oldReference.itemVersion,
        syncedAt: "2026-11-15T10:00:00.000Z",
        metadata: editableMetadataFromRecord(before),
        note: null,
        attachmentKeys: [],
      });
      const org = zoteroOrg();
      const unrelated = zoteroItem("SAME2345", { version: 10, title: "Unrelated work" }, USER);
      org.items.set(unrelated.key, unrelated);

      const result = await sendSourcesToZotero({
        root,
        sourceIds: [sourceId],
        actor: "user",
        zotero: org.zotero,
      });

      expect(result.items[0]).toMatchObject({ outcome: "created", itemKey: "NEWA2345" });
      expect(org.items.get(unrelated.key)).toEqual(unrelated);
      expect(
        org.requests.filter((request) => request.url.pathname.includes(`/items/${unrelated.key}`)),
      ).toEqual([]);
      expect((await readScientSourceRecord(root, sourceId))?.externalReferences).toEqual([
        expect.objectContaining({ libraryId: String(USER), itemKey: "NEWA2345" }),
        oldReference,
      ]);
      const sentBase = await readScientSourceZoteroSync(root, sourceId);
      expect(sentBase).toMatchObject({ libraryId: String(USER), itemKey: "NEWA2345" });
      expect(sentBase?.annotationLibraryId ?? sentBase?.libraryId).toBe(String(USER));
      const second = await sendSourcesToZotero({
        root,
        sourceIds: [sourceId],
        actor: "user",
        zotero: org.zotero,
      });
      expect(second.items[0]?.outcome).toBe("unchanged");
    },
  );

  it("keeps two group libraries separate when their item keys and versions coincide", async () => {
    const oldReference = {
      system: "zotero",
      libraryId: "groups/88",
      itemKey: "SAME2345",
      itemVersion: 10,
      rawItemType: "journalArticle",
    };
    const { root, sourceId } = await sourceInScient({ externalReferences: [oldReference] });
    const org = zoteroOrg({
      groupId: "77",
      groups: { "77": { library: true, write: true } },
    });
    const unrelated = {
      ...zoteroItem("SAME2345", { version: 10, title: "Another group's work" }),
      library: { type: "group", id: 77 },
    };
    org.items.set(unrelated.key, unrelated);

    const result = await sendSourcesToZotero({
      root,
      sourceIds: [sourceId],
      groupId: "77",
      actor: "user",
      zotero: org.zotero,
    });

    expect(result.items[0]).toMatchObject({ outcome: "created", itemKey: "NEWA2345" });
    expect(org.items.get(unrelated.key)).toEqual(unrelated);
    expect(
      org.requests.filter((request) => request.url.pathname.includes(`/items/${unrelated.key}`)),
    ).toEqual([]);
    expect((await readScientSourceRecord(root, sourceId))?.externalReferences).toEqual([
      expect.objectContaining({ libraryId: "groups/77", itemKey: "NEWA2345" }),
      oldReference,
    ]);
  });

  it("passes by what zotero.org says is unchanged, and reads again what changed under an item", async () => {
    const { root, sourceId } = await sourceInScient();
    const org = zoteroOrg();
    await sendSourcesToZotero({ root, sourceIds: [sourceId], actor: "user", zotero: org.zotero });
    const refresh = () =>
      refreshZoteroSources({
        root,
        after: null,
        connection: "web",
        actor: "user",
        zotero: org.zotero,
      });
    const readsOfItem = () =>
      org.requests.filter((request) => request.url.pathname.endsWith("/items/NEWA2345")).length;

    await refresh();
    const afterFirst = readsOfItem();
    const quiet = await refresh();

    expect(afterFirst).toBeGreaterThan(0);
    expect(quiet.items).toEqual([expect.objectContaining({ sourceId, outcome: "unchanged" })]);
    expect(readsOfItem()).toBe(afterFirst);

    // A note edited under the item is a change of a child the item's base knows.
    org.editInZotero("NEWB2345", { note: "<p>Read three times</p>" });
    const edited = await refresh();
    expect(edited.items[0]).toMatchObject({ outcome: "updated", changedFields: ["note"] });
    expect((await readScientSourceRecord(root, sourceId))?.note).toContain("Read three times");

    // A new note names its item only in its own data.
    org.addInZotero(
      zoteroItem(
        "NEWZ2345",
        { itemType: "note", parentItem: "NEWA2345", note: "<p>Later</p>" },
        USER,
      ),
    );
    const added = await refresh();
    expect(added.items[0]).toMatchObject({ outcome: "updated", changedFields: ["note"] });
    expect((await readScientSourceRecord(root, sourceId))?.note).toContain("Later");
  });

  it("keeps the note base a refresh saved while an earlier whole refresh was passing the paper by", async () => {
    const { root, sourceId } = await sourceInScient();
    const org = zoteroOrg();
    await sendSourcesToZotero({ root, sourceIds: [sourceId], actor: "user", zotero: org.zotero });
    const refreshAll = (zotero: ZoteroAccess) =>
      refreshZoteroSources({ root, after: null, connection: "web", actor: "user", zotero });
    await refreshAll(org.zotero);
    const before = (await readScientSourceRecord(root, sourceId))?.note;

    // The whole refresh has read the base and asked what changed; Zotero's note changes and a
    // refresh of this paper by name brings it in before the whole refresh saves its checkpoint.
    let raced = false;
    const racing = afterEachRequest(org, async (request) => {
      if (raced || !request.url.pathname.endsWith("/deleted")) return;
      raced = true;
      org.editInZotero("NEWB2345", { note: "<p>Read three times</p>" });
      const named = await refreshZoteroSources({
        root,
        sourceIds: [sourceId],
        connection: "web",
        actor: "user",
        zotero: org.zotero,
      });
      expect(named.items[0]).toMatchObject({ outcome: "updated", changedFields: ["note"] });
    });
    await refreshAll(racing);
    expect(raced).toBe(true);
    expect((await readScientSourceZoteroSync(root, sourceId))?.note).toContain("Read three times");

    // The researcher puts their own wording back; the next refresh keeps it.
    const record = await readScientSourceRecord(root, sourceId);
    await updateScientSourceNote({
      root,
      sourceId,
      expectedRevision: record!.revision,
      expectedNote: record!.note ?? null,
      note: before ?? null,
    });
    await refreshAll(org.zotero);
    expect((await readScientSourceRecord(root, sourceId))?.note).toBe(before);
  });

  it("keeps the newer note base when a refresh that read Zotero earlier finishes last", async () => {
    const { root, sourceId } = await sourceInScient();
    const org = zoteroOrg();
    await sendSourcesToZotero({ root, sourceIds: [sourceId], actor: "user", zotero: org.zotero });
    const refreshNamed = (zotero: ZoteroAccess) =>
      refreshZoteroSources({
        root,
        sourceIds: [sourceId],
        connection: "web",
        actor: "user",
        zotero,
      });

    // The late refresh has read the item and its old note when the newer one is brought in.
    let raced = false;
    const slow = afterEachRequest(org, async (request) => {
      if (raced || !request.url.pathname.endsWith("/children")) return;
      raced = true;
      org.editInZotero("NEWB2345", { note: "<p>Read three times</p>" });
      await refreshNamed(org.zotero);
    });
    const late = await refreshNamed(slow);

    expect(raced).toBe(true);
    expect(late.items[0]).toMatchObject({ outcome: "stale" });
    expect((await readScientSourceZoteroSync(root, sourceId))?.note).toContain("Read three times");
  });

  it("keeps a refresh's note and base in step when it lands while a Send saves its base", async () => {
    const { root, sourceId } = await sourceInScient();
    const org = zoteroOrg();
    await sendSourcesToZotero({ root, sourceIds: [sourceId], actor: "user", zotero: org.zotero });
    const refresh = () =>
      refreshZoteroSources({
        root,
        sourceIds: [sourceId],
        connection: "web",
        actor: "user",
        zotero: org.zotero,
      });
    await editHere(root, sourceId, { title: "Retitled here" });

    // Once the Send's change has landed, the base it builds on is read; Zotero's note changes
    // and a refresh brings it in before the Send saves its base.
    let refreshed = false;
    const sending = afterEachRequest(org, (request) => {
      if (request.method !== "PATCH") return;
      baseRead.next = async () => {
        org.editInZotero("NEWB2345", { note: "<p>Read three times</p>" });
        const named = await refresh();
        refreshed = named.items[0]?.outcome === "updated";
      };
    });
    const sent = await sendSourcesToZotero({
      root,
      sourceIds: [sourceId],
      actor: "user",
      zotero: sending,
    });
    expect(sent.items[0]).toMatchObject({ outcome: "updated" });
    expect(refreshed).toBe(true);

    org.editInZotero("NEWB2345", { note: "<p>Read four times</p>" });
    const next = await refresh();

    expect(next.items[0]?.conflicts).toEqual([]);
    expect((await readScientSourceRecord(root, sourceId))?.note).toContain("Read four times");
  });

  it("keeps the newer link and base a refresh saved while a Send was finishing", async () => {
    const { root, sourceId } = await sourceInScient();
    const org = zoteroOrg();
    await sendSourcesToZotero({ root, sourceIds: [sourceId], actor: "user", zotero: org.zotero });
    await editHere(root, sourceId, { title: "Retitled here" });

    // The Send's change has landed and been read back; Zotero changes the item again and a
    // refresh saves that newer version before the Send saves its own.
    const sending = afterEachRequest(org, (request) => {
      if (request.method !== "PATCH") return;
      baseRead.next = async () => {
        org.editInZotero("NEWA2345", { abstractNote: "Written in Zotero later." });
        await refreshZoteroSources({
          root,
          sourceIds: [sourceId],
          connection: "web",
          actor: "user",
          zotero: org.zotero,
        });
      };
    });
    await sendSourcesToZotero({ root, sourceIds: [sourceId], actor: "user", zotero: sending });
    const newest = org.items.get("NEWA2345")!.version;

    const record = await readScientSourceRecord(root, sourceId);
    expect(record?.externalReferences[0]?.itemVersion).toBe(newest);
    expect((await readScientSourceZoteroSync(root, sourceId))?.itemVersion).toBe(newest);
    const again = await sendSourcesToZotero({
      root,
      sourceIds: [sourceId],
      actor: "user",
      zotero: org.zotero,
    });
    expect(again.items[0]?.outcome).not.toBe("changed-in-zotero");
  });

  it("refreshes only the recorded personal owner, even when another account has its key and version", async () => {
    const { root, sourceId } = await sourceInScient({
      externalReferences: [
        {
          system: "zotero",
          libraryId: String(USER + 1),
          itemKey: "SAME2345",
          itemVersion: 10,
          rawItemType: "journalArticle",
        },
      ],
    });
    const org = zoteroOrg();
    org.items.set(
      "SAME2345",
      zoteroItem("SAME2345", { version: 10, title: "Unrelated work" }, USER),
    );
    const before = await readScientSourceRecord(root, sourceId);

    const result = await refreshZoteroSources({
      root,
      sourceIds: [sourceId],
      connection: "web",
      actor: "user",
      zotero: org.zotero,
    });

    expect(result.items[0]?.outcome).toBe("failed");
    expect(await readScientSourceRecord(root, sourceId)).toEqual(before);
    expect(
      org.requests.filter((request) => request.url.pathname.includes("/items/SAME2345")),
    ).toEqual([]);
  });

  it.each([
    { localOwner: USER, sameWork: true, boundOwner: null, outcome: "updated", verified: true },
    { localOwner: USER + 1, sameWork: true, boundOwner: null, outcome: "created", verified: false },
    { localOwner: 0, sameWork: true, boundOwner: null, outcome: "created", verified: false },
    { localOwner: USER, sameWork: false, boundOwner: null, outcome: "created", verified: false },
    { localOwner: USER, sameWork: false, boundOwner: USER, outcome: "updated", verified: true },
    { localOwner: USER, sameWork: true, boundOwner: USER + 1, outcome: "created", verified: false },
  ])(
    "corroborates legacy work $sameWork with owner $localOwner or stored binding $boundOwner",
    async ({ localOwner, sameWork, boundOwner, outcome, verified }) => {
      const legacy = {
        system: "zotero",
        libraryId: "0",
        itemKey: "SAME2345",
        itemVersion: 10,
        rawItemType: "journalArticle",
      };
      const { root, sourceId } = await sourceInScient({ externalReferences: [legacy] });
      if (boundOwner !== null) {
        const record = await readScientSourceRecord(root, sourceId);
        if (!record) throw new Error("The fixture source was not added.");
        await writeScientSourceZoteroSync(root, {
          formatVersion: 1,
          sourceId,
          libraryId: String(boundOwner),
          annotationLibraryId: "0",
          itemKey: legacy.itemKey,
          itemVersion: legacy.itemVersion,
          syncedAt: "2026-11-15T10:00:00.000Z",
          metadata: editableMetadataFromRecord(record),
          note: null,
          attachmentKeys: [],
        });
      }
      const org = zoteroOrg();
      const current = zoteroItem("SAME2345", { version: 10, title: "Before sending" }, USER);
      org.items.set(current.key, current);
      const local = fakeZoteroTransport({
        items: new Map([
          [
            current.key,
            {
              item: zoteroItem(
                current.key,
                {
                  version: 10,
                  title: sameWork ? "Written in Scient" : "An unrelated local work",
                  DOI: sameWork ? "10.1000/notes" : "10.1000/unrelated",
                },
                localOwner,
              ),
              children: [],
            },
          ],
        ]),
      });
      const zotero = { ...org.zotero, local };

      const result = await sendSourcesToZotero({
        root,
        sourceIds: [sourceId],
        actor: "user",
        zotero,
      });

      expect(result.items[0]?.outcome).toBe(outcome);
      const references = (await readScientSourceRecord(root, sourceId))?.externalReferences ?? [];
      expect(references[0]).toMatchObject({
        libraryId: String(USER),
        itemKey: verified ? current.key : "NEWA2345",
      });
      expect(references.some((entry) => entry.libraryId === "0")).toBe(!verified);
      const sentBase = await readScientSourceZoteroSync(root, sourceId);
      expect(sentBase?.libraryId).toBe(String(USER));
      expect(sentBase?.annotationLibraryId ?? sentBase?.libraryId).toBe(
        verified ? "0" : String(USER),
      );
      if (!verified) {
        expect(org.items.get(current.key)).toEqual(current);
        expect(
          org.requests.filter((request) => request.url.pathname.includes(`/items/${current.key}`)),
        ).toEqual([]);
      }
    },
  );

  it("keeps the legacy note baseline when Zotero changes after a verified Send", async () => {
    const legacy = {
      system: "zotero",
      libraryId: "0",
      itemKey: "SAME2345",
      itemVersion: 10,
      rawItemType: "journalArticle",
    };
    const { root, sourceId } = await sourceInScient({ externalReferences: [legacy] });
    const record = (await readScientSourceRecord(root, sourceId))!;
    const baseline = {
      formatVersion: 1 as const,
      sourceId,
      libraryId: legacy.libraryId,
      itemKey: legacy.itemKey,
      itemVersion: legacy.itemVersion,
      syncedAt: "2026-11-15T10:00:00.000Z",
      metadata: editableMetadataFromRecord(record),
      note: record.note ?? null,
      importOperationId: record.origin!.operationId,
      importOmittedOriginalNoteHtml: false,
      attachmentKeys: [],
    };
    const note = { itemKey: "NOTE2345", sha256: "a".repeat(64), html: "" };
    const withoutHtml = Buffer.byteLength(
      `${JSON.stringify({ ...baseline, notes: [note] }, null, 2)}\n`,
      "utf8",
    );
    // Keep the baseline just under the sync file limit, so an extra field would cut the HTML.
    note.html = "界".repeat(Math.floor((2 * 1024 * 1024 - withoutHtml) / 3));
    const saved = await writeScientSourceZoteroSync(root, { ...baseline, notes: [note] });
    expect(saved.omittedOriginalNoteHtmlCount).toBe(0);
    const before = await readScientSourceZoteroSync(root, sourceId);
    expect(before?.notes?.[0]?.html).toHaveLength(note.html.length);

    const org = zoteroOrg();
    const item = zoteroItem(
      legacy.itemKey,
      { version: 10, title: "Before sending", DOI: "10.1000/notes" },
      USER,
    );
    org.items.set(item.key, item);
    org.items.set(
      note.itemKey,
      zoteroItem(
        note.itemKey,
        { itemType: "note", parentItem: item.key, note: "<p>Revised in Zotero</p>" },
        USER,
      ),
    );
    const localItem = zoteroItem(
      item.key,
      { version: 10, title: "Written in Scient", DOI: "10.1000/notes" },
      USER,
    );
    const local = fakeZoteroTransport({
      items: new Map([[item.key, { item: localItem, children: [] }]]),
    });
    const during = afterEachRequest(org, (request) => {
      if (request.method === "PATCH") org.editInZotero(item.key, { pages: "1-10" });
    });
    const result = await sendSourcesToZotero({
      root,
      sourceIds: [sourceId],
      actor: "user",
      zotero: { ...during, local },
    });

    expect(result.items[0]?.outcome).toBe("updated");
    expect((await readScientSourceRecord(root, sourceId))?.externalReferences[0]?.libraryId).toBe(
      String(USER),
    );
    const after = await readScientSourceZoteroSync(root, sourceId);
    expect(after?.notes?.[0]?.html).toHaveLength(note.html.length);
    expect(after).toEqual(before);

    const refreshed = await refreshZoteroSources({
      root,
      sourceIds: [sourceId],
      actor: "user",
      connection: "web",
      zotero: org.zotero,
    });
    expect(refreshed.items[0]?.conflicts.map((conflict) => conflict.field)).not.toContain("note");
    expect((await readScientSourceRecord(root, sourceId))?.note).toBe("Revised in Zotero");
  });

  it.each([true, false])(
    "refreshes a legacy local link only when its work is corroborated: %s",
    async (sameWork) => {
      const { root, sourceId } = await sourceInScient({
        externalReferences: [
          {
            system: "zotero",
            libraryId: "0",
            itemKey: "SAME2345",
            itemVersion: 10,
            rawItemType: "journalArticle",
          },
        ],
      });
      const org = zoteroOrg();
      const item = zoteroItem("SAME2345", { version: 10, title: "Verified owner's title" }, USER);
      org.items.set(item.key, item);
      const local = fakeZoteroTransport({
        items: new Map([
          [
            item.key,
            {
              item: zoteroItem(
                item.key,
                {
                  version: 10,
                  title: sameWork ? "Written in Scient" : "An unrelated local work",
                  DOI: sameWork ? "10.1000/notes" : "10.1000/unrelated",
                },
                USER,
              ),
              children: [],
            },
          ],
        ]),
      });
      const before = await readScientSourceRecord(root, sourceId);
      const result = await refreshZoteroSources({
        root,
        sourceIds: [sourceId],
        connection: "web",
        actor: "user",
        zotero: { ...org.zotero, local },
      });
      expect(result.items[0]?.outcome).toBe(sameWork ? "updated" : "failed");
      if (sameWork) {
        expect((await readScientSourceRecord(root, sourceId))?.externalReferences).toEqual([
          expect.objectContaining({ libraryId: String(USER), itemKey: item.key }),
        ]);
      } else {
        expect(await readScientSourceRecord(root, sourceId)).toEqual(before);
        expect(
          org.requests.filter((request) => request.url.pathname.includes(`/items/${item.key}`)),
        ).toEqual([]);
      }
    },
  );

  it("sends every further detail to the field the item's type has for it, the rest to Extra", async () => {
    const { root, sourceId } = await sourceInScient({
      type: "book",
      title: "Statistical methods in medical research",
      containerTitle: null,
      publisher: "Blackwell Science",
      volume: null,
      pages: null,
      identifiers: [{ scheme: "isbn", value: "9780632052578" }],
      more: {
        edition: "4",
        "publisher-place": "Oxford",
        "number-of-pages": "817",
        accessed: "2026-03-10",
        // A book has no field for these: they go to Extra, where Zotero reads them.
        "original-date": "1971",
        extra: "OCLC: 12345\nbought second hand",
      },
      note: undefined as never,
    });
    const org = zoteroOrg();
    await sendSourcesToZotero({ root, sourceIds: [sourceId], actor: "user", zotero: org.zotero });

    const created = org.items.get("NEWA2345")?.data as Record<string, unknown>;
    expect(created).toMatchObject({
      itemType: "book",
      publisher: "Blackwell Science",
      edition: "4",
      place: "Oxford",
      numPages: "817",
      accessDate: "2026-03-10",
      ISBN: "9780632052578",
    });
    // After the citation key Scient always writes there.
    expect(
      String(created.extra)
        .split("\n")
        .filter((line) => !line.startsWith("Citation Key:")),
    ).toEqual(["original-date: 1971", "OCLC: 12345", "bought second hand"]);
    // Read back, the source is what it was: nothing was lost on the way to Zotero.
    const before = await readScientSourceRecord(root, sourceId);
    expect(before?.more).toMatchObject({ edition: "4", "original-date": "1971" });
  });

  it("sends a further detail again only when it changed", async () => {
    const { root, sourceId } = await sourceInScient({
      type: "book",
      containerTitle: null,
      volume: null,
      pages: null,
      publisher: "A Press",
      more: { edition: "2", "publisher-place": "Leiden" },
    });
    const org = zoteroOrg();
    const send = () =>
      sendSourcesToZotero({ root, sourceIds: [sourceId], actor: "user", zotero: org.zotero });
    await send();
    const writes = org.writes.length;
    // Nothing changed here: nothing is sent, although Scient's reading of the item has no
    // "edition" of its own to compare with.
    expect((await send()).items[0]).toMatchObject({ outcome: "unchanged" });
    expect(org.writes).toHaveLength(writes);

    const record = (await readScientSourceRecord(root, sourceId))!;
    await updateScientSourceMetadata({
      root,
      sourceId,
      expectedRevision: record.revision,
      metadata: {
        ...editableMetadataFromRecord(record),
        more: { edition: "3", "publisher-place": "Leiden" },
      },
    });
    expect((await send()).items[0]).toMatchObject({ outcome: "updated" });
    expect(JSON.parse(org.writes.at(-1)?.body ?? "{}")).toEqual({ edition: "3" });
  });

  it("writes a legal case and a program under the names their types have", async () => {
    const legal = await sourceInScient({
      type: "other",
      customType: "case",
      title: "Brown v. Board of Education",
      containerTitle: "U.S.",
      volume: "347",
      pages: "483",
      issuedRaw: "1954",
      issuedYear: 1954,
      identifiers: [],
      creators: [],
      more: { authority: "Supreme Court of the United States", number: "No. 1" },
      note: undefined as never,
    });
    const org = zoteroOrg();
    await sendSourcesToZotero({
      root: legal.root,
      sourceIds: [legal.sourceId],
      actor: "user",
      zotero: org.zotero,
    });
    expect(org.items.get("NEWA2345")?.data).toMatchObject({
      itemType: "case",
      caseName: "Brown v. Board of Education",
      reporter: "U.S.",
      reporterVolume: "347",
      firstPage: "483",
      dateDecided: "1954",
      court: "Supreme Court of the United States",
      docketNumber: "No. 1",
    });

    const program = await sourceInScient({
      type: "software",
      title: "lme4",
      containerTitle: null,
      volume: null,
      pages: null,
      identifiers: [],
      creators: [
        { creatorType: "programmer", givenName: "Douglas", familyName: "Bates", literalName: null },
        // Not a role a program has in Zotero: sent as its primary one, not refused.
        { creatorType: "editor", givenName: "Ben", familyName: "Bolker", literalName: null },
      ],
      more: { version: "1.1-35", genre: "R" },
      note: undefined as never,
    });
    const second = zoteroOrg();
    await sendSourcesToZotero({
      root: program.root,
      sourceIds: [program.sourceId],
      actor: "user",
      zotero: second.zotero,
    });
    expect(second.items.get("NEWA2345")?.data).toMatchObject({
      itemType: "computerProgram",
      versionNumber: "1.1-35",
      programmingLanguage: "R",
      creators: [
        { creatorType: "programmer", lastName: "Bates" },
        { creatorType: "programmer", lastName: "Bolker" },
      ],
    });
  });

  it("sends a talk's place of the event to Zotero's place, where Zotero keeps it", async () => {
    const { root, sourceId } = await sourceInScient({
      type: "presentation",
      title: "A talk",
      containerTitle: null,
      volume: null,
      pages: null,
      identifiers: [],
      creators: [
        { creatorType: "presenter", givenName: "Ada", familyName: "Lovelace", literalName: null },
      ],
      more: { "event-place": "Boston", "event-title": "Annual Meeting", genre: "Keynote" },
      note: undefined as never,
    });
    const org = zoteroOrg();
    await sendSourcesToZotero({ root, sourceIds: [sourceId], actor: "user", zotero: org.zotero });
    const created = org.items.get("NEWA2345")?.data as Record<string, unknown>;
    expect(created).toMatchObject({
      itemType: "presentation",
      place: "Boston",
      meetingName: "Annual Meeting",
      presentationType: "Keynote",
    });
    expect(String(created.extra ?? "")).not.toContain("event-place");
  });

  it("still sends the main details when zotero.org does not say what a type accepts", async () => {
    const { root, sourceId } = await sourceInScient({
      type: "book",
      containerTitle: null,
      volume: null,
      pages: null,
      publisher: "A Press",
      more: { edition: "2" },
    });
    const org = zoteroOrg({ templates: false });
    const result = await sendSourcesToZotero({
      root,
      sourceIds: [sourceId],
      actor: "user",
      zotero: org.zotero,
    });
    expect(result.items[0]).toMatchObject({ outcome: "created" });
    const created = org.items.get("NEWA2345")?.data as Record<string, unknown>;
    expect(created).toMatchObject({ itemType: "book", publisher: "A Press" });
    // The edition is not lost: without a field known for it, it travels in Extra.
    expect(created).not.toHaveProperty("edition");
    expect(String(created.extra)).toContain("edition: 2");
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

    // An editor the import read from Extra is sent as a creator, so the line goes: Zotero
    // would cite her twice. A creator Scient does not have stays where Zotero keeps him.
    const editor = { creatorType: "editor", givenName: "Jane", familyName: "Smith" };
    const patch = zoteroPatchFor({
      record: { ...record, creators: [...record.creators, { ...editor, literalName: null }] },
      current: zoteroItem("OLDA2345", {
        itemType: "journalArticle",
        title: "Written in Scient",
        DOI: "10.1000/notes",
        extra: "editor: Smith || Jane\ntranslator: Roe || Ann",
      }),
    });
    const lines = String(patch.extra).split("\n");
    expect(lines).toContain("translator: Roe || Ann");
    expect(lines).not.toContain("editor: Smith || Jane");
    expect(patch.creators).toContainEqual({
      creatorType: "editor",
      firstName: "Jane",
      lastName: "Smith",
    });
  });

  it("never sends a list marked et al. over a longer one in Zotero", async () => {
    const { root, sourceId } = await sourceInScient();
    const record = await readScientSourceRecord(root, sourceId);
    if (!record) throw new Error("missing");
    const names = Array.from({ length: 300 }, (_, index) => ({
      creatorType: "author",
      givenName: "Ada",
      familyName: `Member${index + 1}`,
      literalName: null,
    }));
    const current = zoteroItem("OLDA2345", {
      itemType: "journalArticle",
      title: "Written in Scient",
      creators: names.map(({ givenName, familyName }) => ({
        creatorType: "author",
        firstName: givenName,
        lastName: familyName,
      })),
    });
    const short = { ...record, creators: names.slice(0, 256) };

    expect(
      zoteroPatchFor({ record: { ...short, incompleteCreatorRoles: ["author"] }, current }),
    ).not.toHaveProperty("creators");
    // A shorter list that is not marked short is a correction, and is sent.
    expect(zoteroPatchFor({ record: short, current })).toHaveProperty("creators");
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

  it("leaves what Zotero changed during a Send for Refresh to bring, and never sends it back", async () => {
    const { root, sourceId } = await sourceInScient();
    const org = zoteroOrg();
    const send = (zotero: ZoteroAccess) =>
      sendSourcesToZotero({ root, sourceIds: [sourceId], actor: "user", zotero });
    await send(org.zotero);
    await editHere(root, sourceId, { title: "Retitled in Scient" });
    let correct = true;
    const during = afterEachRequest(org, (request) => {
      if (request.method !== "PATCH" || !correct) return;
      correct = false;
      org.editInZotero("NEWA2345", { pages: "1-10" });
    });

    expect((await send(during)).items[0]?.outcome).toBe("updated");
    expect((await send(org.zotero)).items[0]?.outcome).toBe("changed-in-zotero");
    await refreshZoteroSources({ root, actor: "user", zotero: org.zotero });

    expect(await readScientSourceRecord(root, sourceId)).toMatchObject({
      title: "Retitled in Scient",
      pages: "1-10",
    });
    expect(org.items.get("NEWA2345")?.data).toMatchObject({
      title: "Retitled in Scient",
      pages: "1-10",
    });
  });

  it("leaves what Zotero changed between creating an item and reading it back for Refresh", async () => {
    const { root, sourceId } = await sourceInScient();
    const org = zoteroOrg();
    let edited = false;
    const during = afterEachRequest(org, (request) => {
      if (edited || request.method !== "POST" || !request.url.pathname.endsWith("/items")) return;
      if (!org.items.has("NEWA2345")) return;
      edited = true;
      org.editInZotero("NEWA2345", { pages: "99-110" });
    });

    const created = await sendSourcesToZotero({
      root,
      sourceIds: [sourceId],
      actor: "user",
      zotero: during,
    });
    expect(created.items[0]).toMatchObject({ outcome: "created", itemKey: "NEWA2345" });
    expect(
      (
        await sendSourcesToZotero({
          root,
          sourceIds: [sourceId],
          actor: "user",
          zotero: org.zotero,
        })
      ).items[0]?.outcome,
    ).toBe("changed-in-zotero");

    await refreshZoteroSources({ root, actor: "user", zotero: org.zotero });
    expect((await readScientSourceRecord(root, sourceId))?.pages).toBe("99-110");
  });

  it("applies a Zotero edit to a newly created child note without false conflict when local note is untouched", async () => {
    const { root, sourceId } = await sourceInScient();
    const org = zoteroOrg();
    let editedChild = false;
    const during = afterEachRequest(org, (request) => {
      if (editedChild || request.method !== "POST" || !request.url.pathname.endsWith("/items")) {
        return;
      }
      if (!org.items.has("NEWB2345")) return;
      editedChild = true;
      // Child note changes in Zotero before readback while parent version and local note stay fixed.
      org.editInZotero("NEWB2345", { note: "<p>Edited in Zotero right after create</p>" });
    });

    const created = await sendSourcesToZotero({
      root,
      sourceIds: [sourceId],
      actor: "user",
      zotero: during,
    });
    expect(created.items[0]).toMatchObject({ outcome: "created", itemKey: "NEWA2345" });

    const refreshed = await refreshZoteroSources({ root, actor: "user", zotero: org.zotero });
    expect(refreshed.items[0]?.conflicts).toEqual([]);
    expect((await readScientSourceRecord(root, sourceId))?.note).toBe(
      "Edited in Zotero right after create",
    );
  });

  it("keeps unchanged local Markdown intact across byte-identical and formatting-only Zotero Refreshes, then takes a later text edit", async () => {
    const { root, sourceId } = await sourceInScient({ note: "# Heading" });
    const org = zoteroOrg();
    await sendSourcesToZotero({ root, sourceIds: [sourceId], actor: "user", zotero: org.zotero });

    const unchanged = await refreshZoteroSources({ root, actor: "user", zotero: org.zotero });
    expect(unchanged.items[0]?.conflicts).toEqual([]);
    expect((await readScientSourceRecord(root, sourceId))?.note).toBe("# Heading");

    // Formatting-only HTML change (colour) changes the digest without changing rendered Markdown.
    org.editInZotero("NEWB2345", { note: '<p style="color: red"># Heading</p>' });
    const styled = await refreshZoteroSources({ root, actor: "user", zotero: org.zotero });
    expect(styled.items[0]?.conflicts).toEqual([]);
    expect((await readScientSourceRecord(root, sourceId))?.note).toBe("# Heading");

    org.editInZotero("NEWB2345", { note: "<p>Revised in Zotero</p>" });
    const changed = await refreshZoteroSources({ root, actor: "user", zotero: org.zotero });
    expect(changed.items[0]?.conflicts).toEqual([]);
    expect((await readScientSourceRecord(root, sourceId))?.note).toBe("Revised in Zotero");

    // Formatting-only edit in Zotero also avoids a false conflict when local Markdown was edited.
    const edited = await sourceInScient({ note: "# Heading" });
    const org2 = zoteroOrg();
    await sendSourcesToZotero({
      root: edited.root,
      sourceIds: [edited.sourceId],
      actor: "user",
      zotero: org2.zotero,
    });
    const current = (await readScientSourceRecord(edited.root, edited.sourceId))!;
    await updateScientSourceNote({
      root: edited.root,
      sourceId: edited.sourceId,
      expectedRevision: current.revision,
      note: "# Heading\n\nLocal addition",
      actor: "user",
    });
    org2.editInZotero("NEWB2345", { note: '<p style="color: blue"># Heading</p>' });
    const styledEdited = await refreshZoteroSources({
      root: edited.root,
      actor: "user",
      zotero: org2.zotero,
    });
    expect(styledEdited.items[0]?.conflicts).toEqual([]);
    expect((await readScientSourceRecord(edited.root, edited.sourceId))?.note).toBe(
      "# Heading\n\nLocal addition",
    );
  });

  it("uses Zotero's saved parent object on parent-version race so transformed fields do not falsely conflict", async () => {
    const program = await sourceInScient({
      type: "software",
      title: "lme4",
      containerTitle: null,
      volume: null,
      pages: null,
      identifiers: [],
      creators: [
        { creatorType: "programmer", givenName: "Douglas", familyName: "Bates", literalName: null },
      ],
      more: { version: "1.1-35", genre: "R" },
      note: undefined as never,
    });
    const initial = (await readScientSourceRecord(program.root, program.sourceId))!;
    const editedCreators = await updateScientSourceMetadata({
      root: program.root,
      sourceId: program.sourceId,
      expectedRevision: initial.revision,
      metadata: {
        ...editableMetadataFromRecord(initial),
        creators: [
          {
            creatorType: "programmer",
            givenName: "Douglas",
            familyName: "Bates",
            literalName: null,
          },
          { creatorType: "editor", givenName: "Ben", familyName: "Bolker", literalName: null },
        ],
      },
      actor: "user",
    });
    expect(
      editedCreators.record.fieldProvenance.some(
        (entry) => entry.field === "creators" && entry.origin === "user",
      ),
    ).toBe(true);
    const org = zoteroOrg();
    let edited = false;
    const during = afterEachRequest(org, (request) => {
      if (edited || request.method !== "POST" || !request.url.pathname.endsWith("/items")) return;
      if (!org.items.has("NEWA2345")) return;
      edited = true;
      // Parent changes title before readback while creators remain the saved `programmer` roles.
      org.editInZotero("NEWA2345", { title: "lme4 (CRAN)" });
    });

    const created = await sendSourcesToZotero({
      root: program.root,
      sourceIds: [program.sourceId],
      actor: "user",
      zotero: during,
    });
    expect(created.items[0]).toMatchObject({ outcome: "created", itemKey: "NEWA2345" });

    const refreshed = await refreshZoteroSources({
      root: program.root,
      actor: "user",
      zotero: org.zotero,
    });
    expect(refreshed.items[0]?.conflicts).toEqual([]);
    expect((await readScientSourceRecord(program.root, program.sourceId))?.title).toBe(
      "lme4 (CRAN)",
    );
  });

  it("retains the created child note baseline and parent version fence when both parent and child change before readback", async () => {
    const { root, sourceId } = await sourceInScient();
    const org = zoteroOrg();
    let edited = false;
    const during = afterEachRequest(org, (request) => {
      if (edited || request.method !== "POST" || !request.url.pathname.endsWith("/items")) return;
      if (!org.items.has("NEWB2345")) return;
      edited = true;
      org.editInZotero("NEWA2345", { pages: "99-110" });
      org.editInZotero("NEWB2345", { note: "<p>Both parent and child edited</p>" });
    });

    const created = await sendSourcesToZotero({
      root,
      sourceIds: [sourceId],
      actor: "user",
      zotero: during,
    });
    expect(created.items[0]).toMatchObject({ outcome: "created", itemKey: "NEWA2345" });
    expect(
      (
        await sendSourcesToZotero({
          root,
          sourceIds: [sourceId],
          actor: "user",
          zotero: org.zotero,
        })
      ).items[0]?.outcome,
    ).toBe("changed-in-zotero");

    const refreshed = await refreshZoteroSources({ root, actor: "user", zotero: org.zotero });
    expect(refreshed.items[0]?.conflicts).toEqual([]);
    expect(await readScientSourceRecord(root, sourceId)).toMatchObject({
      pages: "99-110",
      note: "Both parent and child edited",
    });
  });

  it("keeps a note changed in Zotero for Refresh when a Send updates the item", async () => {
    const { root, sourceId } = await sourceInScient();
    const org = zoteroOrg();
    await sendSourcesToZotero({ root, sourceIds: [sourceId], actor: "user", zotero: org.zotero });
    // Zotero versions a note apart from its item, and a Send to an item sends no note.
    org.editInZotero("NEWB2345", { note: "<p>Read once more</p>" });
    await editHere(root, sourceId, { title: "Retitled in Scient" });

    await sendSourcesToZotero({ root, sourceIds: [sourceId], actor: "user", zotero: org.zotero });
    await refreshZoteroSources({ root, actor: "user", zotero: org.zotero });

    expect((await readScientSourceRecord(root, sourceId))?.note).toBe("Read once more");
  });

  it("reports a note on an existing item Scient never read once a Send updates that item", async () => {
    const mine = {
      system: "zotero",
      libraryId: String(USER),
      itemKey: "MINE2345",
      itemVersion: 10,
      rawItemType: "journalArticle",
    };
    const { root, sourceId } = await sourceInScient({ externalReferences: [mine] });
    const org = zoteroOrg();
    org.items.set(
      "MINE2345",
      zoteroItem("MINE2345", { version: 10, title: "Titled in Zotero" }, USER),
    );
    org.items.set(
      "MEMO2345",
      zoteroItem(
        "MEMO2345",
        { version: 10, itemType: "note", parentItem: "MINE2345", note: "<p>Written in Zotero</p>" },
        USER,
      ),
    );

    const sent = await sendSourcesToZotero({
      root,
      sourceIds: [sourceId],
      actor: "user",
      zotero: org.zotero,
    });
    const refreshed = await refreshZoteroSources({ root, actor: "user", zotero: org.zotero });

    expect(sent.items[0]?.outcome).toBe("updated");
    expect(refreshed.items[0]?.conflicts.map((conflict) => conflict.field)).toEqual(["note"]);
    expect((await readScientSourceRecord(root, sourceId))?.note).toBe("Read **twice**");
  });

  it("keeps the recorded import omission decision when Send rewrites the sync base", async () => {
    const mine = {
      system: "zotero",
      libraryId: String(USER),
      itemKey: "MINE2345",
      itemVersion: 10,
      rawItemType: "journalArticle",
    };
    const { root, sourceId } = await sourceInScient({ externalReferences: [mine] });
    const record = (await readScientSourceRecord(root, sourceId))!;
    await writeScientSourceZoteroSync(root, {
      formatVersion: 1,
      sourceId,
      libraryId: String(USER),
      itemKey: "MINE2345",
      itemVersion: 10,
      syncedAt: "2026-11-15T10:00:00.000Z",
      metadata: editableMetadataFromRecord(record),
      note: null,
      notes: [],
      importOmittedOriginalNoteHtml: true,
      ...(record.origin?.operationId !== undefined
        ? { importOperationId: record.origin.operationId }
        : {}),
      attachmentKeys: [],
    });
    const org = zoteroOrg();
    org.items.set(
      "MINE2345",
      zoteroItem("MINE2345", { version: 10, title: "Titled in Zotero" }, USER),
    );

    const sent = await sendSourcesToZotero({
      root,
      sourceIds: [sourceId],
      actor: "user",
      zotero: org.zotero,
    });

    expect(sent.items[0]?.outcome).toBe("updated");
    expect((await readScientSourceZoteroSync(root, sourceId))?.importOmittedOriginalNoteHtml).toBe(
      true,
    );
  });

  it("reports a link-only note on an existing item after switching from another saved Zotero base", async () => {
    const mine = {
      system: "zotero",
      libraryId: String(USER),
      itemKey: "DEST2345",
      itemVersion: 10,
      rawItemType: "journalArticle",
    };
    const { root, sourceId } = await sourceInScient({ externalReferences: [mine] });
    const record = (await readScientSourceRecord(root, sourceId))!;
    // Earlier base belonged to a different Zotero item in another library.
    await writeScientSourceZoteroSync(root, {
      formatVersion: 1,
      sourceId,
      libraryId: "groups/88",
      itemKey: "PREV2345",
      itemVersion: 4,
      syncedAt: "2026-11-20T00:00:00.000Z",
      metadata: editableMetadataFromRecord(record),
      note: record.note ?? null,
      notes: [],
      attachmentKeys: [],
    });
    const org = zoteroOrg();
    org.items.set(
      "DEST2345",
      zoteroItem("DEST2345", { version: 10, title: "Titled in Zotero" }, USER),
    );
    // Anchor without visible text: legacy plain-text conversion is null, Markdown keeps the URL.
    org.items.set(
      "LINK2345",
      zoteroItem(
        "LINK2345",
        {
          version: 10,
          itemType: "note",
          parentItem: "DEST2345",
          note: '<p><a href="https://example.com"></a></p>',
        },
        USER,
      ),
    );

    const sent = await sendSourcesToZotero({
      root,
      sourceIds: [sourceId],
      actor: "user",
      zotero: org.zotero,
    });
    const refreshed = await refreshZoteroSources({ root, actor: "user", zotero: org.zotero });

    expect(sent.items[0]?.outcome).toBe("updated");
    expect(refreshed.items[0]?.conflicts).toEqual([
      expect.objectContaining({ field: "note", zotero: "<https://example.com>" }),
    ]);
    expect((await readScientSourceRecord(root, sourceId))?.note).toBe("Read **twice**");
  });

  it("links the item it made when the source is edited during the Send, and makes no second one", async () => {
    const { root, sourceId } = await sourceInScient();
    const org = zoteroOrg();
    let edit = true;
    const during = afterEachRequest(org, async (request) => {
      if (!edit || request.method !== "GET" || !request.url.pathname.endsWith("/NEWA2345")) return;
      edit = false;
      await editHere(root, sourceId, { title: "Retitled meanwhile" });
    });

    const first = await sendSourcesToZotero({
      root,
      sourceIds: [sourceId],
      actor: "user",
      zotero: during,
    });
    const second = await sendSourcesToZotero({
      root,
      sourceIds: [sourceId],
      actor: "user",
      zotero: org.zotero,
    });

    expect(first.items[0]).toMatchObject({ outcome: "created", itemKey: "NEWA2345" });
    expect(await readScientSourceRecord(root, sourceId)).toMatchObject({
      title: "Retitled meanwhile",
      externalReferences: [expect.objectContaining({ itemKey: "NEWA2345" })],
    });
    expect(second.items[0]).toMatchObject({ outcome: "updated", itemKey: "NEWA2345" });
    expect([...org.items.values()].filter((item) => item.data.itemType !== "note")).toHaveLength(1);
  });

  it("says so, and makes no second item, when an earlier Send made the item but did not finish", async () => {
    const { root, sourceId } = await sourceInScient();
    // The item is made, then reading it back to link the source fails.
    const org = zoteroOrg({ readFailures: 1 });
    const send = () =>
      sendSourcesToZotero({ root, sourceIds: [sourceId], actor: "user", zotero: org.zotero });

    expect((await send()).items).toEqual([expect.objectContaining({ outcome: "failed" })]);
    expect((await send()).items).toEqual([
      expect.objectContaining({
        outcome: "failed",
        message: expect.stringContaining("Look for the item in Zotero"),
      }),
    ]);
    expect([...org.items.values()].filter((item) => item.data.itemType !== "note")).toHaveLength(1);
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

  it("sends a PDF the item lacks through Zotero's upload, once, and only when asked", async () => {
    const source = await sourceWithPdf("first");
    const org = zoteroOrg();

    // Off unless asked: the details go, the PDF does not.
    await sendSourcesToZotero({
      root: source.root,
      sourceIds: [source.sourceId],
      actor: "user",
      zotero: org.zotero,
    });
    expect(attachmentsIn(org)).toEqual([]);

    const sent = await sendWithPdfs(source, org);
    expect(sent.items[0]).toMatchObject({
      outcome: "unchanged",
      pdfs: [{ fileName: "paper.pdf", outcome: "sent", message: null }],
    });
    const [md5] = [...org.stored.keys()];
    expect(attachmentsIn(org)).toEqual([{ parentItem: "NEWA2345", filename: "paper.pdf", md5 }]);

    expect((await sendWithPdfs(source, org)).items[0]?.pdfs).toEqual([
      { fileName: "paper.pdf", outcome: "in-zotero", message: null },
    ]);
    // Another paper with the same bytes: Zotero already holds them, so nothing is uploaded.
    const twin = await sourceWithPdf("first");
    expect((await sendWithPdfs(twin, org)).items[0]?.pdfs).toEqual([
      { fileName: "paper.pdf", outcome: "sent", message: null },
    ]);
    expect(org.stored.size).toBe(1);
    expect(attachmentsIn(org).filter((attachment) => attachment.md5 === md5)).toHaveLength(2);
  });

  it.each([
    [
      "a key without file access",
      { files: false },
      "The Zotero key in Accounts does not allow files.",
    ],
    ["a full storage", { quota: 8 }, "The Zotero storage is full."],
  ] as const)(
    "says why the PDF was not sent with %s, leaves no empty attachment, and still sends the details",
    async (_case, options, message) => {
      const source = await sourceWithPdf("first");
      const org = zoteroOrg(options);

      expect((await sendWithPdfs(source, org)).items[0]).toMatchObject({
        outcome: "created",
        pdfs: [{ fileName: "paper.pdf", outcome: "not-sent", message }],
      });
      expect(attachmentsIn(org)).toEqual([]);
    },
  );

  it("does not upload a second copy of a file Zotero links to", async () => {
    const source = await sourceWithPdf("first");
    const org = zoteroOrg();
    await sendSourcesToZotero({
      root: source.root,
      sourceIds: [source.sourceId],
      actor: "user",
      zotero: org.zotero,
    });
    org.items.set("LINK2345", {
      key: "LINK2345",
      version: 1,
      library: { type: "user", id: USER },
      data: {
        key: "LINK2345",
        version: 1,
        itemType: "attachment",
        parentItem: "NEWA2345",
        linkMode: "linked_file",
        path: "/Users/ada/Papers/paper.pdf",
      } as ZoteroRawItem["data"],
    });

    expect((await sendWithPdfs(source, org)).items[0]?.pdfs).toEqual([
      {
        fileName: "paper.pdf",
        outcome: "not-sent",
        message: "Zotero links to a file of that name on your computer.",
      },
    ]);
    expect(org.stored.size).toBe(0);
  });

  it("finishes a PDF stopped half way on the next Send, in the same attachment", async () => {
    const source = await sourceWithPdf("first");
    const org = zoteroOrg({ storageFailures: 1 });

    expect((await sendWithPdfs(source, org)).items[0]?.pdfs).toEqual([
      {
        fileName: "paper.pdf",
        outcome: "not-sent",
        message: "It did not reach zotero.org. Send again to finish.",
      },
    ]);
    expect(attachmentsIn(org)).toEqual([
      { parentItem: "NEWA2345", filename: "paper.pdf", md5: null },
    ]);

    expect((await sendWithPdfs(source, org)).items[0]?.pdfs).toEqual([
      { fileName: "paper.pdf", outcome: "sent", message: null },
    ]);
    expect(attachmentsIn(org)).toEqual([
      { parentItem: "NEWA2345", filename: "paper.pdf", md5: [...org.stored.keys()][0] },
    ]);
  });

  it("makes one attachment when two Sends of one source overlap", async () => {
    const source = await sourceWithPdf("first");
    const org = zoteroOrg();
    await sendSourcesToZotero({
      root: source.root,
      sourceIds: [source.sourceId],
      actor: "user",
      zotero: org.zotero,
    });
    // A Send lists the item's files only once both have read the item: both are under way.
    let itemReads = 0;
    const bothRead = Promise.withResolvers<void>();
    const http: ZoteroWebHttp = {
      ...org.zotero.http,
      request: async (request) => {
        const path = request.url.pathname;
        if (path === `/users/${USER}/items/NEWA2345` && ++itemReads === 2) bothRead.resolve();
        if (path === `/users/${USER}/items/NEWA2345/children`) await bothRead.promise;
        return org.zotero.http.request(request);
      },
    };
    const overlapping = { zotero: { ...org.zotero, http } };

    const sends = await Promise.all([
      sendWithPdfs(source, overlapping),
      sendWithPdfs(source, overlapping),
    ]);

    expect(
      sends.flatMap((sent) => sent.items[0]?.pdfs?.map((pdf) => pdf.outcome)).toSorted(),
    ).toEqual(["in-zotero", "sent"]);
    expect(attachmentsIn(org)).toHaveLength(1);
  });
});
