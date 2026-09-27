import * as Schema from "effect/Schema";
import { describe, expect, it } from "@effect/vitest";

import {
  ConversationExportOptions,
  ConversationSnapshotV1,
  DocumentBundle,
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
      text: "Please investigate",
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
});
