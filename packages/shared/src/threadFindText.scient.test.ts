import { EnvironmentId, ThreadId, type FileCitation } from "@t3tools/contracts";
import { expect, it } from "vite-plus/test";
import { parseComposerCitationHref, serializeComposerCitation } from "./composerCitations.ts";
import { formatEnvironmentQualifiedThreadLink } from "./threadLinks.ts";
import { searchableMessageSegments } from "./threadFindText.ts";

const assistantSegments = (text: string, cwd?: string) =>
  searchableMessageSegments({ role: "assistant", text, streaming: false }, cwd);
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
