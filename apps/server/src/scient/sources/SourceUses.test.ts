// @effect-diagnostics nodeBuiltinImport:off -- Source uses read real project files.
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { initializeScientProject } from "@scientfactory/project-init";
import type { ScientSourceCandidate } from "@scientfactory/scient-sources";
import {
  ensureScientLibrary,
  scientLibraryLocation,
  scientLibraryRootFor,
} from "@scientfactory/scient-sources/library-root";
import { mergeScientLibrarySources } from "@scientfactory/scient-sources/library-merge";
import { pinScientLibrarySource } from "@scientfactory/scient-sources/project-pins";
import { importScientSource } from "@scientfactory/scient-sources/store";
import { afterEach, describe, expect, it } from "@effect/vitest";

import { listCitationKeys, listSourceUses } from "./SourceUses.ts";

const fixtures: string[] = [];

afterEach(async () => {
  await Promise.all(
    fixtures.splice(0).map((root) => NodeFSP.rm(root, { recursive: true, force: true })),
  );
});

const work = (sourceKey: string, title: string, doi: string): ScientSourceCandidate => ({
  sourceKey,
  type: "article",
  customType: null,
  title,
  creators: [
    { creatorType: "author", givenName: "Ada", familyName: "Lovelace", literalName: null },
  ],
  issuedRaw: "2021",
  issuedYear: 2021,
  identifiers: [{ scheme: "doi", value: doi }],
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
});

/** A project pinning one Library source, under two keys after a merge. */
async function fixture() {
  const base = await NodeFSP.realpath(
    await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "scient-source-uses-")),
  );
  fixtures.push(base);
  const libraryRoot = scientLibraryRootFor(NodePath.join(base, "computer"));
  await ensureScientLibrary(libraryRoot);
  const library = scientLibraryLocation(libraryRoot);
  const root = NodePath.join(base, "project");
  await NodeFSP.mkdir(root);
  await initializeScientProject({ root });
  const keys: string[] = [];
  const sourceIds: string[] = [];
  for (const [index, candidate] of [
    work("soil", "Soil carbon budgets", "10.1000/soil"),
    work("soil-copy", "Soil carbon budgets (copy)", "10.1000/soil-copy"),
  ].entries()) {
    const imported = await importScientSource({
      root: library,
      operationId: NodeCrypto.randomUUID(),
      candidate,
      allowPossibleMetadataMatch: true,
    });
    const pinned = await pinScientLibrarySource({
      projectRoot: root,
      library,
      sourceId: imported.record!.sourceId,
      actor: "user",
    });
    if (pinned.outcome === "not-found") throw new Error("Expected a pin.");
    keys[index] = pinned.pin.citationKey;
    sourceIds[index] = imported.record!.sourceId;
  }
  await mergeScientLibrarySources({
    library,
    sourceIds: [sourceIds[0]!, sourceIds[1]!],
    survivorId: sourceIds[0]!,
  });
  const write = async (path: string, text: string | Buffer) => {
    const absolute = NodePath.join(root, ...path.split("/"));
    await NodeFSP.mkdir(NodePath.dirname(absolute), { recursive: true });
    await NodeFSP.writeFile(absolute, text);
  };
  const uses = () => listSourceUses({ root, library, sourceId: sourceIds[0]! });
  const citationKeys = (path: string, citationKeys: ReadonlyArray<string>) =>
    listCitationKeys({ root, library, path, keys: citationKeys });
  return {
    root,
    keys: keys as [string, string],
    sourceId: sourceIds[0]!,
    write,
    uses,
    citationKeys,
  };
}

describe("where a project's documents cite a source", () => {
  it("counts the project's keys in Markdown and LaTeX and resolves each document's own bibliography", async () => {
    const { keys, write, uses } = await fixture();
    const [first, second] = keys;
    const before = await uses();
    expect(before).toMatchObject({ occurrences: [], elsewhere: [], skipped: [], complete: true });
    await write(
      "notes/one.md",
      `# Notes\n\nIntro [see @${first.toUpperCase()}, p. 4].\nLater @${second} said so.\n`,
    );
    await write("two.md", `---\nbibliography: references.bib\n---\n\nAs shown [@${first}].\n`);
    await write(
      "references.bib",
      `@article{${first}, title={Soil carbon budgets}, doi={10.1000/soil}}\n`,
    );
    await write("other.md", "Nothing cites it @someone.\n");
    await write(
      "paper/main.tex",
      `\\section{A}\nAs \\citep[p.~7]{${second}} and \\cite{${first}}.\n\\bibliography{refs}\n`,
    );
    await write(
      "paper/refs.bib",
      `@article{${first}, title={Other}, doi={10.1000/other}}\n@article{${second}, title={Soil}, doi={10.1000/SOIL}}\n`,
    );
    await write("draft/draft.tex", `See \\cite{${first}}.\n\\addbibresource{plain.bib}\n`);
    await write("draft/plain.bib", `@article{${first}, title={Soil carbon budgets}}\n`);
    // Bibliography membership only: listed, not counted.
    await write("lists.tex", `Text.\n\\nocite{${second}}\n`);

    const result = await uses();
    expect(result.citationKeys).toEqual([first, second].toSorted());
    expect(result.complete).toBe(true);
    expect(result.documents).toBe(before.documents + 6);
    expect(result.listed).toEqual([{ path: "lists.tex", line: 2, citationKey: second }]);
    expect(
      result.occurrences.map(({ path, line, citationKey, locator, through }) => ({
        path,
        line,
        citationKey,
        locator,
        through,
      })),
    ).toEqual([
      {
        path: "two.md",
        line: 5,
        citationKey: first,
        locator: null,
        through: { kind: "project" },
      },
      {
        path: "draft/draft.tex",
        line: 1,
        citationKey: first,
        locator: null,
        through: { kind: "bibliography", path: "draft/plain.bib", confirmed: false },
      },
      {
        path: "notes/one.md",
        line: 3,
        citationKey: first.toUpperCase(),
        locator: "p. 4",
        through: { kind: "project" },
      },
      {
        path: "notes/one.md",
        line: 4,
        citationKey: second,
        locator: null,
        through: { kind: "project" },
      },
      {
        path: "paper/main.tex",
        line: 2,
        citationKey: second,
        locator: "p.~7",
        through: { kind: "bibliography", path: "paper/refs.bib", confirmed: true },
      },
    ]);
    expect(result.occurrences[2]).toMatchObject({
      context: `Intro [see @${first.toUpperCase()}, p. 4].`,
      contextCitation: { start: 6 },
    });
    expect(result.elsewhere).toEqual([
      { path: "paper/main.tex", key: first, bibliography: "paper/refs.bib" },
    ]);
  });

  it("is incomplete when a document or a named bibliography could not be read", async () => {
    const { keys, write, uses } = await fixture();
    const before = await uses();
    await write("large.md", Buffer.alloc(16 * 1024 * 1024 + 1, "a"));
    await write("main.tex", `\\cite{${keys[0]}}\n\\bibliography{missing}\n`);

    const result = await uses();
    expect(result.complete).toBe(false);
    expect(result.documents).toBe(before.documents + 1);
    expect(result.skipped).toEqual([
      { path: "large.md", reason: "Larger than 16 MB." },
      { path: "missing.bib", reason: expect.stringContaining("missing.bib") },
    ]);
    expect(result.occurrences.map(({ through }) => through)).toEqual([
      { kind: "bibliography", path: "missing.bib", confirmed: false },
    ]);
  });

  // regression: a key in references.bib was counted as the project's work without reading it.
  it("reads the project's references.bib and references.json like any bibliography", async () => {
    const { keys, write, uses } = await fixture();
    const [first] = keys;
    await write("edited.md", `---\nbibliography: references.bib\n---\n\nAs [@${first}].\n`);
    await write(
      "references.bib",
      `@article{${first}, title={Soil carbon budgets}, doi={10.1000/other}}\n`,
    );
    await write("missing.md", `---\nbibliography: references.json\n---\n\nAs [@${first}].\n`);

    const result = await uses();
    expect(result.elsewhere).toEqual([
      { path: "edited.md", key: first, bibliography: "references.bib" },
    ]);
    expect(result.occurrences.map(({ path, through }) => ({ path, through }))).toEqual([
      {
        path: "missing.md",
        through: { kind: "bibliography", path: "references.json", confirmed: false },
      },
    ]);
    expect(result.skipped).toEqual([
      { path: "references.json", reason: expect.stringContaining("references.json") },
    ]);
    expect(result.complete).toBe(false);
  });

  // regression: an included file was counted as citing the source although the bibliography of
  // the document including it gives the key to another work.
  it("reads an included LaTeX file with the bibliography of the document including it", async () => {
    const { keys, write, uses } = await fixture();
    const [first] = keys;
    await write(
      "main.tex",
      `\\documentclass{article}\n\\bibliography{own}\n\\cite{${first}}\n\\input{chapters/one}\n`,
    );
    await write("own.bib", `@article{${first}, title={Other}, doi={10.1000/other}}\n`);
    await write("chapters/one.tex", `As \\cite{${first}}.\n`);

    const result = await uses();
    expect(result.occurrences).toEqual([]);
    expect(result.elsewhere).toEqual([
      { path: "main.tex", key: first, bibliography: "own.bib" },
      { path: "chapters/one.tex", key: first, bibliography: "own.bib" },
    ]);
    expect(result.complete).toBe(true);
  });
});

describe("what a document's citation keys name", () => {
  it("reads each key with the document's bibliography, aliases included", async () => {
    const { keys, sourceId, write, citationKeys } = await fixture();
    const [first, second] = keys;
    await write("paper/main.tex", `\\documentclass{article}\n\\bibliography{refs}\n`);
    await write(
      "paper/refs.bib",
      `@article{${first}, title={Other}, doi={10.1000/other}}\n@article{${second}, title={Soil}, doi={10.1000/SOIL}}\n`,
    );
    await write("notes.md", `As [@${second}].\n`);

    expect(await citationKeys("paper/main.tex", [first, second, "nobody"])).toEqual({
      keys: [
        { key: first, status: "other-work", sourceIds: [], bibliography: "paper/refs.bib" },
        { key: second, status: "library", sourceIds: [sourceId], bibliography: "paper/refs.bib" },
        { key: "nobody", status: "not-library", sourceIds: [], bibliography: null },
      ],
      complete: true,
    });
    // `second` is the key the source kept from the merged duplicate.
    expect(await citationKeys("notes.md", [second.toUpperCase()])).toEqual({
      keys: [
        {
          key: second.toUpperCase(),
          status: "library",
          sourceIds: [sourceId],
          bibliography: null,
        },
      ],
      complete: true,
    });
  });
});
