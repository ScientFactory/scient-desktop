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
        "Rights: 28",
        "Notes whose links, headings, tables, images or code became plain text: 23",
        "Date accessed: 20",
        "Library catalogue: 18",
        "Place of publication: 10",
        "Short title: 8",
        "Automatic tags, which came in as ordinary tags: 6",
        "Extra line “genre”: 6",
        "Archive: 5",
        "Links kept as attachments: 4",
        "Call number: 3",
        "Extra line “container-title”: 3",
        "Number of volumes: 3",
        "Series: 3",
        "Video recording format: 3",
        "Audio recording format: 2",
        "Code: 2",
        "Edition: 2",
        "Episode number: 2",
        "Extra line “archive_collection”: 2",
        "Extra line “archive-place”: 2",
        "Extra line “issued”: 2",
        "Extra line “oclc”: 2",
        "Extra line “status”: 2",
        "Extra line “type”: 2",
        "Extra line “volume-title”: 2",
        "Journal abbreviation: 2",
        "Legislative body: 2",
        "Location in archive: 2",
        "Network: 2",
        "Program title: 2",
        "Report number: 2",
        "Running time: 2",
        "Series number: 2",
        "Thesis type: 2",
        "Application number: 1",
        "Assignee: 1",
        "Audio file type: 1",
        "Bill number: 1",
        "Case name: 1",
        "Code number: 1",
        "Code pages: 1",
        "Code volume: 1",
        "Conference name: 1",
        "Country: 1",
        "Date decided: 1",
        "Date enacted: 1",
        "Distributor: 1",
        "Event place: 1",
        "Extra line “archive place”: 1",
        "Extra line “author role”: 1",
        "Extra line “author”: 1",
        "Extra line “collection-title”: 1",
        "Extra line “container title”: 1",
        "Extra line “dimensions”: 1",
        "Extra line “event-date”: 1",
        "Extra line “interviewer”: 1",
        "Extra line “issn”: 1",
        "Extra line “number”: 1",
        "Files (application/xml): 1",
        "Filing date: 1",
        "First page: 1",
        "Format: 1",
        "Genre: 1",
        "History: 1",
        "Identifier: 1",
        "Interview medium: 1",
        "Issue date: 1",
        "Issuing authority: 1",
        "Label: 1",
        "Manuscript type: 1",
        "Map type: 1",
        "Meeting name: 1",
        "Name of act: 1",
        "Number: 1",
        "Number of pages: 1",
        "Organization: 1",
        "Patent number: 1",
        "PMCID: 1",
        "Presentation type: 1",
        "Programming language: 1",
        "Public law number: 1",
        "Report type: 1",
        "Reporter: 1",
        "Reporter volume: 1",
        "Section: 1",
        "Session title: 1",
        "Status: 1",
        "System: 1",
        "Type: 1",
        "Web page snapshots: 1",
        "Website type: 1",
      ]
    `);
  });
});
