import { EnvironmentId, MessageId, ThreadId, type FileCitation } from "@t3tools/contracts";
import { expect, it } from "vite-plus/test";
import { parseComposerCitationHref, serializeComposerCitation } from "./composerCitations.ts";
import { formatEnvironmentQualifiedThreadLink } from "./threadLinks.ts";
import { serializeAssistantCitation } from "./assistantCitations.ts";
import { searchableMessageSegments } from "./threadFindText.ts";

it("excludes review attachments rendered as context chips", () => {
  const text = [
    "Before **review**",
    '<review_comment sectionId="turn:2" sectionTitle="Turn 2" filePath="hidden.ts" startIndex="3" endIndex="14" rangeLabel="L4">',
    "Keep **this literal** comment.",
    "```diff",
    "+ hidden patch content",
    "```",
    "</review_comment>",
    "After review",
  ].join("\n");
  expect(searchableMessageSegments({ role: "user", text, streaming: false })).toEqual([
    "Before review",
    " After review",
  ]);
});

it("excludes structured context chips without joining text across them", () => {
  expect(
    searchableMessageSegments({
      role: "user",
      streaming: false,
      text: "before[hidden label](t3-context://v1/terminal/terminal_1)after",
      context: { version: 1, records: [] },
    }),
  ).toEqual(["before", "after"]);
});

it("does not upgrade literal legacy tags in messages with structured context", () => {
  const text =
    "<terminal_context>\n- Terminal 1 line 12:\n  12 | visible output\n</terminal_context>";
  expect(
    searchableMessageSegments({
      role: "user",
      streaming: false,
      text,
      context: { version: 1, records: [] },
    })?.join("\n"),
  ).toContain("visible output");
  expect(searchableMessageSegments({ role: "user", streaming: false, text })).toEqual([]);
});

it("excludes repeated legacy attachments containing literal context tags", () => {
  const context =
    "<terminal_context>\n- Terminal 1 line 12:\n  12 | <terminal_context>literal</terminal_context>\n</terminal_context>";
  expect(
    searchableMessageSegments({
      role: "user",
      streaming: false,
      text: `Fix this\n\n${context}\n\n${context}`,
    }),
  ).toEqual(["Fix this"]);
});

const assistantSegments = (text: string, cwd?: string) =>
  searchableMessageSegments({ role: "assistant", text, streaming: false }, cwd);

it("searches displayed prose and file-chip labels without hidden paths", () => {
  expect(
    assistantSegments("[important description](/tmp/actual.ts). `/tmp/inline-example.ts:42`"),
  ).toEqual(["important description actual.ts. inline-example.ts · L42"]);
  expect(assistantSegments("[label](src/main.ts#L3C2)", "/workspace/repo")).toEqual([
    "label main.ts · L3:C2",
  ]);
  expect(assistantSegments("[label](src/main.ts#L3C2)")).toEqual(["label"]);
});

it("keeps fence paths literal and indexes file-chip labels in user messages", () => {
  expect(assistantSegments("```text\n/tmp/file.ts:42\n```")).toEqual(["/tmp/file.ts:42\n"]);
  expect(
    searchableMessageSegments({ role: "user", text: "`/tmp/file.ts:42`", streaming: false }),
  ).toEqual(["file.ts · L42"]);
});

it("indexes nested disclosure summaries and bodies in rendered order", () => {
  expect(
    assistantSegments(
      "<details><summary>Outer</summary><p>first</p><details><summary>Inner</summary><p>second</p></details></details>",
    ),
  ).toEqual(["Outer", "first", "Inner", "second"]);
});

it("indexes the citation chip label instead of its link text", () => {
  const citation = {
    version: 1 as const,
    environmentId: EnvironmentId.make("environment"),
    threadId: ThreadId.make("thread"),
    messageId: MessageId.make("message"),
    text: "cited   needle",
    start: 0,
    end: 14,
    prefix: "",
    suffix: "",
  };
  const text = `Please fix ${serializeAssistantCitation(citation)} thanks`;
  expect(searchableMessageSegments({ role: "user", text, streaming: false })).toEqual([
    "Please fix cited needle thanks",
  ]);
  const commented = serializeAssistantCitation({ ...citation, comment: "my note" });
  expect(searchableMessageSegments({ role: "user", text: commented, streaming: false })).toEqual([
    "my note",
  ]);
});

const fileQuote: FileCitation = {
  kind: "file",
  version: 1,
  environmentId: EnvironmentId.make("remote"),
  threadId: ThreadId.make("thread"),
  cwd: "/remote/hidden",
  path: "private/notes/a (draft)#1%.md",
  revision: `sha256:${"a".repeat(64)}`,
  origin: "draft",
  sourceStart: 0,
  sourceEnd: 100,
  startLine: 1,
  endLine: 8,
  from: 1,
  to: 5,
  text: "quoted   needle",
  prefix: "secret prefix",
  suffix: "secret suffix",
};
it("indexes file quote chip labels without projecting their hidden workspace or source", () => {
  expect(
    searchableMessageSegments({
      role: "user",
      streaming: false,
      text: `Before ${serializeComposerCitation(fileQuote)} after`,
    }),
  ).toEqual(["Before a (draft)#1%.md · quoted needle after"]);
  expect(
    assistantSegments(serializeComposerCitation({ ...fileQuote, comment: "comment   needle" })),
  ).toEqual(["a (draft)#1%.md · comment needle"]);
  expect(
    assistantSegments(serializeComposerCitation({ ...fileQuote, text: "x".repeat(80) })),
  ).toEqual([`a (draft)#1%.md · ${"x".repeat(64)}…`]);
});
it("keeps the authored label of environment-qualified thread links", () => {
  expect(
    assistantSegments(
      formatEnvironmentQualifiedThreadLink("remote", "thread", "Readable conversation"),
    ),
  ).toEqual(["Readable conversation"]);
});

it.each([
  "scient-file-citation://v1/?data=bad",
  "scient-file-citation://v2/?data=%7B%7D",
  "scient-file-citation://v1/?data=%7B%7D&unknown=1",
  "javascript:alert",
  "scient-file-citation-unsafe://v1/?data=%7B%7D",
])("leaves unsupported or malformed quote links as authored labels: %s", (href) => {
  expect(parseComposerCitationHref(href)).toBeNull();
  expect(assistantSegments(`[File quote](${href})`)).toEqual(["File quote"]);
});
