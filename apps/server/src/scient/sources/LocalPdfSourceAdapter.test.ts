// @effect-diagnostics nodeBuiltinImport:off -- One case reads a synthetic PDF from a temporary folder.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { describe, expect, it } from "@effect/vitest";
import type { ScientSourceIdentifier } from "@scientfactory/scient-sources";

import { textPdf } from "../annotations/annotationTestUtils.ts";
import { localPdfSourceInternals } from "./LocalPdfSourceAdapter.ts";
import type {
  ResolvedSourceMetadata,
  SourceIdentifierResolution,
} from "./SourceIdentifierResolver.ts";

describe("local PDF source adapter", () => {
  it("uses only one unambiguous DOI or explicitly labelled PMID", () => {
    expect(localPdfSourceInternals.uniqueDoi("doi: 10.1000/Example.")).toBe("10.1000/example");
    expect(localPdfSourceInternals.uniqueDoi("10.1371/journal. 10.1371/journal.pone.0203316")).toBe(
      "10.1371/journal.pone.0203316",
    );
    expect(localPdfSourceInternals.uniqueDoi("10.1000/first and 10.1000/second")).toBeNull();
    expect(localPdfSourceInternals.uniquePmid("PMID: 12345678")).toBe("12345678");
    expect(localPdfSourceInternals.uniquePmid("An unrelated number 12345678")).toBeNull();
  });

  it("recovers PDF text-item spacing inside a labelled DOI without broad text joining", () => {
    expect(
      localPdfSourceInternals.uniqueDoi(
        "DOI: https:// doi. org/ 10. 1542/ peds. 2017- 4087 Accepted for publication",
      ),
    ).toBe("10.1542/peds.2017-4087");
    expect(
      localPdfSourceInternals.uniqueDoi("DOI: 10.1001/jamanetworkopen.2024.8895 (reprinted) May"),
    ).toBe("10.1001/jamanetworkopen.2024.8895");
    expect(
      localPdfSourceInternals.doiCandidates("10.1001/jamanetworkopen.2024.8895(reprinted)may"),
    ).toEqual([
      "10.1001/jamanetworkopen.2024.8895(reprinted)may",
      "10.1001/jamanetworkopen.2024.8895",
    ]);
    expect(localPdfSourceInternals.doiCandidates("10.1136/bmj.i6)cite")).toEqual([
      "10.1136/bmj.i6)cite",
      "10.1136/bmj.i6",
    ]);
    expect(localPdfSourceInternals.uniqueDoi("Unlabelled 10. 1542/ peds. 2017- 4087")).toBeNull();
    expect(
      localPdfSourceInternals.uniqueDoi("DOI: 10. 1000/ first and DOI: 10. 1000/ second"),
    ).toBeNull();
  });

  it("prefers an article DOI over its table and figure child identifiers", () => {
    expect(
      localPdfSourceInternals.uniqueDoi(
        [
          "DOI: 10.1371/journal.pmed.0020124",
          "DOI: 10.1371/journal.pmed.0020124.t001",
          "DOI: 10.1371/journal.pmed.0020124.g001",
        ].join("\n"),
      ),
    ).toBe("10.1371/journal.pmed.0020124");
  });

  it("uses a human document-info title over a file-like XMP label", () => {
    expect(
      localPdfSourceInternals.selectEmbeddedPdfTitle({
        xmpTitle: "PEDS_20174087 1..3",
        infoTitle: "Timing and Location of Emergency Department Revisits",
        fallbackTitle: "uploaded article",
      }),
    ).toBe("Timing and Location of Emergency Department Revisits");
    expect(
      localPdfSourceInternals.selectEmbeddedPdfTitle({
        xmpTitle: "RNA_Seq Results in Clinical Cohorts",
        infoTitle: "Older working title",
        fallbackTitle: "uploaded article",
      }),
    ).toBe("RNA_Seq Results in Clinical Cohorts");
  });

  it("normalizes standard PDF dates without changing ordinary publication dates", () => {
    expect(localPdfSourceInternals.normalizeEmbeddedPdfDate("D:20180330142756+05'30'")).toBe(
      "2018-03-30",
    );
    expect(localPdfSourceInternals.normalizeEmbeddedPdfDate("D:20240426150234Z00'00'")).toBe(
      "2024-04-26",
    );
    expect(localPdfSourceInternals.normalizeEmbeddedPdfDate("D:202404")).toBe("2024-04");
    expect(localPdfSourceInternals.normalizeEmbeddedPdfDate("D:2024")).toBe("2024");
    expect(localPdfSourceInternals.normalizeEmbeddedPdfDate("2024-07-18")).toBe("2024-07-18");
    expect(localPdfSourceInternals.normalizeEmbeddedPdfDate("D:20241301150234Z")).toBe(
      "D:20241301150234Z",
    );
    expect(localPdfSourceInternals.normalizeEmbeddedPdfDate("D:not-a-date")).toBe("D:not-a-date");
  });

  it("takes the publication date only from PRISM metadata, never file dates", () => {
    const xmp = (entries: Record<string, string>) => ({ get: (name: string) => entries[name] });
    expect(
      localPdfSourceInternals.embeddedPublicationDate(
        xmp({ "dc:date": "2026-01-05", "xmp:createdate": "2026-01-05T10:00:00Z" }),
      ),
    ).toBeNull();
    expect(
      localPdfSourceInternals.embeddedPublicationDate(
        xmp({ "dc:date": "2026-01-05", "prism:coverdate": "2019-06-01T00:00:00Z" }),
      ),
    ).toBe("2019-06-01");
    expect(
      localPdfSourceInternals.embeddedPublicationDate(xmp({ "prism:publicationdate": "2018" })),
    ).toBe("2018");
    expect(localPdfSourceInternals.embeddedPublicationDate(null)).toBeNull();
  });

  it("accepts PDF creator arrays without losing later metadata extraction", () => {
    expect(
      localPdfSourceInternals.embeddedCreators([
        "Kevin Chen",
        "Mia Djulbegovic",
        "Ritu Agarwal",
        "Sarwat I. Chaudhry",
      ]),
    ).toEqual([
      expect.objectContaining({ literalName: "Kevin Chen" }),
      expect.objectContaining({ literalName: "Mia Djulbegovic" }),
      expect.objectContaining({ literalName: "Ritu Agarwal" }),
      expect.objectContaining({ literalName: "Sarwat I. Chaudhry" }),
    ]);
    expect(
      localPdfSourceInternals.embeddedCreators([
        "Claire Morley, Maria Unwin, Gregory M. Peterson, Jim Stankovich, Leigh Kinsman",
      ]),
    ).toHaveLength(5);
  });

  it("marks a title taken from the file name of a PDF that names none", async () => {
    const folder = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "scient-pdf-title-"));
    try {
      const pdfPath = NodePath.join(folder, "field_report-2026.pdf");
      await NodeFSP.writeFile(pdfPath, textPdf([["Fieldwork notes without identifiers"]]));
      const candidate = await localPdfSourceInternals.extractPdfMetadata({
        sourceKey: "local_field",
        fileName: "field_report-2026.pdf",
        pdfPath,
      });
      expect(candidate.title).toBe("field report 2026");
      expect(candidate.fieldProvenance).toContainEqual({
        field: "title",
        origin: "local-pdf",
        sourceField: "file-name",
      });
    } finally {
      await NodeFSP.rm(folder, { recursive: true, force: true });
    }
  });

  it("does not assign an abstract to generic embedded PDF metadata", () => {
    const candidate = localPdfSourceInternals.candidateFromEmbeddedPdf({
      sourceKey: "local_subject",
      fileName: "article.pdf",
      title: "A journal article",
      authors: [],
      issuedRaw: "2021",
      identifiers: [],
      keywords: [],
    });

    expect(candidate.abstract).toBeNull();
    expect(candidate.fieldProvenance).not.toContainEqual(
      expect.objectContaining({ field: "abstract" }),
    );
  });

  it("reads a PDF's own arXiv ID from its stamp, not one it cites", () => {
    const { arxivStamp } = localPdfSourceInternals;
    expect(arxivStamp("Long Beach, CA, USA.  arXiv:1706.03762v7  [cs.CL]  2 Aug 2023")).toBe(
      "1706.03762",
    );
    expect(arxivStamp("arXiv:hep-th/9901001v1 6 Jan 1999 Abstract")).toBe("hep-th/9901001");
    // A citation in the text, and two stamps that disagree, name no deposit.
    expect(arxivStamp("as in BERT (arXiv preprint arXiv:1810.04805, 2018)")).toBeNull();
    expect(arxivStamp("arXiv:1706.03762v7 [cs.CL] … arXiv:1810.04805v2 [cs.CL]")).toBeNull();
  });

  it("looks a PDF up by its arXiv stamp, and by a DOI in its text only without one", async () => {
    const folder = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "scient-pdf-arxiv-"));
    try {
      const asked: string[] = [];
      const resolve = async (identifiers: ReadonlyArray<ScientSourceIdentifier>) => {
        const [identifier] = identifiers;
        asked.push(`${identifier?.scheme}:${identifier?.value}`);
        return identifier && registry[`${identifier.scheme}:${identifier.value}`]
          ? found(identifier, registry[`${identifier.scheme}:${identifier.value}`]!)
          : null;
      };
      const read = async (fileName: string, lines: ReadonlyArray<string>) => {
        const pdfPath = NodePath.join(folder, fileName);
        await NodeFSP.writeFile(pdfPath, textPdf([lines]));
        return localPdfSourceInternals.extractPdfMetadata(
          { sourceKey: `local_${fileName}`, fileName, pdfPath },
          resolve,
        );
      };

      // arXiv's copy: the stamp names the deposit; the published version's DOI is not asked.
      const preprint = await read("1706.03762.pdf", [
        "Published as doi:10.5555/published.1",
        "arXiv:1706.03762v7 [cs.CL] 2 Aug 2023",
      ]);
      expect(asked).toEqual(["arxiv:1706.03762"]);
      expect(preprint).toMatchObject({
        type: "preprint",
        title: "Attention Is All You Need",
        issuedYear: 2017,
        identifiers: [{ scheme: "arxiv", value: "1706.03762" }],
        pdfFileName: "1706.03762.pdf",
      });
      expect(preprint.fieldProvenance).not.toContainEqual(
        expect.objectContaining({ field: "title", sourceField: "file-name" }),
      );

      // A DOI read with what follows it: its shorter spelling is the registry's, and replaces it.
      asked.length = 0;
      const article = await read("article.pdf", [
        "JAMA Netw Open. doi:10.1001/jamanetworkopen.2024.8895(Reprinted)May",
      ]);
      expect(asked).toEqual([
        "doi:10.1001/jamanetworkopen.2024.8895(reprinted)may",
        "doi:10.1001/jamanetworkopen.2024.8895",
      ]);
      expect(article.identifiers).toEqual([
        { scheme: "doi", value: "10.1001/jamanetworkopen.2024.8895" },
      ]);
      expect(article.fieldProvenance).toContainEqual(
        expect.objectContaining({ field: "title", origin: "doi" }),
      );
    } finally {
      await NodeFSP.rm(folder, { recursive: true, force: true });
    }
  });
});

const registry: Record<string, Partial<ResolvedSourceMetadata>> = {
  "arxiv:1706.03762": {
    type: "preprint",
    title: "Attention Is All You Need",
    issuedRaw: "2017-06-12",
    issuedYear: 2017,
    identifiers: [{ scheme: "arxiv", value: "1706.03762" }],
    url: "https://arxiv.org/abs/1706.03762",
  },
  "doi:10.1001/jamanetworkopen.2024.8895": {
    type: "article",
    title: "A resolved article",
    identifiers: [{ scheme: "doi", value: "10.1001/jamanetworkopen.2024.8895" }],
  },
};

function found(
  identifier: ScientSourceIdentifier,
  metadata: Partial<ResolvedSourceMetadata>,
): SourceIdentifierResolution {
  return {
    status: "found",
    identifier,
    retrievedAt: "2026-11-16T00:00:00.000Z",
    ...(identifier.scheme === "arxiv" ? { origin: "arxiv" as const } : {}),
    metadata: {
      type: null,
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
      ...metadata,
    },
  };
}
