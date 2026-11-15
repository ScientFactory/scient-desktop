// @effect-diagnostics nodeBuiltinImport:off -- Reference check tests exercise the real project filesystem boundary.
// @effect-diagnostics globalDate:off -- A fixed clock makes report timestamps deterministic.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeStreamConsumers from "node:stream/consumers";

import { initializeScientProject } from "@scientfactory/project-init";
import type { ScientReferenceCheckReport } from "@scientfactory/scient-sources";
import { listScientSourceRecords } from "@scientfactory/scient-sources/store";
import { describe, expect, it } from "@effect/vitest";
import * as yazl from "yazl";

import { addAgentSource } from "../sources/ScientSourcesCoordinator.ts";
import {
  verifiableSourceIdentifier,
  type ResolvedSourceMetadata,
  type SourceIdentifierResolution,
} from "../sources/SourceIdentifierResolver.ts";
import {
  checkReferences,
  listReferenceDocuments,
  ReferenceCheckError,
  type ResolveIdentifierBatch,
} from "./ReferenceCheck.ts";
import { resolveReferenceFindings } from "./ReferenceResolution.ts";

const now = () => new Date("2026-11-10T12:00:00.000Z");

async function project() {
  const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "scient-reference-check-"));
  await initializeScientProject({ root });
  return {
    root,
    write: (path: string, contents: string | Uint8Array) =>
      NodeFSP.mkdir(NodePath.dirname(NodePath.join(root, path)), { recursive: true }).then(() =>
        NodeFSP.writeFile(NodePath.join(root, path), contents),
      ),
    read: (path: string) => NodeFSP.readFile(NodePath.join(root, path), "utf8"),
    [Symbol.asyncDispose]: () => NodeFSP.rm(root, { recursive: true, force: true }),
  };
}

function metadata(fields: Partial<ResolvedSourceMetadata>): ResolvedSourceMetadata {
  return {
    type: "article",
    title: null,
    creators: [],
    issuedRaw: null,
    issuedYear: null,
    identifiers: [],
    abstract: null,
    abstractSections: [],
    containerTitle: null,
    publisher: null,
    volume: null,
    issue: null,
    pages: null,
    language: null,
    url: null,
    ...fields,
  };
}

const author = (familyName: string) => ({
  creatorType: "author",
  givenName: "A.",
  familyName,
  literalName: null,
});

/** A recorded registry keyed by scheme and identifier; anything else is not registered. */
function registry(
  works: Readonly<Record<string, ResolvedSourceMetadata | "unavailable">>,
): ResolveIdentifierBatch & { readonly asked: Array<string> } {
  const asked: Array<string> = [];
  const lookup: ResolveIdentifierBatch = async (identifiers) =>
    identifiers.map((input): SourceIdentifierResolution => {
      const identifier = verifiableSourceIdentifier([input]) ?? input;
      const key = `${identifier.scheme}:${identifier.value}`;
      asked.push(key);
      const work = works[key];
      if (work === "unavailable") return { status: "unavailable", identifier };
      if (!work) return { status: "not-found", identifier };
      return { status: "found", identifier, metadata: work, retrievedAt: now().toISOString() };
    });
  return Object.assign(lookup, { asked });
}

const kinds = (report: ScientReferenceCheckReport) =>
  report.findings.map((finding) => `${finding.key ?? finding.sourceId}:${finding.kind}`).sort();

type LibraryCandidate = Parameters<typeof addAgentSource>[0]["candidate"];

async function addLibrarySource(root: string, changes: Partial<LibraryCandidate> = {}) {
  await addAgentSource({
    root,
    resolveIdentifier: async (identifiers) => {
      const identifier = verifiableSourceIdentifier(identifiers);
      return identifier ? { status: "unavailable", identifier } : null;
    },
    candidate: {
      sourceKey: "smith",
      type: "article",
      customType: null,
      title: "The effect of light on sleep",
      creators: [author("Smith")],
      issuedRaw: "2020",
      issuedYear: 2020,
      identifiers: [{ scheme: "doi", value: "10.1000/smith" }],
      abstract: null,
      containerTitle: "Journal of Sleep Research",
      publisher: null,
      volume: "12",
      issue: null,
      pages: "100-110",
      language: null,
      url: null,
      tags: [],
      externalReferences: [],
      fieldProvenance: [],
      pdfAvailable: false,
      pdfFileName: null,
      pdfAttachmentCount: 0,
      ...changes,
    },
  });
}

const SMITH = metadata({
  title: "The effect of light on sleep",
  creators: [author("Smith")],
  issuedYear: 2021,
  containerTitle: "Journal of Sleep Research",
  volume: "12",
  pages: "100-110",
});

const works = {
  "doi:10.1000/smith": SMITH,
  "doi:10.1000/wrong": metadata({
    title: "Feeding behaviour of reef fish",
    creators: [author("Okafor")],
    issuedYear: 2015,
  }),
  "doi:10.1000/retracted": metadata({
    title: "RETRACTED: Vaccines and autism",
    creators: [author("Wakefield")],
    issuedYear: 1998,
    containerTitle: "The Lancet",
    updates: [{ type: "retraction", doi: "10.1000/notice", date: "2010-02-06", source: null }],
  }),
  "arxiv:2101.00001": metadata({
    type: "preprint",
    title: "Attention for everything",
    creators: [author("Lee")],
    issuedYear: 2021,
    identifiers: [
      { scheme: "arxiv", value: "2101.00001" },
      { scheme: "doi", value: "10.1000/published" },
    ],
  }),
  "doi:10.1000/slow": "unavailable",
} as const;

const BIB = `@article{smith2020,
  author = {Smith, Jane},
  title = {The effect of light on sleep},
  journal = {Journal of Sleep Research},
  year = {2020},
  volume = {12},
  pages = {100--110},
  doi = {10.1000/smith},
}
@article{wrong2019, author = {Doe, A.}, title = {Sleep in shift workers}, journal = {Sleep}, year = 2019, doi = {10.1000/wrong}}
@article{ghost, author = {Roe, B.}, title = {A study that was never published}, journal = {Nature}, year = 2020, doi = {10.1000/missing}}
@article{wakefield1998, author = {Wakefield, A.}, title = {Vaccines and autism}, journal = {Lancet}, year = 1998, doi = {10.1000/retracted}}
@misc{lee2021, author = {Lee, K.}, title = {Attention for everything}, eprint = {2101.00001}, archivePrefix = {arXiv}, year = 2021}
@book{handbook, author = {Ng, C.}, title = {Handbook of sleep}, year = 2010}
@article{slow, author = {Fay, D.}, title = {Slow registry}, journal = {J}, year = 2020, doi = {10.1000/slow}}
@article{uncited, author = {Smith, Jane}, title = {The effect of light on sleep}, journal = {J Sleep Res}, year = 2021, doi = {10.1000/smith}}
`;

const TEX = `\\documentclass{article}
\\begin{document}
Light matters \\cite{smith2020,wrong2019}. Others \\citep{ghost, wakefield1998}.
See \\citet{lee2021} and \\cite{handbook, slow, absent}.
\\bibliography{refs}
\\end{document}
`;

describe("checkReferences", () => {
  it("checks a LaTeX document and its bibliography against the registry", async () => {
    await using fixture = await project();
    await fixture.write("paper/main.tex", TEX);
    await fixture.write("paper/refs.bib", BIB);
    const lookup = registry(works);

    const report = await checkReferences(
      { root: fixture.root, target: { kind: "file", path: "paper/main.tex" } },
      { resolveIdentifiers: lookup, now },
    );

    expect(report.files).toEqual(["paper/main.tex", "paper/refs.bib"]);
    expect({
      references: report.references,
      citations: report.citations,
      checked: report.checked,
      noIdentifier: report.noIdentifier,
      unavailable: report.unavailable,
      complete: report.complete,
    }).toEqual({
      references: 8,
      citations: 8,
      checked: 6,
      noIdentifier: 1,
      unavailable: 1,
      complete: false,
    });
    expect(kinds(report)).toEqual([
      "absent:cited-not-listed",
      "ghost:identifier-not-found",
      "handbook:missing-field",
      "lee2021:published-version",
      "smith2020:details-differ",
      "uncited:listed-not-cited",
      "uncited:same-work",
      "wakefield1998:retracted",
      "wrong2019:identifier-mismatch",
    ]);
    expect(report.findings[0]?.severity).toBe("problem");
    const yearFix = report.findings.find((finding) => finding.key === "smith2020");
    expect(yearFix).toMatchObject({
      location: { path: "paper/refs.bib", line: 1 },
      fix: {
        kind: "bibtex-field",
        path: "paper/refs.bib",
        key: "smith2020",
        field: "year",
        current: "2020",
        value: "2021",
      },
    });
    expect(report.findings.find((finding) => finding.kind === "retracted")?.related).toEqual({
      label: "Retraction notice",
      url: "https://doi.org/10.1000/notice",
    });
    expect(report.findings.find((finding) => finding.kind === "identifier-mismatch")?.message).toBe(
      "DOI 10.1000/wrong belongs to a different work: “Feeding behaviour of reef fish” (Okafor, 2015).",
    );
    expect(lookup.asked.filter((asked) => asked === "doi:10.1000/smith")).toHaveLength(1);
    expect(lookup.asked).toContain("arxiv:2101.00001");
    expect(
      Object.fromEntries(report.ledger.map((entry) => [entry.key, entry.status])),
    ).toMatchObject({
      smith2020: "ok",
      ghost: "problem",
      wakefield1998: "problem",
      handbook: "no-identifier",
      slow: "unavailable",
    });
    expect(report.notes).toContain(
      "One reference could not be checked because the registry did not answer. Check again later.",
    );
  });

  it("applies a registry fix to the .bib file and refuses one made stale by an edit", async () => {
    await using fixture = await project();
    await fixture.write("refs.bib", BIB);
    const target = { kind: "file", path: "refs.bib" } as const;
    const first = await checkReferences(
      { root: fixture.root, target },
      { resolveIdentifiers: registry(works), now },
    );
    const yearFix = first.findings.find((finding) => finding.key === "smith2020")!.fix!;
    if (yearFix.kind !== "bibtex-field") throw new Error("Expected a .bib fix");
    const venueFix = first.findings.find(
      (finding) => finding.key === "uncited" && finding.kind === "details-differ",
    );
    expect(venueFix).toBeUndefined();

    const resolution = await resolveReferenceFindings({
      root: fixture.root,
      apply: [yearFix, { ...yearFix, key: "wrong2019", current: "1999" }],
      actor: "user",
    });

    expect(resolution.fixes.map(({ outcome }) => outcome)).toEqual(["applied", "stale"]);
    const bib = await fixture.read("refs.bib");
    expect(bib).toContain("  year = {2021},\n  volume = {12},");
    expect(bib).toContain("title = {Sleep in shift workers}, journal = {Sleep}, year = 2019");
    const second = await checkReferences(
      { root: fixture.root, target },
      { resolveIdentifiers: registry(works), now },
    );
    expect(second.findings.some((finding) => finding.key === "smith2020")).toBe(false);
  });

  it("keeps both of two fixes to one file applied at the same time", async () => {
    await using fixture = await project();
    await fixture.write("refs.bib", BIB);
    const report = await checkReferences(
      { root: fixture.root, target: { kind: "file", path: "refs.bib" } },
      { resolveIdentifiers: registry(works), now },
    );
    const yearFix = report.findings.find((finding) => finding.key === "smith2020")!.fix!;
    const pagesFix = { ...yearFix, field: "pages" as const, current: "100–110", value: "1-9" };

    const results = await Promise.all([
      resolveReferenceFindings({ root: fixture.root, apply: [yearFix], actor: "user" }),
      resolveReferenceFindings({ root: fixture.root, apply: [pagesFix], actor: "agent" }),
    ]);

    expect(results.map((result) => result.fixes[0]?.outcome)).toEqual(["applied", "applied"]);
    const bib = await fixture.read("refs.bib");
    expect(bib).toContain("year = {2021}");
    expect(bib).toContain("pages = {1-9}");
  });

  it.each(["\n", "\r\n"])("adds a missing field the registry supplies (%j)", async (eol) => {
    await using fixture = await project();
    const lines = (text: string) => text.replaceAll("\n", eol);
    await fixture.write(
      "refs.bib",
      lines(
        "@article{smith2020,\n  author = {Smith, J.},\n  title = {The effect of light on sleep},\n  year = 2021,\n  doi = {10.1000/smith}\n}\n",
      ),
    );
    const report = await checkReferences(
      { root: fixture.root, target: { kind: "file", path: "refs.bib" } },
      { resolveIdentifiers: registry(works), now },
    );
    const missing = report.findings.find((finding) => finding.kind === "missing-field");
    expect(missing?.message).toBe(
      "The journal is missing; the registry has “Journal of Sleep Research”.",
    );

    await resolveReferenceFindings({ root: fixture.root, apply: [missing!.fix!], actor: "agent" });

    expect(await fixture.read("refs.bib")).toBe(
      lines(
        "@article{smith2020,\n  author = {Smith, J.},\n  title = {The effect of light on sleep},\n  year = 2021,\n  doi = {10.1000/smith},\n  journal = {Journal of Sleep Research}\n}\n",
      ),
    );
  });

  // A position among same-key entries stops naming the checked entry once entries move.
  it("never fixes an entry whose key another entry shares", async () => {
    await using fixture = await project();
    const bibText =
      "@article{duplicate, author = {Smith, J.}, title = {The effect of light on sleep}, journal = {Journal of Sleep Research}, year = {2021}, volume = {12}, pages = {100-110}, doi = {10.1000/smith}}\n" +
      "@article{duplicate, author = {Smith, J.}, title = {The effect of light on sleep}, journal = {Journal of Sleep Research}, year = {2020}, volume = {12}, pages = {100-110}, doi = {10.1000/other}}\n";
    await fixture.write("refs.bib", bibText);
    const report = await checkReferences(
      { root: fixture.root, target: { kind: "file", path: "refs.bib" } },
      { resolveIdentifiers: registry({ ...works, "doi:10.1000/other": SMITH }), now },
    );
    expect(report.findings.some((finding) => finding.kind === "details-differ")).toBe(true);
    expect(report.findings.filter((finding) => finding.fix)).toEqual([]);

    const resolution = await resolveReferenceFindings({
      root: fixture.root,
      apply: [
        {
          kind: "bibtex-field",
          path: "refs.bib",
          key: "duplicate",
          field: "year",
          current: "2020",
          value: "2021",
        },
      ],
      actor: "user",
    });

    expect(resolution.fixes.map(({ outcome }) => outcome)).toEqual(["stale"]);
    expect(await fixture.read("refs.bib")).toBe(bibText);
  });

  it("checks Library sources and applies a fix as a credited revision", async () => {
    await using fixture = await project();
    await addLibrarySource(fixture.root);

    const report = await checkReferences(
      { root: fixture.root, target: { kind: "library" } },
      { resolveIdentifiers: registry(works), now },
    );

    const finding = report.findings[0]!;
    expect(report.findings).toHaveLength(1);
    expect(finding).toMatchObject({
      kind: "details-differ",
      location: null,
      fix: { kind: "source-field", field: "issuedYear", value: "2021" },
    });
    const resolution = await resolveReferenceFindings({
      root: fixture.root,
      apply: [finding.fix!],
      actor: "agent",
    });
    expect(resolution.fixes[0]?.outcome).toBe("applied");
    const [record] = await listScientSourceRecords(fixture.root);
    expect(record).toMatchObject({ issuedYear: 2021, issuedRaw: "2021", updatedBy: "agent" });
  });

  it("applies several fixes to one Library source together as one revision", async () => {
    await using fixture = await project();
    await addLibrarySource(fixture.root);
    const report = await checkReferences(
      { root: fixture.root, target: { kind: "library" } },
      {
        resolveIdentifiers: registry({ "doi:10.1000/smith": { ...SMITH, volume: "13" } }),
        now,
      },
    );
    const fixes = report.findings.flatMap((finding) => (finding.fix ? [finding.fix] : []));
    expect(fixes.map((fix) => fix.field).sort()).toEqual(["issuedYear", "volume"]);

    const resolution = await resolveReferenceFindings({
      root: fixture.root,
      apply: fixes,
      actor: "agent",
    });

    expect(resolution.fixes.map(({ outcome }) => outcome)).toEqual(["applied", "applied"]);
    const [record] = await listScientSourceRecords(fixture.root);
    expect(record).toMatchObject({ issuedYear: 2021, volume: "13", revision: 2 });
  });

  it("matches Markdown citations to Library sources by citation key", async () => {
    await using fixture = await project();
    await addLibrarySource(fixture.root);
    const [record] = await listScientSourceRecords(fixture.root);
    const key = record!.citationKey!;
    await fixture.write("draft.md", `Light [@${key.toUpperCase()}] and [@missing].\n`);

    const report = await checkReferences(
      { root: fixture.root, target: { kind: "file", path: "draft.md" } },
      { resolveIdentifiers: registry(works), now },
    );

    expect(report.references).toBe(1);
    expect(kinds(report)).toEqual(["missing:cited-not-listed", `${key}:details-differ`]);
    expect(report.findings[1]).toMatchObject({
      sourceId: record!.sourceId,
      fix: { kind: "source-field", field: "issuedYear" },
    });
  });

  it("remembers ignored findings across checks until they are restored", async () => {
    await using fixture = await project();
    await fixture.write("refs.bib", BIB);
    const check = () =>
      checkReferences(
        { root: fixture.root, target: { kind: "file", path: "refs.bib" } },
        { resolveIdentifiers: registry(works), now },
      );
    const first = await check();
    const ghost = first.findings.find((finding) => finding.key === "ghost")!;

    await resolveReferenceFindings({
      root: fixture.root,
      ignore: [ghost.findingId],
      actor: "user",
    });
    const ignored = await check();
    expect(ignored.findings.find((finding) => finding.key === "ghost")?.ignored).toBe(true);
    expect(ignored.findings.at(-1)?.key).toBe("ghost");
    expect(ignored.ledger.find((entry) => entry.key === "ghost")?.status).toBe("ok");

    await resolveReferenceFindings({
      root: fixture.root,
      restore: [ghost.findingId],
      actor: "user",
    });
    expect((await check()).findings.find((finding) => finding.key === "ghost")?.ignored).toBe(
      false,
    );
  });

  it.each([".scient", ".scient/reference-check"])(
    "never writes ignores through a linked %s folder",
    async (linked) => {
      await using fixture = await project();
      await using outside = await project();
      await outside.write("ignored.json", "kept");
      await NodeFSP.rm(NodePath.join(fixture.root, linked), { recursive: true, force: true });
      await NodeFSP.mkdir(NodePath.dirname(NodePath.join(fixture.root, linked)), {
        recursive: true,
      });
      await NodeFSP.symlink(outside.root, NodePath.join(fixture.root, linked), "junction");

      await expect(
        resolveReferenceFindings({ root: fixture.root, ignore: ["finding"], actor: "user" }),
      ).rejects.toBeInstanceOf(ReferenceCheckError);

      expect(await outside.read("ignored.json")).toBe("kept");
      await expect(NodeFSP.stat(NodePath.join(outside.root, "reference-check"))).rejects.toThrow();
    },
  );

  it("reads Markdown citations against a front-matter bibliography and refuses paths outside the project", async () => {
    await using fixture = await project();
    await fixture.write("refs.bib", BIB);
    await fixture.write(
      "notes/draft.md",
      "---\nbibliography: ../refs.bib\n---\nLight [@smith2020] and @nobody.\n",
    );
    const report = await checkReferences(
      { root: fixture.root, target: { kind: "file", path: "notes/draft.md" } },
      { resolveIdentifiers: registry(works), now },
    );
    expect(report.files).toEqual(["notes/draft.md", "refs.bib"]);
    expect(report.findings.find((finding) => finding.kind === "cited-not-listed")).toMatchObject({
      key: "nobody",
      location: { path: "notes/draft.md", line: 4 },
    });

    await expect(
      checkReferences(
        { root: fixture.root, target: { kind: "file", path: "../outside.md" } },
        { resolveIdentifiers: registry(works), now },
      ),
    ).rejects.toBeInstanceOf(ReferenceCheckError);
  });
});

// The Word files below are constructed here: the XML is what Word and each plug-in write
// (Zotero's field, list and bookmark codes as in its public source and pandoc's public sample
// file; EndNote's data field and Mendeley Cite's tag as publicly described), around made-up
// works.
const WORD_NS = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';
const escapeXml = (value: string) =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
const run = (text: string, properties = "") =>
  `<w:r><w:rPr>${properties}</w:rPr><w:t xml:space="preserve">${escapeXml(text)}</w:t></w:r>`;
const paragraph = (inner: string, style = "Normal") =>
  `<w:p><w:pPr><w:pStyle w:val="${style}"/></w:pPr>${inner}</w:p>`;
const fieldMark = (type: "begin" | "separate" | "end", data = "") =>
  `<w:r><w:fldChar w:fldCharType="${type}">${data ? `<w:fldData xml:space="preserve">${data}</w:fldData>` : ""}</w:fldChar></w:r>`;
/** A field whose code Word split across two runs, as it does where formatting changes. */
const field = (instruction: string, result: string) => {
  const half = Math.floor(instruction.length / 2);
  const code = (part: string) =>
    `<w:r><w:instrText xml:space="preserve">${escapeXml(part)}</w:instrText></w:r>`;
  return `${fieldMark("begin")}${code(instruction.slice(0, half))}${code(instruction.slice(half))}${fieldMark("separate")}${result}`;
};

async function wordFile(parts: Readonly<Record<string, string>>): Promise<Uint8Array> {
  const zip = new yazl.ZipFile();
  const named = {
    "_rels/.rels": `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`,
    ...parts,
  };
  for (const [name, xml] of Object.entries(named)) {
    zip.addBuffer(Buffer.from(`<?xml version="1.0" encoding="UTF-8"?>${xml}`), name);
  }
  zip.end();
  return NodeStreamConsumers.buffer(zip.outputStream);
}

const zoteroCitation = (items: ReadonlyArray<Readonly<Record<string, unknown>>>) =>
  ` ADDIN ZOTERO_ITEM CSL_CITATION ${JSON.stringify({
    citationID: "CCwugFas",
    properties: { formattedCitation: "(Smith, 2020)", noteIndex: 0 },
    citationItems: items.map((itemData) => ({
      id: itemData.id,
      uris: [`http://zotero.org/users/40613/items/${String(itemData.id)}`],
      itemData,
    })),
    schema: "https://github.com/citation-style-language/schema/raw/master/csl-citation.json",
  })} `;
const article = (id: string, family: string, title: string, year: string, doi?: string) => ({
  id,
  type: "article-journal",
  title,
  author: [{ family, given: "A." }],
  issued: { "date-parts": [[year]] },
  ...(doi ? { DOI: doi } : {}),
});
// Mendeley Cite keeps the citation as base64 in a content control's tag, without padding.
const mendeleyCiteControl = (itemData: Readonly<Record<string, unknown>>, shown: string) =>
  `<w:sdt><w:sdtPr><w:tag w:val="MENDELEY_CITATION_v3_${Buffer.from(
    JSON.stringify({
      citationID: "MENDELEY_CITATION_1de18c13",
      citationItems: [{ id: itemData.id, itemData }],
    }),
  )
    .toString("base64")
    .replace(/=+$/u, "")}"/></w:sdtPr><w:sdtContent>${shown}</w:sdtContent></w:sdt>`;

describe("checkReferences on a Word document", () => {
  it("reads the works a reference manager's citations carry, wherever Word keeps them", async () => {
    await using fixture = await project();
    await addLibrarySource(fixture.root);
    await addLibrarySource(fixture.root, {
      sourceKey: "doe",
      title: "Sleep in shift workers",
      creators: [author("Doe")],
      identifiers: [],
      externalReferences: [
        {
          system: "zotero",
          libraryId: "40613",
          itemKey: "EIZFK2E5",
          itemVersion: 3,
          rawItemType: "journalArticle",
        },
      ],
    });
    const smith = article(
      "3GKMD43T",
      "Smith",
      "The effect of light on sleep",
      "2020",
      "10.1000/smith",
    );
    const roe = article(
      "GHOST001",
      "Roe",
      "A study that was never published",
      "2020",
      "10.1000/missing",
    );
    const ghost = zoteroCitation([roe]);
    const bookmarkCode = `ZOTERO_ITEM CSL_CITATION ${JSON.stringify({ citationItems: [{ id: 6, uris: ["http://zotero.org/users/40613/items/EIZFK2E5"], itemData: article("6", "Doe", "Sleep in shift workers", "2019", "10.1000/wrong") }] })}`;
    const endNote = Buffer.from(
      `<EndNote><Cite><Author>Wakefield</Author><Year>1998</Year><RecNum>4</RecNum><record><rec-number>4</rec-number><contributors><authors><author>Wakefield, A.</author></authors></contributors><titles><title>Vaccines and autism</title><secondary-title>The Lancet</secondary-title></titles><dates><year>1998</year></dates><electronic-resource-num>10.1000/retracted</electronic-resource-num></record></Cite></EndNote>`,
    ).toString("base64");
    const property = (name: string, value: string) =>
      `<property fmtid="{D5CDD505-2E9C-101B-9397-08002B2CF9AE}" pid="2" name="${name}"><vt:lpwstr>${escapeXml(value)}</vt:lpwstr></property>`;
    await fixture.write(
      "paper/draft.docx",
      await wordFile({
        "word/document.xml": `<w:document ${WORD_NS}><w:body>${[
          paragraph(
            run("Light matters ") +
              field(zoteroCitation([smith]), run("(Smith, 2020)")) +
              fieldMark("end") +
              // A citation deleted or moved away with tracked changes is no longer here, whether
              // a field, a content control or a Zotero bookmark.
              `<w:del w:id="1" w:author="B" w:date="2026-11-01T10:00:00Z">${fieldMark("begin")}<w:r><w:delInstrText xml:space="preserve">${escapeXml(ghost)}</w:delInstrText></w:r>${fieldMark("separate")}<w:r><w:delText>(Roe, 2020)</w:delText></w:r>${fieldMark("end")}${mendeleyCiteControl(roe, "<w:r><w:delText>(Roe, 2020)</w:delText></w:r>")}<w:bookmarkStart w:id="3" w:name="ZOTERO_BREF_deletedRoe01"/><w:r><w:delText>(Roe, 2020)</w:delText></w:r><w:bookmarkEnd w:id="3"/></w:del>` +
              `<w:moveFrom w:id="2" w:author="B" w:date="2026-11-01T10:00:00Z">${field(ghost, run("(Roe, 2020)"))}${fieldMark("end")}</w:moveFrom>` +
              run(" and again ") +
              field(zoteroCitation([smith]), run("(Smith, 2020)")) +
              fieldMark("end"),
          ),
          paragraph(
            `<w:bookmarkStart w:id="0" w:name="ZOTERO_BREF_Jx3kq8mZ1aPl"/>${run("(Doe, 2019)")}<w:bookmarkEnd w:id="0"/>${mendeleyCiteControl({ ...article("f3a0c1d2", "Ng", "Handbook of sleep", "2010"), type: "book" }, run(" (Ng, 2010)"))}<w:r><w:footnoteReference w:id="2"/></w:r>`,
          ),
          // Zotero's list is one field across its paragraphs, with a link field inside it.
          paragraph(
            field(
              ` ADDIN ZOTERO_BIBL {"uncited":[],"omitted":[["http://zotero.org/users/40613/items/3GKMD43T"]],"custom":[]} CSL_BIBLIOGRAPHY `,
              run("Doe, A. (2019). Sleep in shift workers. ") +
                field(' HYPERLINK "https://doi.org/10.1000/wrong" ', run("doi")) +
                fieldMark("end"),
            ),
            "Bibliography",
          ),
          paragraph(
            run("Wakefield, A. (1998). Vaccines and autism.") + fieldMark("end"),
            "Bibliography",
          ),
        ].join("")}</w:body></w:document>`,
        "word/footnotes.xml": `<w:footnotes ${WORD_NS}><w:footnote w:id="2">${paragraph(
          `${fieldMark("begin", endNote)}<w:r><w:instrText xml:space="preserve"> ADDIN EN.CITE </w:instrText></w:r>${fieldMark("begin", endNote)}<w:r><w:instrText xml:space="preserve"> ADDIN EN.CITE.DATA </w:instrText></w:r>${fieldMark("end")}${fieldMark("separate")}${run("(Wakefield, 1998)")}${fieldMark("end")}`,
        )}</w:footnote></w:footnotes>`,
        "word/comments.xml": `<w:comments ${WORD_NS}><w:comment w:id="0" w:author="B">${paragraph(run("Cite (Nobody, 1999) here?"))}</w:comment></w:comments>`,
        "docProps/custom.xml": `<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/custom-properties" xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes">${property("ZOTERO_BREF_Jx3kq8mZ1aPl_1", bookmarkCode.slice(0, 255))}${property("ZOTERO_BREF_Jx3kq8mZ1aPl_2", bookmarkCode.slice(255))}${property("ZOTERO_BREF_deletedRoe01_1", ghost.trim())}</Properties>`,
      }),
    );
    const library = await listScientSourceRecords(fixture.root);
    const lookup = registry(works);

    const report = await checkReferences(
      { root: fixture.root, target: { kind: "file", path: "paper/draft.docx" } },
      { resolveIdentifiers: lookup, now },
    );

    expect(report).toMatchObject({
      target: { kind: "file", path: "paper/draft.docx" },
      files: ["paper/draft.docx"],
      references: 4,
      citations: 5,
      checked: 3,
      noIdentifier: 1,
      complete: true,
      notes: [
        "Tracked changes were read as if accepted.",
        "Comments were not read.",
        "Citations inserted with a reference manager were read. Citations typed by hand were not.",
        "2 of the 4 cited works are not in the Library.",
      ],
    });
    expect(lookup.asked).not.toContain("doi:10.1000/missing");
    expect(
      report.findings.map(({ label, kind, location, fix }) => ({ label, kind, location, fix })),
    ).toEqual(
      [
        ["The effect of light on sleep", "cited-not-listed"],
        ["Vaccines and autism", "retracted"],
        ["Sleep in shift workers", "identifier-mismatch"],
        ["The effect of light on sleep", "details-differ"],
      ].map(([label, kind]) => ({ label, kind, location: null, fix: null })),
    );
    const inLibrary = (title: string) =>
      library.find((record) => record.title === title)?.sourceId ?? null;
    expect(report.ledger.map(({ label, sourceId }) => [label, sourceId])).toEqual([
      ["The effect of light on sleep", inLibrary("The effect of light on sleep")],
      ["Handbook of sleep", null],
      ["Vaccines and autism", null],
      ["Sleep in shift workers", inLibrary("Sleep in shift workers")],
    ]);
    expect(library).toHaveLength(2);
  });

  it("keeps cited works apart that share a title and a year", async () => {
    await using fixture = await project();
    const editorial = (id: string, family: string) => article(id, family, "Editorial", "2020");
    // Mendeley Cite names a work by its item ID; a citation without one, by all its details.
    const withoutId = (family: string) =>
      field(
        ` ADDIN CSL_CITATION ${JSON.stringify({ citationItems: [{ id: "ITEM-1", itemData: editorial("ITEM-1", family) }] })} `,
        run(` (${family}, 2020)`),
      ) + fieldMark("end");
    await fixture.write(
      "editorials.docx",
      await wordFile({
        "word/document.xml": `<w:document ${WORD_NS}><w:body>${paragraph(
          mendeleyCiteControl(editorial("4c1e0a3b", "Abe"), run("(Abe, 2020)")) +
            mendeleyCiteControl(editorial("9d2f7c61", "Bly"), run(" (Bly, 2020)")) +
            mendeleyCiteControl(editorial("4c1e0a3b", "Abe"), run(" (Abe, 2020)")) +
            withoutId("Cho") +
            withoutId("Dee") +
            withoutId("Cho"),
        )}</w:body></w:document>`,
      }),
    );

    const report = await checkReferences(
      { root: fixture.root, target: { kind: "file", path: "editorials.docx" } },
      { resolveIdentifiers: registry(works), now },
    );

    expect(report).toMatchObject({ references: 4, citations: 6, noIdentifier: 4 });
  });

  it("links a cited Zotero item to the Library source of the same library, and never guesses", async () => {
    await using fixture = await project();
    const zotero = (libraryId: string, itemKey: string) => ({
      system: "zotero" as const,
      libraryId,
      itemKey,
      itemVersion: 1,
      rawItemType: "journalArticle",
    });
    const held = async (title: string, changes: Partial<LibraryCandidate>) =>
      addLibrarySource(fixture.root, { sourceKey: title, title, identifiers: [], ...changes });
    await addLibrarySource(fixture.root);
    await held("Feeding behaviour of reef fish", {
      identifiers: [{ scheme: "doi", value: "10.1000/reef" }],
      externalReferences: [zotero("22", "ABCDEFGH")],
    });
    await held("Handbook of sleep", { externalReferences: [zotero("groups/11", "GROUPKEY")] });
    await held("Vaccines and autism", {
      identifiers: [{ scheme: "doi", value: "10.1000/retracted" }],
      externalReferences: [zotero("40613", "CONTRA01")],
    });
    await held("Twin study, first copy", { externalReferences: [zotero("40613", "TWICE001")] });
    await held("Twin study, second copy", { externalReferences: [zotero("40613", "TWICE001")] });
    const cite = (address: string, itemData: Readonly<Record<string, unknown>>) =>
      field(
        ` ADDIN ZOTERO_ITEM CSL_CITATION ${JSON.stringify({ citationItems: [{ id: 1, uris: [address], itemData }] })} `,
        run("(cited)"),
      ) + fieldMark("end");
    await fixture.write(
      "draft.docx",
      await wordFile({
        "word/document.xml": `<w:document ${WORD_NS}><w:body>${paragraph(
          // The same item key in another library is another item; the DOI finds the source.
          cite(
            "http://zotero.org/groups/11/items/ABCDEFGH",
            article("1", "Smith", "The effect of light on sleep", "2020", "10.1000/smith"),
          ) +
            cite(
              "http://zotero.org/groups/11/items/GROUPKEY",
              article("2", "Ng", "Handbook of sleep", "2010"),
            ) +
            // The item's source has another DOI than the citation.
            cite(
              "http://zotero.org/users/40613/items/CONTRA01",
              article("3", "Roe", "A study that was never published", "2020", "10.1000/missing"),
            ) +
            cite(
              "http://zotero.org/users/40613/items/TWICE001",
              article("4", "Lee", "Twin study", "2018"),
            ),
        )}</w:body></w:document>`,
      }),
    );
    const library = await listScientSourceRecords(fixture.root);
    const inLibrary = (title: string) => library.find((record) => record.title === title)!.sourceId;

    const report = await checkReferences(
      { root: fixture.root, target: { kind: "file", path: "draft.docx" } },
      { resolveIdentifiers: registry(works), now },
    );

    expect(report.ledger.map(({ label, sourceId }) => [label, sourceId])).toEqual([
      ["The effect of light on sleep", inLibrary("The effect of light on sleep")],
      ["Handbook of sleep", inLibrary("Handbook of sleep")],
      ["A study that was never published", null],
      ["Twin study", null],
    ]);
    expect(report.notes).toEqual([
      "Citations inserted with a reference manager were read. Citations typed by hand were not.",
      "2 cited works were not linked to a Library source, because more than one could be meant: “A study that was never published”, “Twin study”.",
      "The document has no reference list made by the reference manager.",
    ]);
  });

  it("reads typed citations against the reference list of a document without a reference manager", async () => {
    await using fixture = await project();
    const superscript = '<w:vertAlign w:val="superscript"/>';
    const textBox = (inner: string) =>
      `<w:r><mc:AlternateContent xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006"><mc:Choice Requires="wps"><w:drawing><w:txbxContent>${inner}</w:txbxContent></w:drawing></mc:Choice><mc:Fallback><w:pict><w:txbxContent>${inner}</w:txbxContent></w:pict></mc:Fallback></mc:AlternateContent></w:r>`;
    await fixture.write(
      "draft.docx",
      await wordFile({
        // A French Word names its heading style "Titre1"; the built-in name stays "heading 1".
        "word/styles.xml": `<w:styles ${WORD_NS}><w:style w:type="paragraph" w:styleId="Titre1"><w:name w:val="heading 1"/></w:style><w:style w:type="paragraph" w:styleId="Normal"><w:name w:val="Normal"/></w:style></w:styles>`,
        "word/document.xml": `<w:document ${WORD_NS}><w:body>${[
          paragraph(
            run("Light changes sleep") +
              run("1", superscript) +
              run("–", superscript) +
              run("3", superscript) +
              run(" in 2020 (2020) and later [4].") +
              textBox(paragraph(run("Box: see [1]."))),
          ),
          paragraph(run("References"), "Titre1"),
          paragraph(
            run(
              "Smith A. The effect of light on sleep. J Sleep Res. 2020;12:100-110. doi:10.1000/smith",
            ),
          ),
          paragraph(run("Doe A. Sleep in shift workers. Sleep. 2019.")),
          paragraph(run("Ng C. Handbook of sleep. 2010.")),
          paragraph(run("Figure legends"), "Titre1"),
          paragraph(run("Figure 1. Sleep by light level [3].")),
        ].join("")}</w:body></w:document>`,
      }),
    );
    const lookup = registry(works);

    const report = await checkReferences(
      { root: fixture.root, target: { kind: "file", path: "draft.docx" } },
      { resolveIdentifiers: lookup, now },
    );

    expect(report).toMatchObject({ references: 3, citations: 6, checked: 1, noIdentifier: 2 });
    expect(lookup.asked).toEqual(["doi:10.1000/smith"]);
    expect(kinds(report)).toEqual(["1:details-differ", "4:cited-not-listed"]);
    expect(report.findings.every((finding) => finding.location === null)).toBe(true);
  });

  it("lists Word documents to check and says when a file is not one or is too large", async () => {
    await using fixture = await project();
    await fixture.write("paper.docx", "This is not a Word file.");
    await fixture.write("~$paper.docx", "Word's lock file");
    // Small and valid, but with more members than any Word file: refused before they are read.
    await fixture.write(
      "many.docx",
      await wordFile({
        "word/document.xml": `<w:document ${WORD_NS}><w:body>${paragraph(run("Text."))}</w:body></w:document>`,
        ...Object.fromEntries(
          Array.from({ length: 10_000 }, (_, index) => [`word/media/image${index}.png`, ""]),
        ),
      }),
    );

    const listed = (await listReferenceDocuments(fixture.root)).paths;
    expect(listed.filter((path) => path.endsWith(".docx"))).toEqual(["many.docx", "paper.docx"]);
    const check = (path: string) =>
      checkReferences(
        { root: fixture.root, target: { kind: "file", path } },
        { resolveIdentifiers: registry(works), now },
      );
    await expect(check("paper.docx")).rejects.toThrow(
      "paper.docx could not be read as a Word document.",
    );
    await expect(check("many.docx")).rejects.toThrow("many.docx is too large to check.");
  });
});
