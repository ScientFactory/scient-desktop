import { EnvironmentId } from "@t3tools/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { SourceEditor } from "./SourceEditor.tsx";

const record = {
  formatVersion: 1 as const,
  sourceId: "source_test",
  projectId: "project_test",
  revision: 2,
  type: "article" as const,
  title: "Correctable source",
  creators: [
    {
      creatorType: "author",
      givenName: "Ada",
      familyName: "Lovelace",
      literalName: null,
    },
  ],
  issuedRaw: "2026",
  issuedYear: 2026,
  identifiers: [{ scheme: "doi", value: "10.1000/test" }],
  abstract: "Abstract",
  containerTitle: "Journal",
  publisher: null,
  volume: "1",
  issue: "2",
  pages: "3-4",
  language: "en",
  url: "https://example.com/source",
  tags: ["reviewed"],
  externalReferences: [
    {
      system: "zotero",
      libraryId: "0",
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
      sha256: "abcdef",
      byteLength: 100,
      relativePath: "files/sha256/ab/abcdef.pdf",
      importedAt: "2026-08-12T12:00:00.000Z",
    },
  ],
  fieldProvenance: [],
  importedAt: "2026-08-12T12:00:00.000Z",
};

describe("SourceEditor", () => {
  it("keeps the accepted detail hierarchy while exposing only editable metadata", () => {
    const markup = renderToStaticMarkup(
      <SourceEditor
        environmentId={EnvironmentId.make("environment_test")}
        root="/project"
        record={record}
        onCancel={() => undefined}
        onRefreshed={() => undefined}
        onSaved={() => undefined}
      />,
    );

    expect(markup).toContain("Source");
    expect(markup).toContain("Creators");
    expect(markup).toContain("Publication details");
    expect(markup).toContain("Identifiers and links");
    expect(markup).toContain("Correctable source");
    expect(markup).not.toContain("pdf_test");
    expect(markup).not.toContain("ABC123");
    expect(markup).not.toContain("project_test");
    expect(markup).toContain("disabled");
    expect(markup).toContain("hover:bg-accent");
    expect(markup).not.toContain("Book chapter");
    expect(markup).not.toContain("Conference paper");
    expect(markup).not.toContain("Dataset");
    expect(markup).not.toContain("Web source");
  });

  it("offers a free-text type when Other source is selected", () => {
    const markup = renderToStaticMarkup(
      <SourceEditor
        environmentId={EnvironmentId.make("environment_test")}
        root="/project"
        record={{ ...record, type: "other", customType: "Clinical guideline" }}
        onCancel={() => undefined}
        onRefreshed={() => undefined}
        onSaved={() => undefined}
      />,
    );

    expect(markup).toContain("Source type");
    expect(markup).toContain("Clinical guideline");
  });

  it("keeps an empty tag list pristine and requires a name for Other source", () => {
    const pristineMarkup = renderToStaticMarkup(
      <SourceEditor
        environmentId={EnvironmentId.make("environment_test")}
        root="/project"
        record={{ ...record, tags: [] }}
        onCancel={() => undefined}
        onRefreshed={() => undefined}
        onSaved={() => undefined}
      />,
    );
    const invalidOtherMarkup = renderToStaticMarkup(
      <SourceEditor
        environmentId={EnvironmentId.make("environment_test")}
        root="/project"
        record={{ ...record, type: "other", customType: null }}
        onCancel={() => undefined}
        onRefreshed={() => undefined}
        onSaved={() => undefined}
      />,
    );

    expect(pristineMarkup).toContain("disabled");
    expect(invalidOtherMarkup).toContain("Enter the source type.");
    expect(invalidOtherMarkup).toContain('aria-invalid="true"');
  });
});
