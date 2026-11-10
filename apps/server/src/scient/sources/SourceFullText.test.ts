// @effect-diagnostics nodeBuiltinImport:off -- Full-text tests exercise the real project filesystem boundary.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { PDF_TEXT_PROFILE } from "@scientfactory/document-artifacts";
import { initializeScientProject } from "@scientfactory/project-init";
import type { ScientSourceCandidate } from "@scientfactory/scient-sources";
import { SCIENT_SOURCE_FULL_TEXT_PROFILE } from "@scientfactory/scient-sources/full-text";
import {
  listScientSourceFullTextHashes,
  readScientSourceFullText,
} from "@scientfactory/scient-sources/full-text-store";
import { importScientSource } from "@scientfactory/scient-sources/store";
import { describe, expect, it } from "@effect/vitest";

import {
  checkSourceQuotes,
  extractSourcePdfFullText,
  getSourceFullTextStatus,
  indexSourceFullText,
  readSourceText,
  searchSourceFullText,
} from "./SourceFullText.ts";

function escapePdfText(text: string): string {
  return text.replace(/[\\()]/gu, (character) => `\\${character}`);
}

/** A PDF whose pages each hold the given lines in Helvetica. */
function textPdf(pages: ReadonlyArray<ReadonlyArray<string>>): Buffer {
  const objects: string[] = [];
  const add = (body: string) => objects.push(body);
  add("<< /Type /Catalog /Pages 2 0 R >>");
  add("");
  add("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>");
  const kids: number[] = [];
  for (const lines of pages) {
    const content = `BT /F1 12 Tf 72 720 Td 14 TL ${lines
      .map((line) => `(${escapePdfText(line)}) Tj T*`)
      .join(" ")} ET`;
    add(`<< /Length ${content.length} >>\nstream\n${content}\nendstream`);
    const contentObject = objects.length;
    add(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${contentObject} 0 R >>`,
    );
    kids.push(objects.length);
  }
  objects[1] = `<< /Type /Pages /Kids [${kids.map((kid) => `${kid} 0 R`).join(" ")}] /Count ${kids.length} >>`;
  let source = "%PDF-1.4\n";
  const offsets: number[] = [];
  for (const [index, body] of objects.entries()) {
    offsets.push(source.length);
    source += `${index + 1} 0 obj\n${body}\nendobj\n`;
  }
  const xref = source.length;
  source += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) source += `${String(offset).padStart(10, "0")} 00000 n \n`;
  source += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(source, "latin1");
}

async function project(): Promise<AsyncDisposable & { readonly root: string }> {
  const root = await NodeFSP.realpath(
    await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "scient-source-full-text-")),
  );
  await initializeScientProject({ root });
  return { root, [Symbol.asyncDispose]: () => NodeFSP.rm(root, { recursive: true, force: true }) };
}

function candidate(sourceKey: string, title: string): ScientSourceCandidate {
  return {
    sourceKey,
    type: "article",
    customType: null,
    title,
    creators: [],
    issuedRaw: null,
    issuedYear: null,
    identifiers: [],
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
    pdfAvailable: true,
    pdfFileName: `${sourceKey}.pdf`,
    pdfAttachmentCount: 1,
  };
}

async function addPdfSource(
  root: string,
  key: string,
  title: string,
  pages: ReadonlyArray<ReadonlyArray<string>>,
) {
  const pdfPath = NodePath.join(root, `${key}.pdf`);
  await NodeFSP.writeFile(pdfPath, textPdf(pages));
  const result = await importScientSource({
    root,
    operationId: `operation-${key}`,
    candidate: candidate(key, title),
    pdfPath,
  });
  if (!result.record) throw new Error("The fixture source was not imported.");
  return result.record;
}

const trialPages = [
  ["Methods", "We randomised 400 patients with sepsis."],
  ["Results", "Early antibiotics reduced mortality", "in septic shock."],
  ["Discussion", "Mortality fell by twelve percent in treated pa-", "tients over two years."],
];

describe("source full text", () => {
  it("stores text in the reader's text profile so stored offsets match reader quotes", () => {
    expect(SCIENT_SOURCE_FULL_TEXT_PROFILE).toBe(PDF_TEXT_PROFILE);
  });

  it("reads every page of a PDF, not only the first two", async () => {
    const text = await extractSourcePdfFullText({
      data: new Uint8Array(textPdf(trialPages)),
      sha256: "ab".repeat(32),
      byteLength: 1,
    });
    expect(text).toMatchObject({ outcome: "extracted", pageCount: 3, complete: true });
    if (text.outcome !== "extracted") return;
    expect(text.pages.map((page) => page.page)).toEqual([1, 2, 3]);
    expect(text.pages[2]!.text).toContain("Mortality fell by twelve percent");
    expect(text.pages[2]!.viewBox).toEqual([0, 0, 612, 792]);
  });

  it("marks a file that is not a readable PDF instead of failing the pass", async () => {
    await expect(
      extractSourcePdfFullText({
        data: new TextEncoder().encode("%PDF-1.7\nnot really a pdf\n"),
        sha256: "cd".repeat(32),
        byteLength: 24,
      }),
    ).resolves.toMatchObject({ outcome: "failed", reason: "unreadable" });
  });

  it("never reads a stored PDF through a symlink to a file or folder outside the project", async () => {
    await using outside = await project();
    const secret = NodePath.join(outside.root, "secret.pdf");
    await NodeFSP.writeFile(secret, textPdf([["OUTSIDE_PROJECT_SYNTHETIC_SECRET"]]));
    for (const link of ["file", "folder"] as const) {
      await using fixture = await project();
      const trial = await addPdfSource(fixture.root, "trial", "Trial", trialPages);
      const attachment = trial.attachments[0]!;
      const stored = NodePath.join(fixture.root, ".scient/sources", attachment.relativePath);
      if (link === "file") {
        await NodeFSP.rm(stored);
        await NodeFSP.symlink(secret, stored);
      } else {
        const folder = NodePath.join(outside.root, `${link}-store`);
        await NodeFSP.mkdir(folder);
        await NodeFSP.copyFile(secret, NodePath.join(folder, NodePath.basename(stored)));
        await NodeFSP.rm(NodePath.dirname(stored), { recursive: true });
        await NodeFSP.symlink(folder, NodePath.dirname(stored), "dir");
      }
      await expect(
        readSourceText({
          root: fixture.root,
          sourceId: trial.sourceId,
          fromPage: 1,
          maxCharacters: 10_000,
        }),
      ).resolves.toEqual({ outcome: "unreadable", attachmentId: attachment.attachmentId });
    }
  });

  it("indexes library PDFs by hash and searches them by passage", async () => {
    await using fixture = await project();
    const trial = await addPdfSource(fixture.root, "trial", "Early antibiotics trial", trialPages);
    await addPdfSource(fixture.root, "cohort", "Cohort", [["A cohort study of yeast."]]);

    await expect(getSourceFullTextStatus(fixture.root)).resolves.toMatchObject({
      pdfs: 2,
      pending: 2,
    });
    await indexSourceFullText(fixture.root);
    const sha256 = trial.attachments[0]!.sha256;
    expect(await listScientSourceFullTextHashes(fixture.root)).toContain(sha256);
    await expect(readScientSourceFullText(fixture.root, sha256)).resolves.toMatchObject({
      outcome: "extracted",
      pageCount: 3,
    });

    const search = await searchSourceFullText({
      root: fixture.root,
      query: "antibiotics mortality",
      limit: 10,
    });
    expect(search.status).toEqual({
      pdfs: 2,
      searchable: 2,
      pending: 0,
      withoutText: 0,
      unreadable: 0,
    });
    expect(search.hits[0]).toMatchObject({
      sourceId: trial.sourceId,
      attachmentId: trial.attachments[0]!.attachmentId,
      title: "Early antibiotics trial",
      page: 2,
      matchedTerms: ["antibiotics", "mortality"],
    });
    expect(search.hits[0]!.passage).toContain("Early antibiotics reduced mortality");
    await expect(
      searchSourceFullText({
        root: fixture.root,
        query: "yeast",
        limit: 10,
        sourceIds: [trial.sourceId],
      }),
    ).resolves.toMatchObject({ hits: [] });
  });

  it("reads pages of one source, extracting them on demand, within a character budget", async () => {
    await using fixture = await project();
    const trial = await addPdfSource(fixture.root, "trial", "Trial", trialPages);
    const first = await readSourceText({
      root: fixture.root,
      sourceId: trial.sourceId,
      fromPage: 1,
      maxCharacters: 60,
    });
    expect(first).toMatchObject({ outcome: "read", pageCount: 3, nextPage: 2 });
    if (first.outcome !== "read") return;
    expect(first.pages.map((page) => page.page)).toEqual([1]);
    await expect(
      readSourceText({
        root: fixture.root,
        sourceId: trial.sourceId,
        fromPage: 3,
        maxCharacters: 10_000,
      }),
    ).resolves.toMatchObject({ outcome: "read", nextPage: null, pages: [{ page: 3 }] });
    await expect(
      readSourceText({ root: fixture.root, sourceId: "missing", fromPage: 1, maxCharacters: 100 }),
    ).resolves.toEqual({ outcome: "source-not-found" });
  });

  it("checks quotes against stored text and returns their exact location", async () => {
    await using fixture = await project();
    const trial = await addPdfSource(fixture.root, "trial", "Trial", trialPages);
    const [exact, normalized, missing] = await checkSourceQuotes({
      root: fixture.root,
      quotes: [
        { quote: "Early antibiotics reduced mortality", sourceId: trial.sourceId },
        { quote: "twelve percent in treated patients over two years", sourceId: trial.sourceId },
        { quote: "Mortality rose by twelve percent", sourceId: trial.sourceId },
      ],
    });
    expect(exact).toMatchObject({
      outcome: "exact",
      sourceId: trial.sourceId,
      ranges: [{ page: 2 }],
      text: "Early antibiotics reduced mortality",
    });
    expect(normalized).toMatchObject({ outcome: "normalized", ranges: [{ page: 3 }] });
    expect(missing).toMatchObject({ outcome: "not-found", closest: [{ page: 3 }] });

    await expect(
      checkSourceQuotes({ root: fixture.root, quotes: [{ quote: "reduced mortality" }] }),
    ).resolves.toMatchObject([{ outcome: "exact", sourceId: trial.sourceId }]);
  });
});
