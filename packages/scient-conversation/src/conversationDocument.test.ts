import { describe, expect, it } from "@effect/vitest";
import { beforeEach } from "vite-plus/test";
import type { ChatAttachment } from "@t3tools/contracts";

import { parseConversationMarkdown } from "./conversationMarkdown.ts";
import { parseMarkdown, visitNodes } from "./markdownAst.ts";
import { packagedAssets } from "./markdownExport.ts";
import {
  DIGEST,
  activity,
  exportMarkdown,
  message,
  resetClock,
  snapshotOf,
  thread,
} from "./thread.test-fixtures.ts";

beforeEach(resetClock);

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
});
