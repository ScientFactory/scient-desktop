// @effect-diagnostics nodeBuiltinImport:off -- This test reads a recorded Zotero library from a fixture file.
import * as NodeFSP from "node:fs/promises";

import { notBroughtName } from "@scientfactory/scient-sources";
import { formatBibliography } from "@scientfactory/scient-sources/bibliography";
import { scientSourceToCslJson } from "@scientfactory/scient-citations";
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
      // Each field is where the import says it put it, as Zotero has it: not merely somewhere.
      for (const { field, sourceField } of material.candidate.fieldProvenance) {
        const raw = sourceField ? entry.item.data[sourceField] : undefined;
        if (typeof raw !== "string" || field === "abstract" || sourceField === "extra") continue;
        const arrived = field.startsWith("more.")
          ? material.candidate.more?.[field.slice("more.".length)]
          : (material.candidate as unknown as Record<string, unknown>)[field];
        if (typeof arrived === "string") expect(arrived, `${where}: ${field}`).toBe(raw.trim());
      }
      // Creators and tags all arrive, with the creators Extra names after the item's own.
      const creators = (entry.item.data.creators ?? []) as ReadonlyArray<Record<string, string>>;
      const own = creators.filter(
        (creator) => creator.name || creator.firstName || creator.lastName,
      ).length;
      expect(material.candidate.creators.length, where).toBeGreaterThanOrEqual(own);
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

  it("carries a report's number to its citation and to a .bib file, and reads a creator from Extra", async () => {
    const all = await entries();
    const report = all.find((entry) => entry.item.data.reportNumber === "ED504790");
    if (!report) throw new Error("The fixture's report is gone.");
    const { candidate } = zoteroItemMaterial(
      decodeZoteroRawItem(report.item),
      decodeZoteroRawItems(report.children),
    );
    expect(candidate).toMatchObject({ type: "report", more: { number: "ED504790" } });
    const record = {
      formatVersion: 1 as const,
      sourceId: "source_report",
      projectId: "project_1",
      revision: 1,
      ...candidate,
      customType: null,
      attachments: [],
      importedAt: "2026-11-15T09:00:00.000Z",
    };
    expect(scientSourceToCslJson(record)).toMatchObject({ type: "report", number: "ED504790" });
    expect(
      formatBibliography([{ record, citationKey: "report" }], "bibtex", { includeNotes: false }),
    ).toContain("number = {ED504790}");

    // `interviewer: Mosley || Tonya` in Extra is a creator, as Zotero cites it.
    const interview = all.find((entry) =>
      String(entry.item.data.extra ?? "").includes("interviewer: Mosley || Tonya"),
    );
    if (!interview) throw new Error("The fixture's interview is gone.");
    const read = zoteroItemMaterial(decodeZoteroRawItem(interview.item), []).candidate;
    expect(read.creators).toContainEqual({
      creatorType: "interviewer",
      givenName: "Tonya",
      familyName: "Mosley",
      literalName: null,
    });
    expect(read.more?.extra ?? "").not.toContain("interviewer:");
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
