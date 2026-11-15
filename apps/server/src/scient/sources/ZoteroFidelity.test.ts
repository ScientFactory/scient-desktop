// @effect-diagnostics nodeBuiltinImport:off -- This test reads a recorded Zotero library from a fixture file.
import * as NodeFSP from "node:fs/promises";

import { notBroughtName } from "@scientfactory/scient-sources";
import { describe, expect, it } from "@effect/vitest";

import {
  decodeZoteroRawItem,
  decodeZoteroRawItems,
  zoteroFieldDispositions,
  zoteroItemMaterial,
  ZOTERO_PDFS_PER_ITEM,
} from "./ZoteroItems.ts";

/**
 * Real references from a public Zotero library made to exercise every item type and field
 * (`fixtures/zotero-public-test-items.json`; how it is built is in the file's `from` line).
 * The rule checked here: everything Zotero sends for a reference is either brought, or listed
 * as not brought, or is Zotero's own bookkeeping. Nothing falls outside the three.
 */
interface Entry {
  readonly item: { readonly data: Readonly<Record<string, unknown>> };
  readonly children: ReadonlyArray<unknown>;
}

async function entries(): Promise<ReadonlyArray<Entry>> {
  const fixture = JSON.parse(
    await NodeFSP.readFile(
      new URL("./fixtures/zotero-public-test-items.json", import.meta.url),
      "utf8",
    ),
  ) as { readonly entries: ReadonlyArray<Entry> };
  return fixture.entries;
}

/** The parts of an item that are not text, each accounted for by name below. */
const NOT_TEXT = new Set(["version", "creators", "tags", "collections", "relations"]);

describe("what a Zotero import brings, on real references", () => {
  it("accounts for every field and every child of every reference", async () => {
    const all = await entries();
    expect(all.length).toBeGreaterThan(35);
    for (const entry of all) {
      const item = decodeZoteroRawItem(entry.item);
      const children = decodeZoteroRawItems(entry.children);
      const material = zoteroItemMaterial(item, children);
      const where = `${item.data.itemType} ${item.key}`;
      const brought = JSON.stringify([material.candidate, material.citationKey]);
      const dispositions = zoteroFieldDispositions(item);

      for (const [name, value] of Object.entries(entry.item.data)) {
        if (typeof value !== "string") {
          // Anything Zotero sends that is not text must be a part this test knows.
          if (value !== null && typeof value === "object") {
            expect(NOT_TEXT.has(name), `${where}: ${name}`).toBe(true);
          }
          continue;
        }
        if (!value.trim()) continue;
        const disposition = dispositions.get(name);
        expect(disposition, `${where}: ${name} has no disposition`).toBeDefined();
        if (disposition === "brought") {
          // The abstract is normalised; every other brought field arrives as Zotero has it.
          if (name !== "abstractNote" && name !== "citationKey") {
            expect(brought, `${where}: ${name}`).toContain(
              JSON.stringify(value.trim()).slice(1, -1),
            );
          }
        } else if (disposition === "not-brought") {
          expect(material.notBrought, `${where}: ${name}`).toContainEqual({
            kind: "field",
            name,
            count: 1,
          });
        }
      }

      // A case's name, an act's name and an email's subject are their titles.
      if (["title", "caseName", "nameOfAct", "subject"].some((name) => entry.item.data[name])) {
        expect(material.candidate.title, `${where}: title`).toBeTruthy();
      }
      // Creators and tags all arrive; the collections are named for the import to file.
      const creators = (entry.item.data.creators ?? []) as ReadonlyArray<Record<string, string>>;
      expect(material.candidate.creators, where).toHaveLength(
        creators.filter((creator) => creator.name || creator.firstName || creator.lastName).length,
      );
      const tags = (entry.item.data.tags ?? []) as ReadonlyArray<{ readonly tag: string }>;
      expect(material.candidate.tags, where).toEqual(
        tags.map(({ tag }) => tag.trim()).filter(Boolean),
      );
      expect(material.collectionKeys, where).toEqual(entry.item.data.collections ?? []);

      // Every child is a PDF that is copied, a note that is read, or is counted as not brought.
      const counted = (kind: string) =>
        material.notBrought
          .filter((line) => line.kind === kind)
          .reduce((sum, line) => sum + line.count, 0);
      const notes = children.filter((child) => child.data.itemType === "note").length;
      const attachments = children.filter((child) => child.data.itemType === "attachment").length;
      expect(children, where).toHaveLength(notes + attachments);
      expect(
        Math.min(material.pdfs.length, ZOTERO_PDFS_PER_ITEM) +
          counted("pdf") +
          counted("file") +
          counted("link"),
        where,
      ).toBe(attachments);
      if (notes > 0) expect(material.note, where).toBeTruthy();
    }
  });

  it("lists what today's import does not bring; this list may only get shorter", async () => {
    const references = new Map<string, number>();
    for (const entry of await entries()) {
      const material = zoteroItemMaterial(
        decodeZoteroRawItem(entry.item),
        decodeZoteroRawItems(entry.children),
      );
      for (const line of material.notBrought) {
        const name = notBroughtName({ kind: line.kind, name: line.name ?? null });
        references.set(name, (references.get(name) ?? 0) + 1);
      }
    }
    const lines = [...references]
      .toSorted(([a, x], [b, y]) => y - x || a.localeCompare(b))
      .map(([name, count]) => `${name}: ${count}`);
    expect(lines).toMatchInlineSnapshot(`
      [
        "Notes whose links, headings, tables, images or code became plain text: 23",
        "Automatic tags, which came in as ordinary tags: 6",
        "Links kept as attachments: 4",
        "Files (application/xml): 1",
        "Web page snapshots: 1",
      ]
    `);
  });
});
