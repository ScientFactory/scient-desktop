import * as Schema from "effect/Schema";
import { describe, expect, it } from "@effect/vitest";

import {
  ConversationExportOptions,
  ConversationSnapshotV1,
  DocumentBundle,
  DocumentCitation,
  ScientConversationExportError,
  ScientConversationExportPreparation,
  ScientConversationExportRequest,
  ScientConversationExportResult,
} from "./scientConversationExport.ts";

const DIGEST = `sha256:${"a".repeat(64)}`;
const decodeSnapshot = Schema.decodeUnknownSync(ConversationSnapshotV1);
const encodeSnapshot = Schema.encodeSync(ConversationSnapshotV1);
const decodeBundle = Schema.decodeSync(DocumentBundle);
const decodeUnknownBundle = Schema.decodeUnknownSync(DocumentBundle);
const decodeOptions = Schema.decodeUnknownSync(ConversationExportOptions);
const decodeRequest = Schema.decodeSync(ScientConversationExportRequest);
const decodeResult = Schema.decodeSync(ScientConversationExportResult);
const decodeUnknownResult = Schema.decodeUnknownSync(ScientConversationExportResult);
const decodeUnknownPreparation = Schema.decodeUnknownSync(ScientConversationExportPreparation);
const decodeUnknownError = Schema.decodeUnknownSync(ScientConversationExportError);
const decodeCitation = Schema.decodeUnknownSync(DocumentCitation);

const snapshot = {
  format: "scient.conversation-snapshot",
  version: 1,
  thread: {
    title: "Export design",
    createdAt: "2026-09-27T14:00:00.000Z",
    updatedAt: "2026-09-27T15:00:00.000Z",
    provider: "codex",
    model: "gpt-5",
  },
  provenance: { _tag: "original" },
  captured: {
    threadId: "thread-1",
    snapshotSequence: 42,
    threadSequence: 40,
    capturedAt: "2026-09-27T15:00:01.000Z",
  },
  selection: { workLog: true, reasoning: false, throughMessageId: null },
  messages: [
    {
      n: 1,
      id: "message-1",
      role: "user",
      turnId: null,
      createdAt: "2026-09-27T14:05:00.000Z",
      updatedAt: "2026-09-27T14:05:00.000Z",
      text: "Please investigate [File quote](scient-ref:r1)",
      attachments: [
        {
          localId: "thread-1-5b8f1c2e",
          kind: "image",
          name: "figure.png",
          mimeType: "image/png",
          sizeBytes: 12,
          pastedText: false,
          available: true,
        },
      ],
      references: [
        {
          _tag: "file-excerpt",
          id: "r1",
          label: "File quote",
          path: "notes/report.md",
          startLine: 3,
          endLine: 4,
          unsaved: false,
          text: "quoted",
          comment: null,
        },
      ],
    },
  ],
  reasoning: [],
  workLog: [
    {
      _tag: "tool",
      id: "activity-1",
      turnId: "turn-1",
      createdAt: "2026-09-27T14:05:30.000Z",
      title: "Ran command",
      itemType: "command_execution",
      toolName: null,
      status: "completed",
      command: { text: "ls", omittedLines: 0, omittedChars: 0 },
      detail: null,
      output: { text: "a\n…\nz", omittedLines: 10, omittedChars: 40 },
      changedFiles: [],
      omittedChangedFiles: 0,
    },
  ],
  proposedPlans: [],
  questionAnswers: [],
  omittedRunningTurn: null,
  warnings: [{ _tag: "running-turn-omitted", turnId: "turn-2" }],
  contentDigest: DIGEST,
};

describe("conversation export contracts", () => {
  it("round-trips a version 1 snapshot", () => {
    const decoded = decodeSnapshot(snapshot);
    expect(encodeSnapshot(decoded)).toEqual(snapshot);
  });

  it("rejects an unknown snapshot version and a malformed digest", () => {
    expect(() => decodeSnapshot({ ...snapshot, version: 2 })).toThrow();
    expect(() => decodeSnapshot({ ...snapshot, contentDigest: "sha256:x" })).toThrow();
  });

  it("types inline references and never carries an open context payload", () => {
    const withReference = (reference: unknown) => ({
      ...snapshot,
      messages: [{ ...snapshot.messages[0], references: [reference] }],
    });
    const decoded = decodeSnapshot(
      withReference({
        ...snapshot.messages[0]!.references[0],
        cwd: "/Users/someone/project",
        environmentId: "environment-1",
      }),
    );
    expect(decoded.messages[0]!.references[0]).not.toHaveProperty("cwd");
    expect(decoded.messages[0]!.references[0]).not.toHaveProperty("environmentId");
    expect(() =>
      decodeSnapshot(withReference({ _tag: "unknown-kind", id: "r1", label: "x", payload: {} })),
    ).toThrow();
    expect(
      decodeSnapshot({
        ...snapshot,
        messages: [{ ...snapshot.messages[0], context: { version: 1, records: [] } }],
      }).messages[0],
    ).not.toHaveProperty("context");
  });

  it("records import provenance with external identities only", () => {
    const decoded = decodeSnapshot({
      ...snapshot,
      provenance: {
        _tag: "import",
        source: "markdown",
        exportId: "7f3c9a2e41b8",
        sourceThreadId: null,
        packageDigest: DIGEST,
        sourceFormat: "scient-conversation-markdown",
        sourceFormatVersion: 1,
        importedAt: "2026-09-28T09:00:00.000Z",
      },
    });
    expect(decoded.provenance._tag).toBe("import");
    expect(() =>
      decodeSnapshot({
        ...snapshot,
        provenance: { _tag: "import", source: "email", exportId: "x" },
      }),
    ).toThrow();
  });

  it("never accepts a provider payload on a work-log entry", () => {
    const decoded = decodeSnapshot({
      ...snapshot,
      workLog: [{ ...snapshot.workLog[0], data: { secret: "token" } }],
    });
    expect(decoded.workLog[0]).not.toHaveProperty("data");
  });

  it("decodes a document bundle with available and unavailable assets", () => {
    const bundle = decodeBundle({
      markdown: "![figure.png](scient-asset:m1-a1)",
      profile: "chat",
      metadata: {
        title: "Export design",
        language: null,
        direction: "auto",
        createdAt: null,
        source: {
          _tag: "conversation",
          threadId: "thread-1",
          contentDigest: DIGEST,
          snapshotSequence: 42,
        },
      },
      assets: [
        {
          id: "m1-a1",
          role: "image",
          fileName: "figure.png",
          mediaType: "image/png",
          byteLength: 3,
          packagePath: "attachments/01-figure.png",
          content: { _tag: "bytes", bytes: new Uint8Array([1, 2, 3]), sha256: DIGEST },
        },
        {
          id: "m1-a2",
          role: "attachment",
          fileName: "notes.pdf",
          mediaType: "application/pdf",
          byteLength: 10,
          packagePath: "attachments/02-notes.pdf",
          content: { _tag: "unavailable", reason: "missing" },
        },
      ],
      citations: [
        {
          _tag: "file-excerpt",
          id: "c1",
          path: "notes/report.md",
          startLine: 3,
          endLine: 4,
          unsaved: false,
          text: "quoted",
          comment: null,
        },
      ],
      warnings: [{ code: "attachment-unavailable", message: "notes.pdf was unavailable." }],
    });
    expect(bundle.assets).toHaveLength(2);
    expect(() =>
      decodeUnknownBundle({
        ...bundle,
        assets: [{ ...bundle.assets[0], id: "Bad Id" }],
      }),
    ).toThrow();
  });

  it("keeps work log and reasoning explicit in export options", () => {
    expect(() => decodeOptions({ range: { _tag: "whole" } })).toThrow();
    expect(
      decodeOptions({
        includeWorkLog: false,
        includeReasoning: false,
        range: { _tag: "through-message", messageId: "message-3" },
        markdownPackaging: "with-attachments",
      }),
    ).toMatchObject({ includeWorkLog: false, includeReasoning: false });
  });

  it("decodes export requests and results", () => {
    expect(
      decodeRequest({
        threadId: "thread-1",
        format: "markdown",
        options: { includeWorkLog: false, includeReasoning: false, range: { _tag: "whole" } },
        delivery: "clipboard",
      }).delivery,
    ).toBe("clipboard");
    expect(
      decodeResult({
        exportId: "export-1",
        format: "markdown",
        contentDigest: DIGEST,
        messageCount: 2,
        file: {
          fileName: "Export design.md",
          mediaType: "text/markdown; charset=utf-8",
          byteLength: 120,
          relativeUrl: "/api/assets/token/Export%20design.md",
          expiresAt: 1,
        },
        text: null,
        warnings: [],
      }).file?.fileName,
    ).toBe("Export design.md");
  });

  it("lets an older client read a newer server's formats, warnings, and refusals", () => {
    const preparation = decodeUnknownPreparation({
      threadId: "thread-1",
      title: "Export design",
      formats: [
        { format: "markdown", available: true, unavailableReason: null },
        { format: "epub", available: true, unavailableReason: null },
      ],
      messageCount: 2,
      attachmentCount: 0,
      workLogEntryCount: 0,
      reasoningCount: 0,
      runningTurnOmitted: false,
      messages: [],
    });
    expect(preparation.formats.map((format) => format.format)).toEqual(["markdown"]);

    const result = decodeUnknownResult({
      exportId: "export-1",
      format: "markdown",
      contentDigest: DIGEST,
      messageCount: 2,
      file: null,
      text: "# Export design\n",
      warnings: [
        { code: "attachment-unavailable", message: "Attachment “a.png” was unavailable." },
        { code: "some-future-warning", message: "Something new happened." },
      ],
    });
    expect(result.warnings).toEqual([
      { code: "attachment-unavailable", message: "Attachment “a.png” was unavailable." },
      { code: null, message: "Something new happened." },
    ]);

    const refusal = decodeUnknownError({
      _tag: "ScientConversationExportError",
      reason: "some-future-reason",
      message: "This export is not possible yet.",
    });
    expect(refusal.reason).toBeNull();
    expect(refusal.message).toBe("This export is not possible yet.");
    expect(
      decodeUnknownError({
        _tag: "ScientConversationExportError",
        reason: "too-large",
        message: "Too large.",
      }).reason,
    ).toBe("too-large");
  });

  it("carries complete CSL-JSON for a journal article", () => {
    const citation = decodeCitation({
      _tag: "bibliographic",
      id: "c1",
      key: "smith2024",
      reference: {
        id: "src-1",
        type: "article-journal",
        title: "Measured outcomes",
        author: [
          { family: "Smith", given: "Ada" },
          { family: "Beethoven", given: "Ludwig", "non-dropping-particle": "van" },
        ],
        issued: { "date-parts": [[2024, 3, 7]] },
        "container-title": "Journal of Results",
        volume: "12",
        issue: "4",
        page: "101-119",
        DOI: "10.1000/xyz",
        ISSN: "1234-5678",
        URL: "https://example.org/a",
      },
    });
    if (citation._tag !== "bibliographic" || citation.reference === null)
      throw new Error("Expected a bibliographic reference.");
    expect(citation.reference).toMatchObject({ volume: "12", issue: "4", page: "101-119" });
    expect(citation.reference.author?.[1]).toEqual({
      family: "Beethoven",
      given: "Ludwig",
      "non-dropping-particle": "van",
    });
  });

  it("carries a book with an editor and a corporate author, and no unknown fields", () => {
    const citation = decodeCitation({
      _tag: "bibliographic",
      id: "c2",
      key: "who2023",
      reference: {
        id: "src-2",
        type: "book",
        title: "Global report",
        author: [{ literal: "World Health Organization" }],
        editor: [{ family: "Jones", given: "B." }],
        issued: { "date-parts": [[2023]] },
        accessed: { "date-parts": [[2026, 9, 1]] },
        publisher: "WHO Press",
        "publisher-place": "Geneva",
        edition: "2",
        ISBN: "978-92-4-000000-0",
        custom: { secret: "never carried" },
      },
    });
    if (citation._tag !== "bibliographic" || citation.reference === null)
      throw new Error("Expected a bibliographic reference.");
    expect(citation.reference.author).toEqual([{ literal: "World Health Organization" }]);
    expect(citation.reference.editor).toEqual([{ family: "Jones", given: "B." }]);
    expect(citation.reference).not.toHaveProperty("custom");
    expect(() =>
      decodeCitation({
        _tag: "bibliographic",
        id: "c3",
        key: "x",
        reference: { id: "x", type: "not-a-csl-type" },
      }),
    ).toThrow();
    expect(() =>
      decodeCitation({
        _tag: "bibliographic",
        id: "c3",
        key: "x",
        reference: { id: "x", type: "book", author: [{ suffix: "Jr." }] },
      }),
    ).toThrow();
  });
});
