import { describe, expect, it } from "@effect/vitest";
import { beforeEach } from "vite-plus/test";
import { ScientConversationExportResult, TurnId, type ChatAttachment } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

import { importedMessageMarkdown } from "./conversationDocument.ts";
import { parseConversationMarkdown } from "./conversationMarkdown.ts";
import { parseMarkdown, visitNodes } from "./markdownAst.ts";
import { packagedAssets } from "./markdownExport.ts";
import {
  DIGEST,
  activity,
  exportMarkdown,
  generatedNames,
  message,
  resetClock,
  snapshotOf,
  thread,
  tick,
} from "./thread.test-fixtures.ts";

beforeEach(resetClock);

const encodeExportResult = Schema.encodeSync(ScientConversationExportResult);

const image: ChatAttachment = {
  type: "image",
  id: "thread-1-11111111-1111-4111-8111-111111111111",
  name: "figure 1.png",
  mimeType: "image/png",
  sizeBytes: 12,
};
const pdf: ChatAttachment = {
  type: "file",
  id: "thread-1-22222222-2222-4222-8222-222222222222.pdf",
  name: "notes.pdf",
  mimeType: "application/pdf",
  sizeBytes: 2_048,
};

/** Rendered line-break structure of a body: the count of hard breaks chat would show. */
function hardBreaks(markdown: string): number {
  let count = 0;
  visitNodes(parseMarkdown(markdown), (node) => {
    if (node.type === "break") count += 1;
  });
  return count;
}

function bodies(markdown: string) {
  const parsed = parseConversationMarkdown(markdown);
  if (parsed.kind !== "conversation") throw new Error("Expected a conversation.");
  return parsed.messages.map((entry) => entry.body);
}

describe("conversation document", () => {
  it("presents assistant citation prose without rewriting raw imports, user text or code", () => {
    const marker = "\uE200cite\uE202turn3view1\uE201";
    const unsafe = "\uE200cite\uE202unsafe\uE201";
    const missing = "\uE200cite\uE202missing\uE201";
    const raw = `Evidence ${marker} and ${unsafe} and ${missing}.\n\nInline \`${marker}\`.\n\n\`\`\`text\n${marker}\n\`\`\``;
    const original = snapshotOf(
      thread({
        messages: [
          message({ id: "user-citation", role: "user", text: marker }),
          message({ id: "assistant-citation", role: "assistant", text: raw, turnId: "t1" }),
          message({ id: "ordinary-assistant", role: "assistant", text: marker, turnId: "t2" }),
        ],
      }),
    );
    const snapshot = {
      ...original,
      messages: original.messages.map((entry) =>
        entry.id === "assistant-citation"
          ? {
              ...entry,
              citationPresentation: {
                format: "codex-private-v1" as const,
                sources: [
                  { id: "turn3view1", url: "https://example.org/evidence", title: "Evidence" },
                  { id: "unsafe", url: "file:///private/local-evidence" },
                ],
              },
            }
          : entry,
      ),
    };
    const { markdown } = exportMarkdown(snapshot);
    const [user, assistant, ordinary] = bodies(markdown);
    expect(user).toBe(marker);
    expect(ordinary).toBe(marker);
    expect(assistant).toContain(
      'Evidence [1](<https://example.org/evidence> "Evidence") and [citation unavailable] and [citation unavailable].',
    );
    expect(assistant).toContain(`Inline \`${marker}\``);
    expect(assistant).toContain(`\`\`\`text\n${marker}\n\`\`\``);
    expect(assistant).not.toContain("file:///private/local-evidence");
    expect(snapshot.messages[1]?.text).toBe(raw);
    expect(importedMessageMarkdown(snapshot.messages[1]!)).toBe(raw);
    // The importer still resolves its own typed context without presenting provider syntax.
    expect(
      importedMessageMarkdown({
        ...snapshot.messages[1]!,
        text: `${raw}\n[context](scient-ref:missing)`,
      }).startsWith(`${raw}\n`),
    ).toBe(true);
  });

  it("writes chat's line breaks explicitly, per role", () => {
    const { markdown } = exportMarkdown(
      snapshotOf(
        thread({
          messages: [
            message({ id: "m1", role: "user", text: "line one\nline two\n> quoted\n> again" }),
            message({ id: "m2", role: "assistant", text: "joined\nby markdown", turnId: "t1" }),
            message({
              id: "m3",
              role: "assistant",
              text: "★ Insight ─────\nkept\napart",
              turnId: "t2",
            }),
          ],
        }),
      ),
    );
    const [user, plain, insight] = bodies(markdown);
    expect(user).toBe("line one\\\nline two\n> quoted\\\n> again");
    expect(hardBreaks(user!)).toBe(2);
    // Assistant text without an Insight block follows ordinary Markdown in chat.
    expect(plain).toBe("joined\nby markdown");
    expect(hardBreaks(plain!)).toBe(0);
    expect(hardBreaks(insight!)).toBe(2);
  });

  it("keeps line breaks inside code and math untouched", () => {
    const { markdown } = exportMarkdown(
      snapshotOf(
        thread({
          messages: [
            message({ id: "m1", role: "user", text: "```\na\nb\n```\n\n$$\nx\ny\n$$\n\n`a\nb`" }),
          ],
        }),
      ),
    );
    expect(bodies(markdown)[0]).toBe("```\na\nb\n```\n\n$$\nx\ny\n$$\n\n`a\nb`");
  });

  it("shows raw HTML as chat does for each role", () => {
    const { markdown } = exportMarkdown(
      snapshotOf(
        thread({
          messages: [
            message({ id: "m1", role: "user", text: "<b>bold?</b> &amp; <div>block</div>" }),
            message({
              id: "m2",
              role: "assistant",
              text: "<b>bold</b>\n\n<div>block</div>",
              turnId: "t1",
            }),
          ],
        }),
      ),
    );
    const [user, assistant] = bodies(markdown);
    // Chat parses user Markdown without raw HTML, so tags read as text.
    expect(user).toBe("&lt;b>bold?&lt;/b> &amp; &lt;div>block&lt;/div>");
    // Assistant HTML renders (sanitized by the viewer), so it is kept.
    expect(assistant).toBe("<b>bold</b>\n\n<div>block</div>");
  });

  it("lists attachments with availability and packages the available ones", () => {
    const snapshot = snapshotOf(
      thread({
        messages: [
          message({ id: "m1", role: "user", text: "See attached", attachments: [image, pdf] }),
        ],
      }),
      undefined,
      (attachment) => attachment.id === image.id,
    );
    const text = exportMarkdown(snapshot);
    expect(text.markdown).toContain("- figure 1.png · image/png, 12 B");
    expect(text.markdown).toContain("- notes.pdf · unavailable");
    expect(text.markdown).not.toContain("scient-asset:");
    expect(text.document.bundle.warnings.map((warning) => warning.code)).toContain(
      "attachment-unavailable",
    );
    expect(text.markdown).toContain("**Export notes**");

    const packaged = exportMarkdown(snapshot, { packaging: "with-attachments" });
    expect(packaged.markdown).toContain("- ![figure 1.png](attachments/01-figure-1.png)");
    expect(packaged.markdown).toContain("- notes.pdf · unavailable");
    expect(packagedAssets(packaged.document.bundle).map((asset) => asset.path)).toEqual([
      "attachments/01-figure-1.png",
    ]);
  });

  it("names packaged attachments safely for any Unicode name", () => {
    const names = generatedNames(300);
    const attachments = names.map((name, index): ChatAttachment => ({
      type: "file",
      id: `thread-1-generated-${index}`,
      name,
      mimeType: "application/octet-stream",
      sizeBytes: 1,
    }));
    const snapshot = snapshotOf(
      thread({ messages: [message({ id: "m1", role: "user", text: "Files", attachments })] }),
    );
    const packaged = exportMarkdown(snapshot, { packaging: "with-attachments" });
    const paths = packagedAssets(packaged.document.bundle).map((asset) => asset.path);
    expect(paths).toHaveLength(names.length);
    for (const path of paths) {
      expect(path.isWellFormed()).toBe(true);
      expect(path).toMatch(/^attachments\/\d{2,}-[\p{L}\p{N}._-]+$/u);
      expect(path.endsWith(".")).toBe(false);
      expect(new TextEncoder().encode(path.split("/")[1]!).byteLength).toBeLessThanOrEqual(255);
      expect(packaged.markdown).toContain(`(${path.split("/").map(encodeURIComponent).join("/")})`);
    }
  });

  it("renders inline references readably and records file-excerpt citations", () => {
    const citation = {
      kind: "file",
      version: 1,
      environmentId: "environment-local",
      threadId: "thread-1",
      cwd: "/Users/someone/project",
      path: "notes/report.md",
      revision: `sha256:${"b".repeat(64)}`,
      origin: "saved",
      sourceStart: 0,
      sourceEnd: 10,
      startLine: 3,
      endLine: 4,
      from: 1,
      to: 9,
      text: "The quoted *finding*",
      comment: "Why?",
      prefix: "",
      suffix: "",
    };
    const href = `scient-file-citation://v1/?${new URLSearchParams({ data: JSON.stringify(citation) })}`;
    const snapshot = snapshotOf(
      thread({
        messages: [
          message({
            id: "m1",
            role: "user",
            text: `Look at this [File quote](${href}) and ![shot](t3-context://v1/image/ctx_1) with [src/app.ts](t3-context://v1/mention/ctx_2)`,
            attachments: [image],
            context: {
              version: 1,
              records: [
                {
                  version: 1,
                  contextId: "ctx_1" as never,
                  label: "shot",
                  kind: "image",
                  attachmentId: image.id,
                  name: image.name,
                  mimeType: image.mimeType,
                  sizeBytes: image.sizeBytes,
                },
                {
                  version: 1,
                  contextId: "ctx_2" as never,
                  label: "src/app.ts",
                  kind: "mention",
                  path: "/Users/someone/project/src/app.ts",
                },
              ],
            },
          }),
        ],
      }),
    );
    expect(JSON.stringify(snapshot)).not.toContain("/Users/someone");
    expect(JSON.stringify(snapshot)).not.toContain("environment-local");
    const { markdown, document } = exportMarkdown(snapshot, { packaging: "with-attachments" });
    expect(markdown).toContain("**Quote from `notes/report.md`**, lines 3–4:");
    expect(markdown).toContain("> The quoted \\*finding\\*");
    expect(markdown).toContain("Comment: Why?");
    expect(markdown).toContain("![shot](attachments/01-figure-1.png)");
    expect(markdown).toContain("`src/app.ts`");
    expect(markdown).not.toContain("scient-file-citation:");
    expect(markdown).not.toContain("t3-context:");
    expect(document.bundle.citations).toEqual([
      {
        _tag: "file-excerpt",
        id: "c1",
        path: "notes/report.md",
        startLine: 3,
        endLine: 4,
        unsaved: false,
        text: "The quoted *finding*",
        comment: "Why?",
      },
    ]);
  });

  it("neutralizes asset links a message wrote itself", () => {
    const { markdown } = exportMarkdown(
      snapshotOf(
        thread({
          messages: [
            message({
              id: "m1",
              role: "user",
              text: "[x](scient-asset:m1-a1)",
              attachments: [image],
            }),
          ],
        }),
      ),
      { packaging: "with-attachments" },
    );
    expect(bodies(markdown)[0]).toBe("[x](scient-asset%3Am1-a1)");
  });

  it("adds work log and reasoning only when selected, under the answer they belong to", () => {
    const messages = [
      message({ id: "m1", role: "user", text: "Run it" }),
      message({ id: "r1", role: "reasoning", text: "Thinking\nhard", turnId: "t1" }),
    ];
    const activities = [
      activity({
        id: "a1",
        kind: "tool.completed",
        turnId: "t1",
        summary: "Ran command",
        payload: {
          itemType: "command_execution",
          toolCallId: "call-1",
          status: "completed",
          title: "Ran command",
          data: {
            item: { command: "ls -la", aggregatedOutput: "file-a\nfile-b" },
            token: "sk-secret",
          },
        },
      }),
    ];
    const answer = message({ id: "m2", role: "assistant", text: "Done", turnId: "t1" });
    const source = thread({ messages: [...messages, answer], activities });

    const plain = exportMarkdown(snapshotOf(source)).markdown;
    expect(plain).not.toContain("Work log");
    expect(plain).not.toContain("Reasoning");
    expect(plain).not.toContain("Thinking");
    expect(plain).not.toContain("ls -la");

    const full = exportMarkdown(
      snapshotOf(source, { workLog: true, reasoning: true, throughMessageId: null }),
    ).markdown;
    expect(full).toContain("<summary>Work log · 1 step · Worked for 3.0s</summary>");
    expect(full).toContain("- **Ran command** · completed");
    expect(full).toContain("ls -la");
    expect(full).toContain("file-a\n  file-b");
    expect(full).toContain("<summary>Reasoning</summary>\n\nThinking\\\nhard");
    expect(full).not.toContain("sk-secret");
    expect(full).toContain(
      "- This export includes the work log and reasoning, which can contain file paths, command output, and secrets.",
    );
    expect(plain).not.toContain("This export includes");
    const parsed = parseConversationMarkdown(full);
    if (parsed.kind !== "conversation") throw new Error("Expected a conversation.");
    expect(parsed.messages[1]!.body).toBe("Done");
    expect(parsed.messages[1]!.parts.map((part) => part.kind)).toEqual(["work-log", "reasoning"]);
  });

  it("is content-identical for the same snapshot", () => {
    const source = thread({
      messages: [
        message({ id: "m1", role: "user", text: "hello", attachments: [pdf] }),
        message({ id: "m2", role: "assistant", text: "world", turnId: "t1" }),
      ],
    });
    const first = exportMarkdown(snapshotOf(source));
    const second = exportMarkdown(snapshotOf(source));
    expect(second.markdown).toBe(first.markdown);
    expect(second.document.bundle.metadata.source).toEqual({
      _tag: "conversation",
      threadId: "thread-1",
      contentDigest: DIGEST,
      snapshotSequence: 10,
    });
  });

  it("carries known source omissions into an imported thread's next export", () => {
    const source = {
      ...thread({ messages: [message({ id: "m1", role: "user", text: "partial history" })] }),
      conversationImport: {
        source: "scic" as const,
        exportId: "earlier-export",
        sourceThreadId: "other-installation-thread",
        packageDigest: `sha256:${"a".repeat(64)}`,
        sourceFormat: "scient-conversation",
        sourceFormatVersion: 1,
        importedAt: "2026-09-27T14:00:00.000Z",
        omissions: [{ _tag: "range-truncated" as const, throughMessageN: 1 }],
      },
    };
    const snapshot = snapshotOf(source);
    expect(snapshot.provenance).toMatchObject({
      _tag: "import",
      omissions: [{ _tag: "range-truncated", throughMessageN: 1 }],
    });
    const { markdown, document } = exportMarkdown(snapshot);
    expect(document.bundle.warnings).toContainEqual(
      expect.objectContaining({ code: "source-history-incomplete" }),
    );
    expect(markdown).toContain("earlier transfer stopped at message 1");
  });

  it("says in every readable export when imported times were moved back", () => {
    const conversationImport = {
      source: "scic" as const,
      exportId: "earlier-export",
      sourceThreadId: "other-installation-thread",
      packageDigest: `sha256:${"a".repeat(64)}`,
      sourceFormat: "scient-conversation",
      sourceFormatVersion: 1,
      importedAt: "2026-09-27T14:00:00.000Z",
      omissions: [],
      timesShiftedMs: 86_436_000,
    };
    const note =
      "Times are shown 1 day 36 seconds earlier than in the file, because the file's times were later than the moment it was imported.";
    const messages = [message({ id: "m1", role: "user", text: "moved history" })];
    const imported = snapshotOf({ ...thread({ messages }), conversationImport });
    // The transfer file keeps the field; readable exports say it in words.
    expect(imported.provenance).toMatchObject({ _tag: "import", timesShiftedMs: 86_436_000 });
    const { markdown, document } = exportMarkdown(imported);
    // PDF and Word are made from this bundle; its notes go into their preamble.
    expect(document.bundle.warnings).toContainEqual({ code: "times-shifted", message: note });
    const shown = "Times are shown 1 day 36 seconds earlier than in the file";
    expect(document.bundle.markdown).toContain(shown);
    expect(markdown).toContain("**Export notes**");
    expect(markdown).toContain(shown);

    const forked = exportMarkdown(
      snapshotOf({
        ...thread({ messages }),
        forkLineage: {
          originThreadId: "origin" as never,
          baselineAssistantMessageId: null,
          sourceImport: conversationImport,
        },
      }),
    );
    expect(forked.document.bundle.warnings).toContainEqual({
      code: "times-shifted",
      message: note,
    });

    const { timesShiftedMs: _moved, ...unmovedImport } = conversationImport;
    const unmoved = exportMarkdown(
      snapshotOf({ ...thread({ messages }), conversationImport: unmovedImport }),
    );
    expect(unmoved.markdown).not.toContain("Times are shown");
  });

  it("skips async answer messages chat folds into their question", () => {
    const { markdown } = exportMarkdown(
      snapshotOf(
        thread({
          messages: [
            message({ id: "m1", role: "user", text: "Ask me" }),
            message({ id: "async-answer:req-1", role: "user", text: "Blue" }),
          ],
          activities: [
            activity({
              id: "q1",
              kind: "user-input.requested",
              turnId: "t1",
              payload: {
                requestId: "req-1",
                questions: [{ id: "color", question: "Which color?" }],
              },
            }),
            activity({
              id: "q2",
              kind: "user-input.answer-submitted",
              turnId: "t1",
              payload: {
                requestId: "req-1",
                answers: { color: "Blue" },
                attachmentsByQuestionId: {},
              },
            }),
          ],
        }),
      ),
    );
    expect(bodies(markdown)).toEqual(["Ask me"]);
    expect(markdown).toContain("**Q:** Which color?\\\n**A:** Blue");
  });

  it("labels images that only exist on the original computer and warns about them", () => {
    const { markdown, document } = exportMarkdown(
      snapshotOf(
        thread({
          messages: [
            message({ id: "m1", role: "user", text: "Plot please" }),
            message({
              id: "m2",
              role: "assistant",
              text: "![Plot](./figures/plot.png)\n\n![remote](https://example.org/a.png)\n\n![Ref][fig]\n\n[fig]: /Users/someone/fig.png",
              turnId: "t1",
            }),
          ],
        }),
      ),
    );
    expect(bodies(markdown)[1]).toBe(
      "*\\[Image not included: Plot\\]*\n\n![remote](https://example.org/a.png)\n\n*\\[Image not included: Ref\\]*\n\n[fig]: /Users/someone/fig.png",
    );
    expect(
      document.bundle.warnings.filter((warning) => warning.code === "resource-unresolved"),
    ).toEqual([
      {
        code: "resource-unresolved",
        message:
          "Image “Plot” in message 2 refers to a file on the original computer and is not included.",
      },
      {
        code: "resource-unresolved",
        message:
          "Image “Ref” in message 2 refers to a file on the original computer and is not included.",
      },
    ]);
    expect(markdown).toContain("**Export notes**");
  });

  it("labels raw HTML images that point at the original computer where HTML renders", () => {
    const local = '<p>Result: <img alt="Plot &amp; fit" src="./plot.png"></p>';
    const { markdown, document } = exportMarkdown(
      snapshotOf(
        thread({
          messages: [
            message({ id: "m1", role: "user", text: `As text: <img src="./mine.png">` }),
            message({ id: "r1", role: "reasoning", text: "<img src='figure.png'>", turnId: "t1" }),
            message({
              id: "m2",
              role: "assistant",
              text: `${local}\n\nInline <img src="https://example.org/a.png"> stays.`,
              turnId: "t1",
            }),
          ],
          proposedPlans: [
            {
              id: "p1",
              turnId: TurnId.make("t1"),
              planMarkdown: '<img src="/Users/someone/diagram.svg" alt="Diagram">',
              implementedAt: null,
              implementationThreadId: null,
              createdAt: tick(),
              updatedAt: tick(0),
            },
          ],
        }),
        { workLog: false, reasoning: true, throughMessageId: null },
      ),
    );
    expect(bodies(markdown)).toEqual([
      // User HTML shows as text, as in chat, so nothing is loaded from it.
      'As text: &lt;img src="./mine.png">',
      '<p>Result: <em>[Image not included: Plot &amp; fit]</em></p>\n\nInline <img src="https://example.org/a.png"> stays.',
    ]);
    expect(markdown).toContain("<em>[Image not included: Diagram]</em>");
    expect(markdown).toContain("<em>[Image not included]</em>");
    expect(markdown).not.toContain("./plot.png");
    expect(markdown).not.toContain("diagram.svg");
    expect(
      document.bundle.warnings
        .filter((warning) => warning.code === "resource-unresolved")
        .map((warning) => warning.message),
    ).toEqual([
      "Image “Plot & fit” in message 2 refers to a file on the original computer and is not included.",
      "Image “Diagram” in message 2 refers to a file on the original computer and is not included.",
      "Image “untitled” in message 2 refers to a file on the original computer and is not included.",
    ]);
  });

  it("reads an HTML image's source from its own attribute only", () => {
    const { markdown, document } = exportMarkdown(
      snapshotOf(
        thread({
          messages: [
            message({ id: "m1", role: "user", text: "Images" }),
            message({
              id: "m2",
              role: "assistant",
              text: [
                `<p><img alt='x src="https://e/a.png"' src="./x.png"></p>`,
                `<p><img alt='y src="./y.png"' src="https://e/b.png"></p>`,
                "<p><img src=./u.png alt=U></p>",
                "<p><img src='./s.png' alt='S'></p>",
              ].join("\n\n"),
              turnId: "t1",
            }),
          ],
        }),
      ),
    );
    expect(bodies(markdown)[1]).toBe(
      [
        `<p><em>[Image not included: x src="https://e/a.png"]</em></p>`,
        `<p><img alt='y src="./y.png"' src="https://e/b.png"></p>`,
        "<p><em>[Image not included: U]</em></p>",
        "<p><em>[Image not included: S]</em></p>",
      ].join("\n\n"),
    );
    expect(
      document.bundle.warnings.filter((warning) => warning.code === "resource-unresolved"),
    ).toHaveLength(3);
  });

  it("bounds every quoted value so a warning always fits its contract", () => {
    const alt = "A".repeat(5_000);
    const name = `${"研".repeat(250)}.png`;
    const snapshot = snapshotOf(
      thread({
        messages: [
          message({
            id: "m1",
            role: "user",
            text: "Files",
            attachments: [
              { ...image, name, id: "thread-1-long" },
              { ...pdf, name },
            ],
          }),
          message({ id: "m2", role: "assistant", text: `![${alt}](./x.png)`, turnId: "t1" }),
        ],
      }),
      undefined,
      (attachment) => attachment.id === "thread-1-long",
    );
    const { document } = exportMarkdown(snapshot, {
      resolve: () => ({ _tag: "unavailable", reason: "unreadable" }),
    });
    expect(document.bundle.warnings.map((warning) => warning.code)).toEqual([
      "attachment-unavailable",
      "attachment-unavailable",
      "resource-unresolved",
    ]);
    for (const warning of document.bundle.warnings) {
      expect(warning.message.length).toBeLessThanOrEqual(2_048);
      expect(warning.message).not.toContain("\n");
    }
    expect(() =>
      encodeExportResult({
        exportId: "export-1",
        format: "markdown",
        contentDigest: DIGEST,
        messageCount: 2,
        file: null,
        text: "",
        warnings: document.bundle.warnings,
      }),
    ).not.toThrow();
  });

  it("numbers warnings as the file does and reports an answer's attachment once", () => {
    const answerFile: ChatAttachment = { ...pdf, id: "thread-1-answer", name: "answer.pdf" };
    const laterFile: ChatAttachment = { ...pdf, id: "thread-1-later", name: "later.pdf" };
    const snapshot = snapshotOf(
      thread({
        messages: [
          message({ id: "m1", role: "user", text: "Ask me" }),
          message({ id: "s1", role: "system", text: "Model changed" }),
          message({ id: "m2", role: "assistant", text: "Which file?", turnId: "t1" }),
          message({
            id: "async-answer:req-1",
            role: "user",
            text: "This one",
            attachments: [answerFile],
          }),
          message({ id: "m3", role: "user", text: "And this", attachments: [laterFile] }),
        ],
        activities: [
          activity({
            id: "q1",
            kind: "user-input.requested",
            turnId: "t1",
            payload: { requestId: "req-1", questions: [{ id: "file", question: "Which file?" }] },
          }),
          activity({
            id: "q2",
            kind: "user-input.answer-submitted",
            turnId: "t1",
            payload: {
              requestId: "req-1",
              answers: { file: "This one" },
              attachmentsByQuestionId: { file: [answerFile] },
            },
          }),
        ],
      }),
      undefined,
      () => false,
    );
    expect(
      snapshot.warnings.filter((warning) => warning._tag === "attachment-unavailable"),
    ).toEqual([
      { _tag: "attachment-unavailable", name: "answer.pdf", messageN: 4 },
      { _tag: "attachment-unavailable", name: "later.pdf", messageN: 5 },
      { _tag: "attachment-unavailable", name: "answer.pdf", messageN: null },
    ]);
    const { markdown, document } = exportMarkdown(snapshot);
    expect(bodies(markdown)).toEqual(["Ask me", "Which file?", "And this"]);
    expect(document.bundle.warnings.map((warning) => warning.message)).toEqual([
      "Attachment “later.pdf” in message 3 was unavailable and is listed by name only.",
      "Attachment “answer.pdf” was unavailable and is listed by name only.",
    ]);
  });

  it("says an attachment over the export's budget is too large, not unreadable", () => {
    const { document } = exportMarkdown(
      snapshotOf(
        thread({
          messages: [message({ id: "m1", role: "user", text: "Big", attachments: [pdf] })],
        }),
      ),
      { resolve: () => ({ _tag: "unavailable", reason: "too-large" }) },
    );
    expect(document.bundle.warnings.map((warning) => warning.message)).toEqual([
      "Attachment “notes.pdf” is too large to include and is listed by name only.",
    ]);
  });

  it("never writes hard breaks inside backslash-delimited math", () => {
    const display = "Energy:\n\\[\nE = mc^2\n\\]\nand inline \\(a +\nb\\) done\nnext line";
    const { markdown } = exportMarkdown(
      snapshotOf(
        thread({
          messages: [
            message({ id: "m1", role: "user", text: display }),
            message({ id: "r1", role: "reasoning", text: display, turnId: "t1" }),
            message({
              id: "m2",
              role: "assistant",
              text: `★ Insight ─────\n${display}`,
              turnId: "t1",
            }),
          ],
        }),
        { workLog: false, reasoning: true, throughMessageId: null },
      ),
    );
    // As in chat, display math on its own lines is a separate block, so only
    // prose line breaks become hard breaks; math keeps its own lines.
    const expected = "Energy:\n\\[\nE = mc^2\n\\]\nand inline \\(a +\nb\\) done\\\nnext line";
    const [user, assistant] = bodies(markdown);
    expect(user).toBe(expected);
    expect(assistant).toBe(`★ Insight ─────\\\n${expected}`);
    expect(markdown).toContain(`<summary>Reasoning</summary>\n\n${expected}`);
  });
});
