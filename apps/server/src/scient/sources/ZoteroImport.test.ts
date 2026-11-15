// @effect-diagnostics nodeBuiltinImport:off -- This test exercises the real project filesystem boundary.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { initializeScientProject } from "@scientfactory/project-init";
import { readScientSourcesOrganization } from "@scientfactory/scient-sources/collections";
import {
  cancelSourceImportOperation,
  listScientSourceImports,
  listScientSourceRecords,
} from "@scientfactory/scient-sources/store";
import { afterEach, describe, expect, it } from "@effect/vitest";

import { advanceSourceImport, beginZoteroScopedImport } from "./ScientSourcesCoordinator.ts";
import {
  fakeZoteroAccess,
  fakeZoteroAccessWithGroup,
  fakeZoteroTransport,
  zoteroGroupItem,
  zoteroItem,
} from "./Zotero.testkit.ts";
import { countZoteroScopeStandalone } from "./ZoteroLibraryReader.ts";
import type { ZoteroWebHttp } from "./ZoteroWebAdapter.ts";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => NodeFSP.rm(root, { recursive: true, force: true })),
  );
});

async function project() {
  const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "scient-zotero-import-"));
  roots.push(root);
  await initializeScientProject({ root });
  return root;
}

async function pdf(root: string, name: string) {
  const path = NodePath.join(root, name);
  await NodeFSP.writeFile(path, `%PDF-1.7\n${name}\n`, "utf8");
  return path;
}

const pdfAttachment = (key: string, filename: string) =>
  zoteroItem(key, { itemType: "attachment", contentType: "application/pdf", filename });

describe("Zotero import", () => {
  it("keeps notes and every PDF of an item", async () => {
    const root = await project();
    const transport = fakeZoteroTransport({
      items: new Map([
        [
          "ABCD2345",
          {
            item: zoteroItem("ABCD2345", {
              title: "Imported with material",
              abstractNote: "Already has an abstract.",
            }),
            children: [
              zoteroItem("NOTE2345", { itemType: "note", note: "<p>Read <b>twice</b></p>" }),
              pdfAttachment("PDFA2345", "article.pdf"),
              pdfAttachment("PDFB2345", "supplement.pdf"),
            ],
          },
        ],
      ]),
      files: new Map([
        ["PDFA2345", await pdf(root, "a.pdf")],
        ["PDFB2345", await pdf(root, "b.pdf")],
      ]),
    });
    const zotero = fakeZoteroAccess(transport);

    await beginZoteroScopedImport({
      root,
      operationId: "zotero-full",
      scope: { kind: "library" },
      zotero,
    });
    const operation = await advanceSourceImport({ root, operationId: "zotero-full", zotero });

    expect(operation.items.map((item) => item.state)).toEqual(["imported"]);
    const [record] = await listScientSourceRecords(root);
    expect(record?.note).toBe("Read **twice**");
    expect(record?.attachments.map((attachment) => attachment.fileName)).toEqual([
      "article.pdf",
      "supplement.pdf",
    ]);
    expect(record?.origin).toMatchObject({ actor: "user", intake: "zotero" });
  });

  it("keeps the citation key Zotero or Better BibTeX gives", async () => {
    const root = await project();
    const zotero = fakeZoteroAccess(
      fakeZoteroTransport({
        items: new Map([
          [
            "ABCD2345",
            {
              item: zoteroItem("ABCD2345", {
                title: "Pinned",
                abstractNote: "A.",
                extra: "Citation Key: pinned2026",
              }),
              children: [],
            },
          ],
          [
            "EFGH2345",
            {
              item: zoteroItem("EFGH2345", { title: "Unpinned", abstractNote: "A." }),
              children: [],
            },
          ],
        ]),
        citationKeys: new Map([["EFGH2345", "fromBetterBibTeX"]]),
      }),
    );

    await beginZoteroScopedImport({
      root,
      operationId: "keys",
      scope: { kind: "library" },
      zotero,
    });
    await advanceSourceImport({ root, operationId: "keys", zotero });
    await advanceSourceImport({ root, operationId: "keys", zotero });

    const keys = (await listScientSourceRecords(root))
      .map((record) => record.citationKey)
      .toSorted();
    expect(keys).toEqual(["fromBetterBibTeX", "pinned2026"]);
  });

  it("keeps one level of Zotero's collections and reports deeper ones it flattened", async () => {
    const root = await project();
    const zotero = fakeZoteroAccess(
      fakeZoteroTransport({
        items: new Map([
          [
            "ABCD2345",
            {
              item: zoteroItem("ABCD2345", {
                title: "Filed twice",
                abstractNote: "A.",
                collections: ["THES2345", "FIGS2345"],
              }),
              children: [],
            },
          ],
        ]),
        collections: [
          { key: "THES2345", name: "Thesis" },
          { key: "CHAP2345", name: "Chapter 2", parent: "THES2345" },
          { key: "FIGS2345", name: "Figures", parent: "CHAP2345" },
        ],
      }),
    );

    await beginZoteroScopedImport({
      root,
      operationId: "filed",
      scope: { kind: "library" },
      zotero,
    });
    const operation = await advanceSourceImport({ root, operationId: "filed", zotero });

    const [record] = await listScientSourceRecords(root);
    const organization = await readScientSourcesOrganization(root);
    const thesis = organization.collections.find((collection) => collection.name === "Thesis");
    expect(
      organization.collections.map((collection) => [
        collection.name,
        collection.parentCollectionId ?? null,
        collection.sourceIds,
      ]),
    ).toEqual([
      ["Thesis", null, [record?.sourceId]],
      ["Chapter 2", thesis?.collectionId, [record?.sourceId]],
    ]);
    expect(operation.items[0]?.note).toContain("“Figures” joined “Thesis / Chapter 2”");
  });

  it("says what Zotero holds for each reference that it did not bring", async () => {
    const root = await project();
    const zotero = fakeZoteroAccess(
      fakeZoteroTransport({
        items: new Map([
          [
            "ABCD2345",
            {
              item: zoteroItem("ABCD2345", {
                itemType: "book",
                title: "A book with an edition",
                abstractNote: "A.",
                publisher: "A Press",
                extra: "Citation Key: book2026\nOCLC: 12345\nbought second hand",
                tags: [{ tag: "methods" }, { tag: "Humans", type: 1 }],
                relations: { "dc:relation": ["http://zotero.org/users/1/items/EFGH2345"] },
                // Fields beyond the record's own, and one Zotero itself has no CSL name for.
                ...({
                  place: "Leiden",
                  edition: "2nd",
                  numPages: "412",
                  assignee: "A Lab",
                } as object),
              }),
              children: [
                { ...pdfAttachment("PDFA2345", "book.pdf"), meta: { numChildren: 7 } },
                pdfAttachment("PDFB2345", "not-in-zotero-storage.pdf"),
                zoteroItem("SNAP2345", {
                  itemType: "attachment",
                  contentType: "text/html",
                  linkMode: "imported_url",
                }),
                zoteroItem("LINK2345", { itemType: "attachment", linkMode: "linked_url" }),
                zoteroItem("NOTE2345", {
                  itemType: "note",
                  note: '<p>See <a href="https://example.org">the errata</a>.</p>',
                }),
              ],
            },
          ],
          // A note that belongs to no reference: the import passes it by and says so.
          [
            "LONE2345",
            {
              item: zoteroItem("LONE2345", { itemType: "note", note: "<p>Ideas</p>" }),
              children: [],
            },
          ],
        ]),
        files: new Map([["PDFA2345", await pdf(root, "book.pdf")]]),
      }),
    );

    const begun = await beginZoteroScopedImport({
      root,
      operationId: "not-brought",
      scope: { kind: "library" },
      zotero,
    });
    expect(begun.items.map((item) => item.itemKey)).toEqual(["ABCD2345"]);
    expect(begun.notBrought).toEqual([{ kind: "notes-alone", count: 1 }]);
    const operation = await advanceSourceImport({ root, operationId: "not-brought", zotero });

    expect(operation.items[0]).toMatchObject({ state: "imported" });
    expect(operation.items[0]?.notBrought).toEqual([
      { kind: "related", count: 1 },
      { kind: "automatic-tags", count: 1 },
      { kind: "highlights", count: 7 },
      { kind: "file", name: "text/html", count: 1 },
      { kind: "link", count: 1 },
      { kind: "note-formatting", count: 1 },
      { kind: "pdf", name: "unavailable", count: 1 },
    ]);
    // What it did bring is as before.
    const [record] = await listScientSourceRecords(root);
    expect(record).toMatchObject({
      title: "A book with an edition",
      publisher: "A Press",
      citationKey: "book2026",
      tags: ["methods", "Humans"],
      // Every bibliographic field has a place: under its citation name, or as written.
      more: {
        edition: "2nd",
        "publisher-place": "Leiden",
        "number-of-pages": "412",
        extra: "Assignee: A Lab\nOCLC: 12345\nbought second hand",
      },
    });
    expect(record?.attachments.map((attachment) => attachment.fileName)).toEqual(["book.pdf"]);
  });

  it("imports a scope too large for one operation as a run of parts, each item once", async () => {
    const root = await project();
    // Zotero's key alphabet has no 0, 1 or O.
    const digits = "23456789ABCDEFGHIJKLMNPQRSTUVWXYZ";
    const keyOf = (index: number) =>
      [0, 1, 2]
        .map((place) => digits[Math.floor(index / digits.length ** place) % digits.length])
        .toReversed()
        .join("")
        .padStart(8, "K");
    const item = (index: number) =>
      [
        keyOf(index),
        {
          item: zoteroItem(keyOf(index), {
            title: `Reference number ${index}`,
            abstractNote: "A.",
            creators: [{ creatorType: "author", lastName: `Author${index}` }],
            date: String(1500 + index),
          }),
          children: [],
        },
      ] as const;
    // Parts of 5 here; an operation's own limit is 500.
    const items = new Map(Array.from({ length: 12 }, (_, index) => item(index)));
    expect(items.size).toBe(12);
    const transport = fakeZoteroTransport({ items });
    const zotero = fakeZoteroAccess(transport);
    const finish = async (operationId: string) => {
      let operation = await advanceSourceImport({ root, operationId, zotero });
      while (operation.state === "running") {
        operation = await advanceSourceImport({ root, operationId, zotero });
      }
      return operation;
    };
    const begin = (continueRun?: string) =>
      beginZoteroScopedImport({
        root,
        operationId: continueRun ? "ignored-for-a-later-part" : "run",
        scope: { kind: "library" },
        zotero,
        partSize: 5,
        ...(continueRun ? { continueRun } : {}),
      });

    const first = await begin();
    expect(first).toMatchObject({
      operationId: "run",
      run: { runId: "run", part: 1, remaining: 7, scope: { kind: "library" } },
    });
    expect(first.items).toHaveLength(5);
    // Asked again before it ends (an answer was lost): the same part, not a second one.
    expect((await begin("run")).operationId).toBe("run");
    expect((await finish("run")).state).toBe("completed");

    const second = await begin("run");
    expect(second).toMatchObject({ operationId: "run-2", run: { part: 2, remaining: 2 } });
    expect(second.items).toHaveLength(5);
    expect(
      second.items.some((entry) =>
        first.items.some((earlier) => earlier.itemKey === entry.itemKey),
      ),
    ).toBe(false);
    await finish("run-2");
    const third = await begin("run");
    expect(third).toMatchObject({ operationId: "run-3", run: { part: 3, remaining: 0 } });
    await finish("run-3");
    expect(await listScientSourceRecords(root)).toHaveLength(12);
    // Asked to go on when nothing is left: the last part again, and no error.
    expect(await begin("run")).toMatchObject({ operationId: "run-3", run: { remaining: 0 } });
    // The parts are one import in the record of what was imported.
    const imported = async () =>
      (await listScientSourceImports(root, 10)).map((entry) => [
        entry.operationId,
        entry.importedSourceIds.length,
      ]);
    expect(await imported()).toEqual([["run", 12]]);
    // A scope is listed by its keys alone, never by reading every item again for each part.
    expect(transport.requests.filter((path) => path.startsWith("/items/top?format=json"))).toEqual(
      [],
    );

    // Later, three more references in Zotero: a new import brings only those.
    for (const index of [520, 521, 522]) items.set(...item(index));
    const later = await beginZoteroScopedImport({
      root,
      operationId: "later",
      scope: { kind: "library" },
      zotero,
      partSize: 5,
    });
    expect(later.items.map((entry) => entry.itemKey)).toEqual([520, 521, 522].map(keyOf));
    await finish("later");
    expect(await imported()).toEqual([
      ["later", 3],
      ["run", 12],
    ]);
    expect(later.run).toMatchObject({ runId: "later", part: 1, remaining: 0 });
  });

  it("takes up what a stopped part never reached, and ends quietly when nothing is left", async () => {
    const root = await project();
    const keys = ["AAAA2345", "BBBB2345", "CCCC2345", "DDDD2345", "EEEE2345", "FFFF2345"];
    const items = new Map(
      keys.map((key, index) => [
        key,
        {
          item: zoteroItem(key, {
            title: `Stopped reference ${key}`,
            abstractNote: "A.",
            creators: [{ creatorType: "author", lastName: `Writer${key}` }],
            date: String(1600 + index),
          }),
          children: [],
        },
      ]),
    );
    const zotero = fakeZoteroAccess(fakeZoteroTransport({ items }));
    const begin = (continueRun?: string) =>
      beginZoteroScopedImport({
        root,
        operationId: continueRun ? "ignored" : "stop",
        scope: { kind: "library" },
        zotero,
        partSize: 3,
        ...(continueRun ? { continueRun } : {}),
      });

    expect((await begin()).run).toMatchObject({ part: 1, remaining: 3 });
    // Stopped before anything came: its three are still to come, with the other three.
    expect((await cancelSourceImportOperation(root, "stop")).run).toMatchObject({ remaining: 6 });
    const second = await begin("stop");
    expect(second.items.map((entry) => entry.itemKey)).toEqual(keys.slice(0, 3));
    expect(second).toMatchObject({ operationId: "stop-2", run: { part: 2, remaining: 3 } });
    let part = await advanceSourceImport({ root, operationId: "stop-2", zotero });
    while (part.state === "running") {
      part = await advanceSourceImport({ root, operationId: "stop-2", zotero });
    }

    // The other three are deleted in Zotero meanwhile: the import is over, and says so.
    for (const key of keys.slice(3)) items.delete(key);
    expect(await begin("stop")).toMatchObject({
      operationId: "stop-2",
      state: "completed",
      run: { remaining: 0 },
    });
    const [listed] = await listScientSourceImports(root, 10);
    expect(listed).toMatchObject({ operationId: "stop", outcome: "completed", failed: 0 });
    expect(listed?.importedSourceIds).toHaveLength(3);

    await expect(begin("never-begun")).rejects.toThrow("not on record here");
  });

  it("counts a note filed in two collections once, and says so when Zotero does not answer", async () => {
    const note = zoteroItem("NOTE2345", { itemType: "note", note: "<p>Ideas</p>" });
    const json = (value: unknown, total: number) => ({
      status: 200,
      headers: { "total-results": String(total) },
      body: JSON.stringify(value),
    });
    const transport = (fails: boolean) => ({
      connection: "local" as const,
      attachmentFile: async () => null,
      get: async (path: string) => {
        if (path.startsWith("/collections?")) {
          const collection = (key: string, parentCollection: string | false) => ({
            key,
            data: { key, name: key, parentCollection },
          });
          return json([collection("TOPC2345", false), collection("SUBC2345", "TOPC2345")], 2);
        }
        if (fails) throw new Error("Zotero is busy.");
        // The same note is filed in the collection and in its subcollection.
        return { status: 200, headers: {}, body: path.includes("itemType=note") ? note.key : "" };
      },
    });
    const scope = {
      kind: "collection",
      collectionKey: "TOPC2345",
      includeSubcollections: true,
    } as const;
    expect(await countZoteroScopeStandalone(transport(false), scope)).toEqual({
      notes: 1,
      files: 0,
    });
    // Not zero: unknown. The import then says it did not count them.
    expect(await countZoteroScopeStandalone(transport(true), scope)).toBeNull();
  });

  it("imports metadata when Zotero has no copy of the PDF file", async () => {
    const root = await project();
    const zotero = fakeZoteroAccess(
      fakeZoteroTransport({
        items: new Map([
          [
            "ABCD2345",
            {
              item: zoteroItem("ABCD2345", { title: "Cloud only", abstractNote: "Abstract." }),
              children: [pdfAttachment("PDFA2345", "missing.pdf")],
            },
          ],
        ]),
      }),
    );

    await beginZoteroScopedImport({
      root,
      operationId: "no-file",
      scope: { kind: "library" },
      zotero,
    });
    const operation = await advanceSourceImport({ root, operationId: "no-file", zotero });

    expect(operation.items.map((item) => item.state)).toEqual(["imported"]);
    expect((await listScientSourceRecords(root))[0]?.attachments).toEqual([]);
  });

  it("records a zotero.org import so later steps read zotero.org again", async () => {
    const root = await project();
    const item = zoteroItem("ABCD2345", { title: "Online", abstractNote: "A." }, 475425);
    const paths: string[] = [];
    const http: ZoteroWebHttp = {
      request: async ({ url }) => {
        paths.push(url.pathname);
        if (url.searchParams.get("format") === "keys") {
          const references = url.searchParams.get("itemType") === "-attachment";
          return { status: 200, headers: {}, body: references ? item.key : "" };
        }
        const body =
          url.pathname === "/keys/current"
            ? { userID: 475425, access: { user: { library: true } } }
            : url.pathname.endsWith("/children")
              ? []
              : url.pathname.endsWith("/items/top")
                ? [item]
                : item;
        return { status: 200, headers: {}, body: JSON.stringify(body) };
      },
      download: async () => ({ status: 404 }),
    };
    const zotero = {
      webKey: async () => "synthetic-key",
      http,
      local: fakeZoteroTransport({ items: new Map(), failures: new Map() }),
    };
    const withoutKey = { ...zotero, webKey: async () => null };

    await expect(
      beginZoteroScopedImport({
        root,
        operationId: "web",
        scope: { kind: "library" },
        connection: "web",
        zotero: withoutKey,
      }),
    ).rejects.toThrow(/Accounts/u);
    const started = await beginZoteroScopedImport({
      root,
      operationId: "web",
      scope: { kind: "library" },
      connection: "web",
      zotero,
    });
    const operation = await advanceSourceImport({ root, operationId: "web", zotero });

    expect(started.adapter).toBe("zotero-web");
    expect(operation.items.map((entry) => entry.state)).toEqual(["imported"]);
    expect(paths).toContain("/users/475425/items/ABCD2345");
    expect((await listScientSourceRecords(root))[0]?.externalReferences[0]?.libraryId).toBe(
      "475425",
    );
  });

  it("keeps a group item apart from a My Library item with the same key", async () => {
    const root = await project();
    const entry = (item: ReturnType<typeof zoteroItem>) => ({ item, children: [] });
    const zotero = fakeZoteroAccessWithGroup(
      fakeZoteroTransport({
        items: new Map([
          ["ABCD2345", entry(zoteroItem("ABCD2345", { title: "Mine", abstractNote: "A." }))],
        ]),
      }),
      "4321",
      fakeZoteroTransport({
        items: new Map([
          [
            "ABCD2345",
            entry(zoteroGroupItem("ABCD2345", { title: "The lab's", abstractNote: "A." }, "4321")),
          ],
        ]),
      }),
    );

    for (const [operationId, groupId] of [
      ["mine", undefined],
      ["lab", "4321"],
    ] as const) {
      await beginZoteroScopedImport({
        root,
        operationId,
        scope: { kind: "library" },
        ...(groupId ? { groupId } : {}),
        zotero,
      });
      await advanceSourceImport({ root, operationId, zotero });
    }

    const records = await listScientSourceRecords(root);
    expect(
      new Map(records.map((record) => [record.title, record.externalReferences[0]?.libraryId])),
    ).toEqual(
      new Map([
        ["Mine", "0"],
        ["The lab's", "groups/4321"],
      ]),
    );
  });
});
