// @effect-diagnostics nodeBuiltinImport:off -- This test exercises the real project filesystem boundary.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { initializeScientProject } from "@scientfactory/project-init";
import { readScientSourcesOrganization } from "@scientfactory/scient-sources/collections";
import { listScientSourceRecords } from "@scientfactory/scient-sources/store";
import { afterEach, describe, expect, it } from "@effect/vitest";

import { advanceSourceImport, beginZoteroScopedImport } from "./ScientSourcesCoordinator.ts";
import { fakeZoteroAccess, fakeZoteroTransport, zoteroItem } from "./Zotero.testkit.ts";
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
});
