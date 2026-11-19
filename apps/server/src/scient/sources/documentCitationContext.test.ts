// @effect-diagnostics nodeBuiltinImport:off -- Citation contexts read real project files.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { referenceDocumentKind } from "@scientfactory/scient-sources";
import { afterEach, describe, expect, it } from "@effect/vitest";

import { createProjectCitationContext, type ProjectWork } from "./documentCitationContext.ts";

const fixtures: string[] = [];

afterEach(async () => {
  await Promise.all(
    fixtures.splice(0).map((root) => NodeFSP.rm(root, { recursive: true, force: true })),
  );
});

const SOIL: ProjectWork = {
  sourceId: "source-soil",
  citationKey: "soil2021",
  identifiers: [{ scheme: "doi", value: "10.1000/soil" }],
  title: "Soil carbon budgets",
  year: 2021,
};
const BOOK: ProjectWork = {
  sourceId: "source-book",
  citationKey: "book1999",
  identifiers: [{ scheme: "isbn", value: "9780000000002" }],
  title: "A Field Guide to Soils",
  year: 1999,
};

/** A project with these files; `null` makes a folder where a file is expected. */
async function project(files: Readonly<Record<string, string | null>>) {
  const root = await NodeFSP.realpath(
    await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "scient-citation-context-")),
  );
  fixtures.push(root);
  for (const [path, text] of Object.entries(files)) {
    const absolute = NodePath.join(root, ...path.split("/"));
    if (text === null) {
      await NodeFSP.mkdir(absolute, { recursive: true });
      continue;
    }
    await NodeFSP.mkdir(NodePath.dirname(absolute), { recursive: true });
    await NodeFSP.writeFile(absolute, text);
  }
  const latexPaths = Object.keys(files).filter(
    (path) => files[path] !== null && referenceDocumentKind(path) === "latex",
  );
  /** What `keys` name in `path`, and the bibliographies its contexts could not read. */
  return async (path: string, keys: ReadonlyArray<string>) => {
    const context = createProjectCitationContext({ root, latexPaths, works: [SOIL, BOOK] });
    const text = await context.text(path);
    if (typeof text !== "string") throw new Error(`Expected ${path} to be readable.`);
    const kind = referenceDocumentKind(path);
    if (kind !== "markdown" && kind !== "latex") throw new Error("Expected a document.");
    const document = await context.document(path, kind, text);
    return {
      keys: Object.fromEntries(keys.map((key) => [key, document.resolve(key)])),
      problems: document.problems.map((problem) => problem.path),
    };
  };
}

describe("a document's citation keys, read with its bibliographies", () => {
  it("reads a Markdown document with its front matter's bibliography", async () => {
    const resolve = await project({
      "notes.md": "---\nbibliography: own.bib\n---\n\n[@SOIL2021; @book1999; @someone]\n",
      "own.bib": "@article{soil2021, title={Other}, doi={10.1000/other}}\n",
      "plain.md": "As [@soil2021].\n",
    });
    expect((await resolve("notes.md", ["SOIL2021", "book1999", "someone"])).keys).toEqual({
      SOIL2021: { status: "other-work", sourceIds: [], bibliography: "own.bib" },
      // It names a bibliography that does not define the key.
      book1999: { status: "unconfirmed", sourceIds: ["source-book"], bibliography: "own.bib" },
      someone: { status: "not-library", sourceIds: [], bibliography: null },
    });
    expect((await resolve("plain.md", ["soil2021"])).keys).toEqual({
      soil2021: { status: "library", sourceIds: ["source-soil"], bibliography: null },
    });
  });

  // regression: an included file was read without the bibliography of the document including it.
  it("reads an included LaTeX file with its root document's bibliography", async () => {
    const resolve = await project({
      "main.tex":
        "\\documentclass{article}\n\\bibliography{own}\n\\input{chapters/one}\n\\include{chapters/two}\n",
      "own.bib": "@article{soil2021, title={Other}, doi={10.1000/other}}\n",
      "chapters/one.tex": "As \\cite{soil2021}.\n",
      // Paths are read from the root document's folder, not the included file's.
      "chapters/two.tex": "\\input{chapters/three}\n",
      "chapters/three.tex": "As \\cite{soil2021}.\n",
      "loose.tex": "As \\cite{soil2021}.\n",
    });
    const other = { status: "other-work", sourceIds: [], bibliography: "own.bib" };
    expect((await resolve("chapters/one.tex", ["soil2021"])).keys).toEqual({ soil2021: other });
    expect((await resolve("chapters/three.tex", ["soil2021"])).keys).toEqual({ soil2021: other });
    // No root includes it and it names no bibliography.
    expect((await resolve("loose.tex", ["soil2021"])).keys).toEqual({
      soil2021: { status: "library", sourceIds: ["source-soil"], bibliography: null },
    });
  });

  it("leaves a key open in a file two root documents include with bibliographies that disagree", async () => {
    const resolve = await project({
      "a.tex": "\\documentclass{article}\n\\addbibresource{a.bib}\n\\include{shared}\n",
      "a.bib": "@article{soil2021, title={Soil}, doi={10.1000/SOIL}}\n",
      "b.tex": "\\documentclass{article}\n\\bibliography{b}\n\\input{shared.tex}\n",
      "b.bib": "@article{soil2021, title={Other}, doi={10.1000/other}}\n",
      "shared.tex": "As \\cite{soil2021}.\n",
    });
    expect((await resolve("shared.tex", ["soil2021"])).keys).toEqual({
      soil2021: { status: "unconfirmed", sourceIds: ["source-soil"], bibliography: "a.bib" },
    });
    expect((await resolve("a.tex", ["soil2021"])).keys).toEqual({
      soil2021: { status: "library", sourceIds: ["source-soil"], bibliography: "a.bib" },
    });
  });

  // regression: the project's own references.bib was taken as proof of its contents.
  it("reads the project's references.bib in a root document that includes the file", async () => {
    const resolve = await project({
      "paper/main.tex":
        "\\documentclass{article}\n\\bibliography{../references}\n\\subfile{sections/intro}\n\\import{appendix/}{extra}\n",
      "paper/sections/intro.tex": "\\documentclass[../main.tex]{subfiles}\nAs \\cite{soil2021}.\n",
      "paper/appendix/extra.tex": "As \\cite{soil2021}.\n",
      "references.bib": "@article{soil2021, title={Soil carbon budgets}, doi={10.1000/other}}\n",
    });
    const other = { status: "other-work", sourceIds: [], bibliography: "references.bib" };
    expect((await resolve("paper/sections/intro.tex", ["soil2021"])).keys).toEqual({
      soil2021: other,
    });
    expect((await resolve("paper/appendix/extra.tex", ["soil2021"])).keys).toEqual({
      soil2021: other,
    });
  });

  it("leaves a key open when the project's references file is missing or unreadable", async () => {
    const resolve = await project({
      "missing.md": "---\nbibliography: references.bib\n---\n\n[@soil2021]\n",
      "unreadable.md": "---\nbibliography: references.json\n---\n\n[@soil2021]\n",
      "references.json": null,
    });
    expect(await resolve("missing.md", ["soil2021"])).toEqual({
      keys: {
        soil2021: {
          status: "unconfirmed",
          sourceIds: ["source-soil"],
          bibliography: "references.bib",
        },
      },
      problems: ["references.bib"],
    });
    expect(await resolve("unreadable.md", ["soil2021"])).toEqual({
      keys: {
        soil2021: {
          status: "unconfirmed",
          sourceIds: ["source-soil"],
          bibliography: "references.json",
        },
      },
      problems: ["references.json"],
    });
  });

  it("compares titles and years when neither side has a DOI, PMID or arXiv ID", async () => {
    const resolve = await project({
      "managed.md": "---\nbibliography: references.bib\n---\n\n[@book1999]\n",
      "references.bib": "@book{book1999, title={A {Field} Guide to Soils}, year={1999}}\n",
      "edited.md": "---\nbibliography: references.json\n---\n\n[@book1999]\n",
      "references.json": JSON.stringify([
        { id: "book1999", title: "Soil Physics", issued: { "date-parts": [[1999]] } },
      ]),
      "own.md": "---\nbibliography: own.bib\n---\n\n[@book1999]\n",
      "own.bib": "@book{book1999, title={A field guide to sóils.}, date={1999-05}}\n",
      "year.md": "---\nbibliography: year.bib\n---\n\n[@book1999]\n",
      "year.bib": "@book{book1999, title={A Field Guide to Soils}, year={2004}}\n",
      "untitled.md": "---\nbibliography: untitled.bib\n---\n\n[@book1999]\n",
      "untitled.bib": "@book{book1999, year={1999}}\n",
    });
    const book = (path: string) => resolve(path, ["book1999"]).then(({ keys }) => keys["book1999"]);
    expect(await book("managed.md")).toEqual({
      status: "library",
      sourceIds: ["source-book"],
      bibliography: "references.bib",
    });
    expect(await book("edited.md")).toEqual({
      status: "other-work",
      sourceIds: [],
      bibliography: "references.json",
    });
    expect(await book("own.md")).toEqual({
      status: "library",
      sourceIds: ["source-book"],
      bibliography: "own.bib",
    });
    expect(await book("year.md")).toMatchObject({ status: "other-work" });
    expect(await book("untitled.md")).toEqual({
      status: "unconfirmed",
      sourceIds: ["source-book"],
      bibliography: "untitled.bib",
    });
  });
});
