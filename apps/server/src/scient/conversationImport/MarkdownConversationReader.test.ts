// @effect-diagnostics nodeBuiltinImport:off -- isolated synthetic files exercise staging input.
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { buildConversationDocument, writeConversationMarkdown } from "@scientfactory/conversation";
import { describe, expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";

import { capturedSnapshot } from "../conversationFile/scic.test-fixtures.ts";
import { destination, IMPORT_ID } from "./conversationImport.test-fixtures.ts";
import { buildConversationImportCommand, ConversationImportIds } from "./conversationImportPlan.ts";
import { readMarkdownConversation } from "./MarkdownConversationReader.ts";

const EXPORT_VALUE = "7f3c9a2e41b8";
const decodeImportIds = Schema.decodeUnknownSync(ConversationImportIds);

function fixtureMarkdown(firstQuestion = "Question 1"): string {
  const snapshot = {
    ...capturedSnapshot,
    messages: [
      { ...capturedSnapshot.messages[0]!, text: firstQuestion, attachments: [], references: [] },
      { ...capturedSnapshot.messages[1]!, text: "Answer 1" },
      {
        ...capturedSnapshot.messages[0]!,
        n: 3,
        id: "message-3" as never,
        text: "Question 2",
        createdAt: "2026-09-27T14:07:00.000Z",
        updatedAt: "2026-09-27T14:07:00.000Z",
        attachments: [],
        references: [],
      },
      {
        ...capturedSnapshot.messages[1]!,
        n: 4,
        id: "message-4" as never,
        turnId: "turn-2" as never,
        text: "Answer 2",
        createdAt: "2026-09-27T14:08:00.000Z",
        updatedAt: "2026-09-27T14:08:00.000Z",
      },
    ],
    warnings: [],
  };
  const document = buildConversationDocument({
    snapshot,
    exportValue: EXPORT_VALUE,
    timeZone: "UTC",
    resolveAttachment: () => ({ _tag: "unavailable", reason: "missing" }),
  });
  return writeConversationMarkdown({
    bundle: document.bundle,
    exportValue: EXPORT_VALUE,
    exported: "2026-09-28T09:12:00.000Z",
    packaging: "text",
  });
}

function read(source: string, mode: "messages" | "document" = "messages") {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "scient-markdown-import-"));
  try {
    const path = NodePath.join(root, "conversation.md");
    const bytes = new TextEncoder().encode(source);
    NodeFS.writeFileSync(path, bytes);
    const digest = `sha256:${NodeCrypto.createHash("sha256").update(bytes).digest("hex")}` as const;
    return readMarkdownConversation({
      importId: IMPORT_ID as never,
      path,
      fileName: "conversation.md",
      packageSha256: digest,
      packageBytes: bytes.byteLength,
      attachmentsDirectory: NodePath.join(root, "attachments"),
      mode,
      receivedAt: "2026-09-28T10:00:00.000Z",
    });
  } finally {
    NodeFS.rmSync(root, { recursive: true, force: true });
  }
}

describe("Markdown conversation import adapter", () => {
  it("round trips visible message text and turns, dropping work log, reasoning, and plans", () => {
    const result = read(fixtureMarkdown());
    expect(result.kind).toBe("markdown");
    expect(result.issues).toEqual([]);
    expect(result.validated.package.sourceThreadId).toBeNull();
    expect(
      result.validated.snapshot.messages.map((message) => [message.role, message.text]),
    ).toEqual([
      ["user", "Question 1"],
      ["assistant", "Answer 1"],
      ["user", "Question 2"],
      ["assistant", "Answer 2"],
    ]);
    expect(result.validated.snapshot.messages[1]?.turnId).toBe("markdown-turn-1");
    expect(result.validated.snapshot.reasoning).toEqual([]);
    expect(result.validated.snapshot.workLog).toEqual([]);
    expect(result.validated.snapshot.proposedPlans).toEqual([]);
    expect(result.validated.attachments).toEqual([]);
  });

  it("preserves submitted provider questions and answers in the imported text", () => {
    const snapshot = {
      ...capturedSnapshot,
      messages: [
        ...capturedSnapshot.messages,
        {
          ...capturedSnapshot.messages[0]!,
          n: 3,
          id: "async-answer:answered-request" as never,
          text: "React & TypeScript",
          createdAt: "2026-09-27T14:05:30.000Z",
          updatedAt: "2026-09-27T14:05:30.000Z",
          attachments: [],
          references: [],
        },
      ],
      questionAnswers: [
        {
          id: "answered-request",
          turnId: capturedSnapshot.messages[1]!.turnId,
          createdAt: "2026-09-27T14:05:30.000Z",
          items: [
            { question: "Which framework?", answer: "React & TypeScript", attachments: [] },
            { question: "Why?", answer: "The existing app uses them.", attachments: [] },
          ],
        },
      ],
    };
    const document = buildConversationDocument({
      snapshot,
      exportValue: EXPORT_VALUE,
      timeZone: "UTC",
      resolveAttachment: () => ({ _tag: "unavailable", reason: "missing" }),
    });
    const markdown = writeConversationMarkdown({
      bundle: document.bundle,
      exportValue: EXPORT_VALUE,
      exported: "2026-09-28T09:12:00.000Z",
      packaging: "text",
    });
    expect(markdown).toContain(`kind=answers -->`);
    expect(markdown).toContain("React &amp; TypeScript");
    expect(markdown).not.toContain("async-answer:answered-request");
    const result = read(markdown.replace("React &amp; TypeScript", "Vue &amp; TypeScript"));
    expect(result.kind).toBe("markdown");
    expect(result.issues).toEqual([]);
    expect(result.validated.snapshot.messages).toHaveLength(2);
    expect(result.validated.snapshot.messages[1]?.text).toContain("**Q:** Which framework?");
    expect(result.validated.snapshot.messages[1]?.text).toContain("**A:** Vue &amp; TypeScript");
    expect(result.validated.snapshot.messages[1]?.text).toContain("**Q:** Why?");
    expect(result.validated.snapshot.messages[1]?.text).toContain(
      "**A:** The existing app uses them.",
    );
    expect(result.validated.snapshot.questionAnswers).toEqual([]);
  });

  it("preserves visible terminal context text when a conversation Markdown export is imported", () => {
    const snapshot = {
      ...capturedSnapshot,
      messages: [
        {
          ...capturedSnapshot.messages[0]!,
          text: "Please inspect [these lines](scient-ref:r2).",
          attachments: [],
          references: [
            {
              _tag: "terminal" as const,
              id: "r2",
              label: "these lines",
              terminal: "terminal-1",
              lineStart: 10,
              lineEnd: 11,
              text: { text: "critical stack trace", omittedLines: 0, omittedChars: 0 },
            },
          ],
        },
      ],
    };
    const document = buildConversationDocument({
      snapshot,
      exportValue: EXPORT_VALUE,
      timeZone: "UTC",
      resolveAttachment: () => ({ _tag: "unavailable", reason: "missing" }),
    });
    const markdown = writeConversationMarkdown({
      bundle: document.bundle,
      exportValue: EXPORT_VALUE,
      exported: "2026-09-28T09:12:00.000Z",
      packaging: "text",
    });
    expect(markdown).toContain("kind=context");
    const imported = read(markdown);
    expect(imported.validated.snapshot.messages[0]?.text).toContain("critical stack trace");
    expect(imported.validated.snapshot.messages[0]?.text).toContain("**Context**");
    expect(imported.validated.snapshot.messages[0]?.references).toEqual([]);
  });

  it("feeds the existing command with fresh local IDs and Markdown provenance", () => {
    const validated = read(fixtureMarkdown()).validated;
    const ids = decodeImportIds({
      threadId: "fresh-thread",
      commandId: "fresh-command",
      messages: Object.fromEntries(
        validated.snapshot.messages.map((message, index) => [
          message.id,
          `fresh-message-${index + 1}`,
        ]),
      ),
      turns: {
        "turn:markdown-turn-1": "fresh-turn-1",
        "turn:markdown-turn-2": "fresh-turn-2",
      },
      attachments: {},
      proposedPlans: {},
      workLog: {},
      questionAnswers: {},
    });
    const command = buildConversationImportCommand({
      validated,
      ids,
      destination: destination(),
      importedAt: "2026-09-28T10:01:00.000Z",
    });
    expect(command.type).toBe("thread.conversation.import");
    expect(command.messages.map((message) => message.messageId)).toEqual([
      "fresh-message-1",
      "fresh-message-2",
      "fresh-message-3",
      "fresh-message-4",
    ]);
    expect(command.origin.source).toBe("markdown");
    expect(command.origin.sourceThreadId).toBeNull();
    expect(command.origin.packageDigest).toBe(validated.package.packageSha256);
  });

  it("imports edits to visible text and reports damaged markers without assigning their text to a clean message", () => {
    const edited = fixtureMarkdown()
      .replace("Question 1", "Edited question")
      .replace(`n=2 role=assistant`, `n=2 role=robot`)
      .replace(`n=4 role=assistant`, `n=5 role=assistant`);
    const result = read(edited);
    expect(result.validated.snapshot.messages.map((message) => message.text)).toEqual([
      "Edited question",
      "Question 2",
      "Answer 2",
    ]);
    expect(result.issues.map((issue) => issue.kind)).toContain("unknown-role");
    expect(result.issues.map((issue) => issue.kind)).toContain("missing-number");
    expect(result.issues.every((issue) => issue.endLine >= issue.startLine)).toBe(true);
  });

  it("does not import an edited assistant marker as part of the preceding user request", () => {
    const edited = fixtureMarkdown().replace(
      `<!-- scient:message export=${EXPORT_VALUE} n=2 role=assistant`,
      "<!-- scient:message export=0123456789ab n=2 role=assistant",
    );
    const result = read(edited);
    expect(result.validated.snapshot.messages.map((message) => message.text)).toEqual([
      "Question 1",
      "Question 2",
      "Answer 2",
    ]);
    expect(result.issues.map((issue) => issue.kind)).toContain("foreign-marker");
    expect(result.validated.snapshot.messages[0]?.text).not.toContain("Answer 1");
  });

  it("round trips literal markers, quoted exports, speaker headings, and reused labels", () => {
    const body = [
      "## Assistant · 27 Sep 2026, 14:06 UTC",
      "",
      "See [source][same] and note[^same].",
      "",
      "[same]: https://example.org/one",
      "[^same]: detail",
      "",
      "<!-- scient:message export=7f3c9a2e41b8 n=99 role=user time=2026-09-27T14:05:00Z -->",
      "",
      "> <!-- scient:message export=0123456789ab n=1 role=assistant time=2026-09-27T14:05:00Z -->",
      "",
      "```markdown",
      "<!-- scient:message export=7f3c9a2e41b8 n=100 role=user time=2026-09-27T14:05:00Z -->",
      "```",
    ].join("\n");
    const result = read(fixtureMarkdown(body));
    expect(result.kind).toBe("markdown");
    expect(result.issues).toEqual([]);
    expect(result.validated.snapshot.messages).toHaveLength(4);
    expect(result.validated.snapshot.messages[0]?.text).toContain(
      "[same]: https://example.org/one",
    );
    expect(result.validated.snapshot.messages[0]?.text).toContain(
      "<!-- scient:message export=7f3c9a2e41b8 n=99",
    );
    expect(result.validated.snapshot.messages[0]?.text).toContain("## Assistant · 27 Sep 2026");
  });

  it("retains exported attachment names as text without treating files as present", () => {
    const document = buildConversationDocument({
      snapshot: capturedSnapshot,
      exportValue: EXPORT_VALUE,
      timeZone: "UTC",
      resolveAttachment: () => ({ _tag: "unavailable", reason: "missing" }),
    });
    const markdown = writeConversationMarkdown({
      bundle: document.bundle,
      exportValue: EXPORT_VALUE,
      exported: "2026-09-28T09:12:00.000Z",
      packaging: "text",
    });
    const result = read(markdown);
    expect(result.validated.snapshot.messages[0]?.text).toContain("figure.png");
    expect(result.validated.snapshot.messages[0]?.text).toContain("paper.pdf");
    expect(result.validated.snapshot.messages[0]?.attachments).toEqual([]);
    expect(result.validated.warnings[0]?._tag).toBe("export-warning");
  });

  it("never turns ordinary headings or quoted markers into transcript messages", () => {
    const ordinary = [
      "# Meeting notes",
      "",
      "## You · 27 Sep 2026",
      "",
      "> <!-- scient:message export=7f3c9a2e41b8 n=1 role=user time=2026-09-27T14:05:00Z -->",
      "",
      "```markdown",
      "<!-- scient:message export=7f3c9a2e41b8 n=1 role=user time=2026-09-27T14:05:00Z -->",
      "```",
    ].join("\n");
    const result = read(ordinary);
    expect(result.kind).toBe("document");
    expect(result.validated.snapshot.messages).toHaveLength(1);
    expect(result.validated.snapshot.messages[0]?.role).toBe("user");
    expect(result.validated.attachments).toHaveLength(1);
    expect(result.validated.omissions).toEqual([]);
  });

  it("offers the complete file as an attachment when the user chooses document mode", () => {
    const result = read(fixtureMarkdown(), "document");
    expect(result.kind).toBe("document");
    expect(result.validated.snapshot.messages).toHaveLength(1);
    expect(result.validated.attachments[0]?.name).toBe("conversation.md");
    expect(result.validated.omissions).toEqual([]);
  });
});
