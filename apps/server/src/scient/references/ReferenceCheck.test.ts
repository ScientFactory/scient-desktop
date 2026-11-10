// @effect-diagnostics nodeBuiltinImport:off -- Reference check tests exercise the real project filesystem boundary.
// @effect-diagnostics globalDate:off -- A fixed clock makes report timestamps deterministic.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { initializeScientProject } from "@scientfactory/project-init";
import type { ScientReferenceCheckReport } from "@scientfactory/scient-sources";
import { listScientSourceRecords } from "@scientfactory/scient-sources/store";
import { describe, expect, it } from "@effect/vitest";

import { addAgentSource } from "../sources/ScientSourcesCoordinator.ts";
import {
  verifiableSourceIdentifier,
  type ResolvedSourceMetadata,
  type SourceIdentifierResolution,
} from "../sources/SourceIdentifierResolver.ts";
import {
  checkReferences,
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
    write: (path: string, contents: string) =>
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

async function addLibrarySource(root: string) {
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

  it("adds a missing field the registry supplies", async () => {
    await using fixture = await project();
    await fixture.write(
      "refs.bib",
      "@article{smith2020,\n  author = {Smith, J.},\n  title = {The effect of light on sleep},\n  year = 2021,\n  doi = {10.1000/smith}\n}\n",
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
      "@article{smith2020,\n  author = {Smith, J.},\n  title = {The effect of light on sleep},\n  year = 2021,\n  doi = {10.1000/smith},\n  journal = {Journal of Sleep Research}\n}\n",
    );
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
