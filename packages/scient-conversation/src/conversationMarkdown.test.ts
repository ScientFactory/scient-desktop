import { TurnId } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import { beforeEach } from "vite-plus/test";

import { parseConversationMarkdown, type ParsedMarkdownMessage } from "./conversationMarkdown.ts";
import {
  EXPORT_VALUE,
  exportMarkdown,
  message,
  resetClock,
  snapshotOf,
  thread,
  tick,
} from "./thread.test-fixtures.ts";

beforeEach(resetClock);

function roundTrip(messages: Parameters<typeof thread>[0]["messages"]) {
  const { markdown } = exportMarkdown(snapshotOf(thread({ messages })));
  const parsed = parseConversationMarkdown(markdown);
  if (parsed.kind !== "conversation") throw new Error("Expected a conversation.");
  return { markdown, parsed };
}

function summary(messages: ReadonlyArray<ParsedMarkdownMessage>) {
  return messages.map((parsed) => ({ n: parsed.n, role: parsed.role, turn: parsed.turn }));
}

/** A transcript of user messages whose markers carry `numbers`, one per message, in file order. */
function numberedTranscript(numbers: ReadonlyArray<number>) {
  return [
    "---",
    "scient: conversation",
    "scient-format: 1",
    `scient-export: ${EXPORT_VALUE}`,
    "title: Renumbered",
    "---",
    ...numbers.flatMap((n, index) => [
      `<!-- scient:message export=${EXPORT_VALUE} n=${n} role=user time=2026-09-27T14:00:00.000Z -->`,
      `body ${index + 1}`,
      "",
    ]),
  ].join("\n");
}

const OTHER_EXPORT_MARKER =
  "<!-- scient:message export=0123456789ab n=1 role=assistant time=2026-01-01T00:00:00.000Z -->";

describe("Scient conversation Markdown v1", () => {
  it("recovers a long transcript without losing message boundaries", () => {
    const count = 2_000;
    const markdown = [
      "---",
      "scient: conversation",
      "scient-format: 1",
      `scient-export: ${EXPORT_VALUE}`,
      "title: Long transcript",
      "---",
      ...Array.from({ length: count }, (_, index) => [
        `<!-- scient:message export=${EXPORT_VALUE} n=${index + 1} role=user time=2026-09-27T14:00:00.000Z -->`,
        `message ${index + 1}`,
        "",
      ]).flat(),
    ].join("\n");
    const parsed = parseConversationMarkdown(markdown);
    if (parsed.kind !== "conversation") throw new Error("Expected a conversation.");
    expect(parsed.messages).toHaveLength(count);
    expect(parsed.messages.at(-1)?.body).toBe(`message ${count}`);
    expect(parsed.issues).toEqual([]);
  });

  it("writes front matter, markers, and speaker headings", () => {
    const { markdown, parsed } = roundTrip([
      message({ id: "m1", role: "user", text: "Please investigate" }),
      message({ id: "m2", role: "assistant", text: "Here is what I found", turnId: "t1" }),
    ]);
    expect(markdown.startsWith("---\nscient: conversation\nscient-format: 1\n")).toBe(true);
    expect(markdown).toContain(`scient-export: ${EXPORT_VALUE}`);
    expect(markdown).toContain("title: Export design");
    expect(markdown).toContain("exported: 2026-09-28T09:12:00.000Z");
    expect(markdown).toContain(
      `<!-- scient:message export=${EXPORT_VALUE} n=1 role=user time=2026-09-27T14:00:01.000Z -->\n## You · 27 Sep 2026, 14:00 UTC`,
    );
    expect(markdown).toContain(`n=2 role=assistant time=2026-09-27T14:00:02.000Z turn=1 -->`);
    expect(parsed.title).toBe("Export design");
    expect(parsed.issues).toEqual([]);
    expect(parsed.messages.map((entry) => entry.body)).toEqual([
      "Please investigate",
      "Here is what I found",
    ]);
  });

  it("formats speaker times in the requested zone", () => {
    const { markdown } = exportMarkdown(
      snapshotOf(thread({ messages: [message({ id: "m1", role: "user", text: "hi" })] })),
      { timeZone: "Asia/Jerusalem" },
    );
    expect(markdown).toContain("## You · 27 Sep 2026, 17:00 GMT+3");
    const fallback = exportMarkdown(
      snapshotOf(thread({ messages: [message({ id: "m1", role: "user", text: "hi" })] })),
      { timeZone: "Not/AZone" },
    );
    expect(fallback.markdown).toContain("UTC");
  });

  it("keeps literal markers in bodies from creating boundaries", () => {
    const literal = `<!-- scient:message export=${EXPORT_VALUE} n=3 role=user time=2026-09-27T14:00:00.000Z -->`;
    const { markdown, parsed } = roundTrip([
      message({ id: "m1", role: "user", text: `${literal}\n\nInline ${literal} too` }),
      message({ id: "m2", role: "assistant", text: literal, turnId: "t1" }),
    ]);
    expect(markdown).toContain("&lt;!-- scient:message");
    expect(summary(parsed.messages)).toEqual([
      { n: 1, role: "user", turn: null },
      { n: 2, role: "assistant", turn: 1 },
    ]);
    expect(parsed.issues).toEqual([]);
  });

  it("treats quoted markers from another export as content", () => {
    const { parsed } = roundTrip([
      message({ id: "m1", role: "user", text: `> ${OTHER_EXPORT_MARKER}\n> quoted export` }),
      message({
        id: "m2",
        role: "assistant",
        text: `${OTHER_EXPORT_MARKER}\n\nreply`,
        turnId: "t1",
      }),
    ]);
    expect(summary(parsed.messages)).toEqual([
      { n: 1, role: "user", turn: null },
      { n: 2, role: "assistant", turn: 1 },
    ]);
    expect(parsed.messages[0]!.body).toContain("quoted export");
  });

  it("ignores markers inside fenced and indented code", () => {
    const fenced = `\`\`\`markdown\n${OTHER_EXPORT_MARKER}\n<!-- scient:message export=${EXPORT_VALUE} n=2 role=user time=2026-09-27T14:00:00.000Z -->\n\`\`\``;
    const { parsed } = roundTrip([
      message({ id: "m1", role: "user", text: fenced }),
      message({
        id: "m2",
        role: "assistant",
        text: `    <!-- scient:message export=${EXPORT_VALUE} n=9 role=user time=2026-09-27T14:00:00.000Z -->`,
        turnId: "t1",
      }),
    ]);
    expect(summary(parsed.messages)).toEqual([
      { n: 1, role: "user", turn: null },
      { n: 2, role: "assistant", turn: 1 },
    ]);
    // Code keeps its literal text; only markers outside code are escaped.
    expect(parsed.messages[0]!.body).toContain(`<!-- scient:message export=${EXPORT_VALUE} n=2`);
  });

  it("removes generated speaker headings and keeps authored ones", () => {
    const { parsed } = roundTrip([
      message({
        id: "m1",
        role: "user",
        text: "## You · 27 Sep 2026, 14:05 UTC\n\nI wrote that heading myself.",
      }),
      message({
        id: "m2",
        role: "assistant",
        text: "## Assistant · 1 Jan 2026, 00:00 UTC\n\n# Findings\n\nDetails",
        turnId: "t1",
      }),
    ]);
    expect(parsed.messages[0]!.body).toBe(
      "## You · 27 Sep 2026, 14:05 UTC\n\nI wrote that heading myself.",
    );
    expect(parsed.messages[1]!.body).toBe(
      "## Assistant · 1 Jan 2026, 00:00 UTC\n\n# Findings\n\nDetails",
    );
  });

  it("namespaces duplicate reference and footnote labels per message", () => {
    const body = (text: string) =>
      `See [the source][src], [src][], [src] and a note[^1].\n\n[src]: https://example.org/${text}\n\n[^1]: ${text} note`;
    const { markdown, parsed } = roundTrip([
      message({ id: "m1", role: "user", text: body("one") }),
      message({ id: "m2", role: "assistant", text: body("two"), turnId: "t1" }),
    ]);
    expect(markdown).toContain("[m1-src]: https://example.org/one");
    expect(markdown).toContain("[m2-src]: https://example.org/two");
    expect(markdown).toContain("[^m1-1]: one note");
    expect(markdown).toContain("[^m2-1]: two note");
    expect(markdown).toContain("[the source][m2-src], [src][m2-src], [src][m2-src]");
    expect(parsed.messages[0]!.body).toBe(
      "See [the source][src], [src], [src] and a note[^1].\n\n[src]: https://example.org/one\n\n[^1]: one note",
    );
  });

  it("namespaces explicit anchors and the links that target them", () => {
    const { markdown, parsed } = roundTrip([
      message({ id: "m1", role: "user", text: "hi" }),
      message({
        id: "m2",
        role: "assistant",
        text: '<a id="results"></a>\n\n## Results {#summary}\n\nJump to [results](#results) or [summary](#summary).',
        turnId: "t1",
      }),
    ]);
    expect(markdown).toContain('<a id="m2-results"></a>');
    expect(markdown).toContain("{#m2-summary}");
    expect(markdown).toContain("[results](#m2-results)");
    expect(parsed.messages[1]!.body).toContain('<a id="results"></a>');
    expect(parsed.messages[1]!.body).toContain("[summary](#summary)");
  });

  it("contains a body that ends inside an unclosed fence or HTML block", () => {
    const { parsed } = roundTrip([
      message({ id: "m1", role: "user", text: "```ts\nconst unfinished = true;" }),
      message({ id: "m2", role: "assistant", text: "Start\n\n<!-- never closed", turnId: "t1" }),
      message({ id: "m3", role: "user", text: "<script>\nlet x = 1;" }),
      message({ id: "m4", role: "assistant", text: "<pre>\nopen", turnId: "t2" }),
      message({ id: "m5", role: "user", text: "$$\nx^2" }),
      message({ id: "m6", role: "assistant", text: "~~~~\n```\nnested", turnId: "t3" }),
      message({ id: "m7", role: "user", text: "last" }),
    ]);
    expect(parsed.messages.map((entry) => entry.n)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(parsed.issues).toEqual([]);
    expect(parsed.messages[0]!.body).toBe("```ts\nconst unfinished = true;\n```");
    expect(parsed.messages[3]!.body).toBe("<pre>\nopen\n</pre>");
    expect(parsed.messages[6]!.body).toBe("last");
  });

  it("keeps turn grouping and order through the round trip", () => {
    const { parsed } = roundTrip([
      message({ id: "m1", role: "user", text: "first" }),
      message({ id: "m2", role: "assistant", text: "a", turnId: "turn-a" }),
      message({ id: "m3", role: "assistant", text: "b", turnId: "turn-a" }),
      message({ id: "m4", role: "user", text: "steer" }),
      message({ id: "m5", role: "assistant", text: "c", turnId: "turn-b" }),
      message({ id: "m6", role: "assistant", text: "restarted", turnId: "turn-c" }),
    ]);
    expect(summary(parsed.messages)).toEqual([
      { n: 1, role: "user", turn: null },
      { n: 2, role: "assistant", turn: 1 },
      { n: 3, role: "assistant", turn: 1 },
      { n: 4, role: "user", turn: null },
      { n: 5, role: "assistant", turn: 2 },
      { n: 6, role: "assistant", turn: 3 },
    ]);
    expect(parsed.messages.map((entry) => entry.body)).toEqual([
      "first",
      "a",
      "b",
      "steer",
      "c",
      "restarted",
    ]);
  });

  it("round-trips a conversation that discusses this format", () => {
    const design = [
      "The writer follows a versioned format:",
      "",
      "```markdown",
      "---",
      "scient: conversation",
      "scient-format: 1",
      "scient-export: 7f3c9a2e41b8",
      "---",
      "",
      "<!-- scient:message export=7f3c9a2e41b8 n=1 role=user time=2026-09-27T14:05:00Z -->",
      "## You · 27 Sep 2026, 14:05",
      "```",
      "",
      "Markers such as <!-- scient:message export=7f3c9a2e41b8 n=2 role=assistant time=2026-09-27T14:06:10Z --> carry structure only.",
      "",
      "<!-- scient:message export=7f3c9a2e41b8 n=2 role=assistant time=2026-09-27T14:06:10Z -->",
      "## Assistant · 27 Sep 2026, 14:06",
      "",
      "---",
      "scient-export: 7f3c9a2e41b8",
    ].join("\n");
    const { parsed } = roundTrip([
      message({ id: "m1", role: "user", text: design }),
      message({ id: "m2", role: "assistant", text: design, turnId: "t1" }),
      message({ id: "m3", role: "user", text: "thanks" }),
    ]);
    expect(summary(parsed.messages)).toEqual([
      { n: 1, role: "user", turn: null },
      { n: 2, role: "assistant", turn: 1 },
      { n: 3, role: "user", turn: null },
    ]);
    expect(parsed.issues).toEqual([]);
    expect(parsed.messages[2]!.body).toBe("thanks");
  });

  it("reports malformed and edited markers without inventing boundaries", () => {
    const { markdown } = roundTrip([
      message({ id: "m1", role: "user", text: "one" }),
      message({ id: "m2", role: "assistant", text: "two", turnId: "t1" }),
      message({ id: "m3", role: "user", text: "three" }),
    ]);
    const edited = markdown
      .replace(" n=2 role=assistant", " n=2 role=robot")
      .replace(" n=3 role=user", " n=5 role=user")
      .concat(`\n${OTHER_EXPORT_MARKER}\n\n<!-- scient:message broken -->\n`);
    const parsed = parseConversationMarkdown(edited);
    if (parsed.kind !== "conversation") throw new Error("Expected a conversation.");
    expect(parsed.messages.map((entry) => entry.n)).toEqual([1, 5]);
    expect(parsed.issues.map((issue) => issue.kind)).toEqual([
      "foreign-marker",
      "malformed-marker",
      "unknown-role",
      "missing-number",
    ]);
    // Which issues left content out, and which kept it or found none to keep.
    expect(parsed.issues.map((issue) => [issue.kind, issue.excluded])).toEqual([
      ["foreign-marker", true],
      ["malformed-marker", true],
      ["unknown-role", true],
      ["missing-number", false],
    ]);
  });

  describe("message numbers", () => {
    const parse = (numbers: ReadonlyArray<number>) => {
      const parsed = parseConversationMarkdown(numberedTranscript(numbers));
      if (parsed.kind !== "conversation") throw new Error("Expected a conversation.");
      return {
        bodies: parsed.messages.map((entry) => entry.body),
        issues: parsed.issues.map((issue) => [
          issue.kind,
          issue.excluded,
          issue.line,
          issue.detail,
        ]),
      };
    };
    // Front matter takes lines 1-6; message k's marker is on line 7 + 3 * (k - 1).
    const markerLine = (k: number) => 7 + 3 * (k - 1);

    it("reports a number lower than the one before it, even after a gap", () => {
      expect(parse([1, 4, 3])).toEqual({
        bodies: ["body 1", "body 2"],
        issues: [
          ["missing-number", false, markerLine(2), "Messages 2–3 are missing."],
          ["out-of-order-number", true, markerLine(3), "Message 3 comes after message 4."],
        ],
      });
    });

    it("reports a repeated number as a duplicate", () => {
      expect(parse([1, 2, 2])).toEqual({
        bodies: ["body 1", "body 2"],
        issues: [["duplicate-number", true, markerLine(3), "Message 2 appears twice."]],
      });
    });

    it("continues from the last number in order after an out-of-order one", () => {
      expect(parse([1, 3, 2, 4])).toEqual({
        bodies: ["body 1", "body 2", "body 4"],
        issues: [
          ["missing-number", false, markerLine(2), "Message 2 is missing."],
          ["out-of-order-number", true, markerLine(3), "Message 2 comes after message 3."],
        ],
      });
    });

    /** Parses a transcript whose message `damaged` (1-based) has an unknown role. */
    const parseWithBadRole = (numbers: ReadonlyArray<number>, damaged: number) => {
      const lines = numberedTranscript(numbers).split("\n");
      const line = markerLine(damaged) - 1;
      lines[line] = lines[line]!.replace("role=user", "role=robot");
      const parsed = parseConversationMarkdown(lines.join("\n"));
      if (parsed.kind !== "conversation") throw new Error("Expected a conversation.");
      return {
        bodies: parsed.messages.map((entry) => entry.body),
        issues: parsed.issues.map((issue) => [issue.kind, issue.excluded, issue.line]),
      };
    };

    it("orders numbers only by messages it accepted, not by a rejected one", () => {
      expect(parseWithBadRole([1, 100, 3], 2)).toEqual({
        bodies: ["body 1", "body 3"],
        issues: [
          ["missing-number", false, markerLine(2)],
          ["unknown-role", true, markerLine(2)],
        ],
      });
      expect(parseWithBadRole([1, 3, 2], 2)).toEqual({
        bodies: ["body 1", "body 3"],
        issues: [
          ["missing-number", false, markerLine(2)],
          ["unknown-role", true, markerLine(2)],
        ],
      });
    });

    it("never reports a number missing where a damaged marker stood", () => {
      const parsed = parseConversationMarkdown(
        numberedTranscript([1, 2, 3]).replace(" n=2 role=user", " n=2 role=user turn=x"),
      );
      if (parsed.kind !== "conversation") throw new Error("Expected a conversation.");
      expect(parsed.messages.map((entry) => entry.body)).toEqual(["body 1", "body 3"]);
      expect(parsed.issues.map((issue) => issue.kind)).toEqual(["malformed-marker"]);
      // A message left out for its role holds its number too.
      expect(parseWithBadRole([1, 2, 3], 2)).toEqual({
        bodies: ["body 1", "body 3"],
        issues: [["unknown-role", true, markerLine(2)]],
      });
    });

    it("keeps every message across a clean gap and only notes it", () => {
      expect(parse([1, 3])).toEqual({
        bodies: ["body 1", "body 2"],
        issues: [["missing-number", false, markerLine(2), "Message 2 is missing."]],
      });
    });
  });

  it("marks a foreign part marker it keeps as text as excluding nothing", () => {
    const { markdown } = roundTrip([
      message({ id: "m1", role: "user", text: "one" }),
      message({ id: "m2", role: "assistant", text: "two", turnId: "t1" }),
    ]);
    const edited = markdown.replace(
      "\none\n",
      "\none\n\n<!-- scient:part export=0123456789ab kind=context -->\n\nstill one\n",
    );
    const parsed = parseConversationMarkdown(edited);
    if (parsed.kind !== "conversation") throw new Error("Expected a conversation.");
    expect(parsed.messages[0]?.body).toContain("still one");
    expect(parsed.issues.map((issue) => [issue.kind, issue.excluded])).toEqual([
      ["foreign-marker", false],
    ]);
  });

  it("cuts a clean message at a damaged marker and rejects a reopened turn", () => {
    const { markdown, parsed } = roundTrip([
      message({ id: "m1", role: "user", text: "one" }),
      message({ id: "m2", role: "assistant", text: "two", turnId: "t1" }),
      message({ id: "m3", role: "assistant", text: "three", turnId: "t2" }),
      message({ id: "m4", role: "assistant", text: "four", turnId: "t1" }),
    ]);
    const damaged = markdown.replace(
      `<!-- scient:message export=${EXPORT_VALUE} n=2 role=assistant`,
      "<!-- scient:message broken",
    );
    const cut = parseConversationMarkdown(damaged);
    if (cut.kind !== "conversation") throw new Error("Expected a conversation.");
    expect(cut.messages[0]?.body).toBe("one");
    expect(cut.messages.some((entry) => entry.body.includes("two"))).toBe(false);
    expect(cut.issues.map((issue) => issue.kind)).toContain("malformed-marker");

    // A turn that returns after another one continues as a new turn in the
    // file; an edited file that reopens a turn is refused.
    expect(summary(parsed.messages)).toEqual([
      { n: 1, role: "user", turn: null },
      { n: 2, role: "assistant", turn: 1 },
      { n: 3, role: "assistant", turn: 2 },
      { n: 4, role: "assistant", turn: 3 },
    ]);
    expect(parsed.issues).toEqual([]);
    const reopened = parseConversationMarkdown(
      markdown.replace(/( n=4 role=assistant time=\S+) turn=3/u, "$1 turn=1"),
    );
    if (reopened.kind !== "conversation") throw new Error("Expected a conversation.");
    expect(reopened.issues.map((issue) => issue.kind)).toContain("out-of-order-turn");
  });

  it("does not assign an assistant response to the preceding user when its export token is edited", () => {
    const { markdown } = roundTrip([
      message({ id: "m1", role: "user", text: "my request" }),
      message({ id: "m2", role: "assistant", text: "assistant-only answer", turnId: "t1" }),
      message({ id: "m3", role: "user", text: "follow-up" }),
    ]);
    const edited = markdown.replace(
      `<!-- scient:message export=${EXPORT_VALUE} n=2 role=assistant`,
      "<!-- scient:message export=0123456789ab n=2 role=assistant",
    );
    const parsed = parseConversationMarkdown(edited);
    if (parsed.kind !== "conversation") throw new Error("Expected a conversation.");
    expect(parsed.messages.map((entry) => entry.n)).toEqual([1, 3]);
    expect(parsed.messages[0]?.body).toBe("my request");
    expect(parsed.messages[1]?.body).toBe("follow-up");
    expect(parsed.issues.map((issue) => issue.kind)).toContain("foreign-marker");
  });

  it("never reads a document without Scient front matter as a transcript", () => {
    expect(
      parseConversationMarkdown(
        `# Notes\n\n${OTHER_EXPORT_MARKER}\n## You · 27 Sep 2026, 14:05\n\nNot a transcript.`,
      ),
    ).toEqual({ kind: "document" });
    expect(
      parseConversationMarkdown(
        "---\nscient: conversation\nscient-format: 2\nscient-export: 7f3c9a2e41b8\n---\n",
      ),
    ).toEqual({ kind: "document" });
  });

  it("separates generated parts from the message body", () => {
    const messages = [
      message({ id: "m1", role: "user", text: "Plan it" }),
      message({ id: "m2", role: "assistant", text: "Done", turnId: "t1" }),
    ];
    const answerTime = tick();
    const { parsed } = (() => {
      const source = thread({
        messages,
        proposedPlans: [
          {
            id: "plan-1",
            turnId: TurnId.make("t1"),
            planMarkdown: "1. Step",
            implementedAt: null,
            implementationThreadId: null,
            createdAt: answerTime,
            updatedAt: answerTime,
          },
        ],
      });
      const { markdown } = exportMarkdown(snapshotOf(source));
      const result = parseConversationMarkdown(markdown);
      if (result.kind !== "conversation") throw new Error("Expected a conversation.");
      return { parsed: result };
    })();
    expect(parsed.messages[1]!.body).toBe("Done");
    expect(parsed.messages[1]!.parts.map((part) => part.kind)).toEqual(["plan"]);
    expect(parsed.messages[1]!.parts[0]!.markdown).toContain("1. Step");
  });
});
