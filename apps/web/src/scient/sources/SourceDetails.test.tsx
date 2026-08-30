import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { safeSourceExternalUrl, SourceDetails } from "./SourceDetails.tsx";

const record = {
  formatVersion: 1 as const,
  sourceId: "source_test",
  projectId: "project_test",
  revision: 1,
  type: "article" as const,
  title: "Why Most Published Research Findings Are False",
  creators: [
    {
      creatorType: "author",
      givenName: "John",
      familyName: "Ioannidis",
      literalName: null,
    },
  ],
  issuedRaw: "2005",
  issuedYear: 2005,
  identifiers: [
    { scheme: "doi", value: "10.1371/journal.pmed.0020124" },
    { scheme: "issn", value: "1549-1676" },
  ],
  abstract: "Importance\n\nA testable abstract.",
  abstractSections: [{ title: "Importance", paragraphs: ["A testable abstract."] }],
  containerTitle: "PLOS Medicine",
  publisher: "Public Library of Science",
  volume: "2",
  issue: "8",
  pages: "e124",
  language: "en",
  url: "https://example.com/article",
  tags: ["methods"],
  externalReferences: [
    {
      system: "zotero",
      libraryId: "1",
      itemKey: "ABC123",
      itemVersion: 1,
      rawItemType: "journalArticle",
    },
  ],
  attachments: [
    {
      attachmentId: "pdf_test",
      kind: "pdf" as const,
      fileName: "paper.pdf",
      mediaType: "application/pdf" as const,
      sha256: "abc123",
      byteLength: 2048,
      relativePath: "files/sha256/ab/abc123.pdf",
      importedAt: "2026-08-12T12:00:00.000Z",
    },
  ],
  fieldProvenance: [],
  importedAt: "2026-08-12T12:00:00.000Z",
};

const saveNote = async () => ({ outcome: "unchanged" as const, record });

describe("SourceDetails", () => {
  it("renders bibliographic information and the imported attachment", () => {
    const markup = renderToStaticMarkup(
      <SourceDetails
        record={record}
        diagnostics={[]}
        onBack={() => undefined}
        onEdit={() => undefined}
        onSaveNote={saveNote}
        onRefreshMetadata={async () => undefined}
        onRemove={async () => undefined}
        onOpenPdf={() => undefined}
      />,
    );

    expect(markup).toContain(record.title);
    expect(markup).toContain("John Ioannidis");
    expect(markup).toContain("A testable abstract.");
    expect(markup).toContain("Importance");
    expect(markup).toContain("max-h-24");
    expect(markup).toContain("mt-0.5 space-y-1.5");
    expect(markup).toContain("mask-image");
    expect(markup).toContain("Publication details");
    expect(markup).toContain("Reference");
    expect(markup).toContain("Reference style");
    expect(markup).toContain("Preparing reference");
    expect(markup).toContain("Journal:");
    expect(markup).toContain("English");
    expect(markup).not.toContain("Published in");
    expect(markup).not.toContain("10.1371/journal.pmed.0020124");
    expect(markup).toContain('aria-label="View DOI on doi.org"');
    expect(markup).toContain('aria-label="Copy DOI link"');
    expect(markup).toContain("ISSN:");
    expect(markup.indexOf('id="source-reference-heading"')).toBeGreaterThan(
      markup.indexOf("Identifiers and links"),
    );
    expect(markup).toContain("Open PDF");
    expect(markup).toContain("Edit");
    expect(markup).not.toContain("Open original webpage");
    expect(markup).toContain("Imported from Zotero");
  });

  it("does not repeat a canonical abstract wrapper heading", () => {
    const markup = renderToStaticMarkup(
      <SourceDetails
        record={{
          ...record,
          abstract: "Background\n\nEvidence.",
          abstractSections: [
            { title: "Abstract", paragraphs: [] },
            { title: "Background", paragraphs: ["Evidence."] },
          ],
          tags: ["trial", "emergency medicine", "outcomes", "methods", "review"],
        }}
        diagnostics={[]}
        onBack={() => undefined}
        onEdit={() => undefined}
        onSaveNote={saveNote}
        onRefreshMetadata={async () => undefined}
        onRemove={async () => undefined}
        onOpenPdf={() => undefined}
      />,
    );

    expect(markup.match(/>Abstract</gu)).toHaveLength(1);
    expect(markup).toContain(">Background<");
    expect(markup).toContain("font-semibold leading-5");
    expect(markup).toContain("h-6 min-w-0 w-full flex-wrap gap-1.5 overflow-hidden");
  });

  it("keeps metadata-only sources inspectable without offering a PDF action", () => {
    const markup = renderToStaticMarkup(
      <SourceDetails
        record={{ ...record, attachments: [] }}
        diagnostics={[{ field: "identifiers", severity: "info", message: "No identifier." }]}
        onBack={() => undefined}
        onEdit={() => undefined}
        onSaveNote={saveNote}
        onRefreshMetadata={async () => undefined}
        onRemove={async () => undefined}
        onOpenPdf={() => undefined}
      />,
    );

    expect(markup).not.toContain("Open PDF");
    expect(markup).toContain("Metadata needs review");
  });

  it("requires an explicit PDF choice when a Source has several materials", () => {
    const markup = renderToStaticMarkup(
      <SourceDetails
        record={{
          ...record,
          attachments: [
            record.attachments[0]!,
            {
              ...record.attachments[0]!,
              attachmentId: "pdf_supplement",
              fileName: "supplement.pdf",
              sha256: "def456",
              relativePath: "files/sha256/de/def456.pdf",
            },
          ],
        }}
        diagnostics={[]}
        onBack={() => undefined}
        onEdit={() => undefined}
        onSaveNote={saveNote}
        onRefreshMetadata={async () => undefined}
        onRemove={async () => undefined}
        onOpenPdf={() => undefined}
      />,
    );

    expect(markup).toContain('aria-label="Choose a PDF to open"');
    expect(markup).toContain("Open PDF");
  });

  it("keeps a project-owned note directly editable below the reference", () => {
    const markup = renderToStaticMarkup(
      <SourceDetails
        record={{ ...record, note: "Compare this **result** with the *replication* cohort." }}
        diagnostics={[]}
        onBack={() => undefined}
        onEdit={() => undefined}
        onSaveNote={saveNote}
        onRefreshMetadata={async () => undefined}
        onRemove={async () => undefined}
        onOpenPdf={() => undefined}
      />,
    );

    expect(markup).toContain(">Note<");
    expect(markup).toContain(">Notes<");
    expect(markup).toContain("Compare this <strong>result</strong> with the <em>replication</em>");
    expect(markup.indexOf('id="source-note-heading"')).toBeGreaterThan(
      markup.indexOf('id="source-reference-heading"'),
    );
    expect(markup).toContain('aria-label="Edit source note"');
  });

  it("shows a researcher-defined label for another source type", () => {
    const markup = renderToStaticMarkup(
      <SourceDetails
        record={{ ...record, type: "other", customType: "Clinical guideline" }}
        diagnostics={[]}
        onBack={() => undefined}
        onEdit={() => undefined}
        onSaveNote={saveNote}
        onRefreshMetadata={async () => undefined}
        onRemove={async () => undefined}
        onOpenPdf={() => undefined}
      />,
    );

    expect(markup).toContain("Clinical guideline");
    expect(markup).not.toContain(">Other source<");
  });

  it("keeps removal discreet behind the source actions menu", () => {
    const markup = renderToStaticMarkup(
      <SourceDetails
        record={record}
        diagnostics={[]}
        onBack={() => undefined}
        onEdit={() => undefined}
        onSaveNote={saveNote}
        onRefreshMetadata={async () => undefined}
        onRemove={async () => undefined}
        onOpenPdf={() => undefined}
      />,
    );

    expect(markup).toContain('aria-label="More source actions"');
    expect(markup).not.toContain('title="More source actions"');
    expect(markup).not.toContain("Remove this source?");
  });

  it("offers approve and reject actions for a pending agent source", () => {
    const markup = renderToStaticMarkup(
      <SourceDetails
        record={{
          ...record,
          origin: {
            actor: "agent",
            intake: "identifier",
            operationId: "agent-operation",
            review: "pending",
          },
        }}
        diagnostics={[]}
        onBack={() => undefined}
        onEdit={() => undefined}
        onSaveNote={saveNote}
        onRefreshMetadata={async () => undefined}
        onApproveReview={async () => undefined}
        onRemove={async () => undefined}
        onOpenPdf={() => undefined}
      />,
    );

    expect(markup).toContain("Approve review");
    expect(markup).toContain(">Reject</button>");
    expect(markup).toContain("Pending review");
  });
});

describe("safeSourceExternalUrl", () => {
  it("allows web links and rejects active or malformed schemes", () => {
    expect(safeSourceExternalUrl("https://example.com/article")).toBe(
      "https://example.com/article",
    );
    expect(safeSourceExternalUrl("javascript:alert(1)")).toBeNull();
    expect(safeSourceExternalUrl("not a URL")).toBeNull();
  });
});
