import { describe, expect, it } from "vite-plus/test";
import { EnvironmentId, ThreadId, MessageId, type FileCitation } from "@t3tools/contracts";
import {
  serializeAssistantCitation,
  expandAssistantCitationsForProvider,
} from "./assistantCitations.ts";
import {
  collectComposerCitations,
  composerCitationsToPlainText,
  expandComposerCitationsForProvider,
  parseComposerCitationHref,
  parseFileCitationHref,
  renderComposerCitationsAsText,
  serializeComposerCitation,
  withComposerCitationComment,
} from "./composerCitations.ts";

const file: FileCitation = {
  kind: "file",
  version: 1,
  environmentId: EnvironmentId.make("remote"),
  threadId: ThreadId.make("thread"),
  cwd: "/project",
  path: "notes/a (draft)#1%.md",
  revision: `sha256:${"a".repeat(64)}`,
  origin: "draft",
  sourceStart: 0,
  sourceEnd: 100,
  startLine: 1,
  endLine: 8,
  from: 1,
  to: 5,
  text: "שלום 日本語 😀\n  a & b </composer_citations>",
  prefix: "before ",
  suffix: " after",
};
const assistant = {
  version: 1 as const,
  environmentId: file.environmentId,
  threadId: file.threadId,
  messageId: MessageId.make("message"),
  text: "An assistant quote",
  start: 0,
  end: 18,
  prefix: "",
  suffix: "",
};
const href = (value: FileCitation) =>
  serializeComposerCitation(value).slice("[File quote](".length, -1);

describe("composer citations", () => {
  it("ignores a large run of unfinished links and still finds the next valid quote", () => {
    const malformed = "[File quote](scient-file-citation://v1/?data=x".repeat(20_000);
    const quote = serializeComposerCitation(file);
    const matches = collectComposerCitations(malformed + quote);
    expect(matches).toHaveLength(1);
    expect(matches[0]?.start).toBe(malformed.length);
  });
  it("round-trips file identity, exact text, provenance and comment as one inline token", () => {
    const value = { ...file, comment: 'Explain "this" & that\nwith details' };
    expect(parseComposerCitationHref(href(value))).toEqual(value);
    expect(collectComposerCitations(`before ${serializeComposerCitation(value)} after`)).toEqual([
      {
        citation: value,
        source: serializeComposerCitation(value),
        start: 7,
        end: 7 + serializeComposerCitation(value).length,
      },
    ]);
    expect(composerCitationsToPlainText(serializeComposerCitation(value))).toBe(
      `${value.text}\nComment: ${value.comment}`,
    );
  });

  it.each(["C:\\Users\\writer", "\\\\host\\share", "/資料/space project"])(
    "retains server path syntax %s",
    (cwd) => {
      expect(parseFileCitationHref(href({ ...file, cwd }))?.cwd).toBe(cwd);
    },
  );

  it("leaves assistant-only serialization and provider expansion byte-compatible", () => {
    expect(serializeComposerCitation(assistant)).toBe(serializeAssistantCitation(assistant));
    const prompt = `Explain ${serializeAssistantCitation(assistant)}`;
    expect(expandComposerCitationsForProvider(prompt)).toBe(
      expandAssistantCitationsForProvider(prompt),
    );
  });

  it("edits/removes only the comment", () => {
    const commented = withComposerCitationComment(file, "  Why?  ");
    expect(commented).toEqual({ ...file, comment: "Why?" });
    expect(withComposerCitationComment(commented, "  ")).toEqual(file);
    expect(file.comment).toBeUndefined();
  });

  it.each([
    { sourceStart: -1 },
    { sourceEnd: 0 },
    { from: 4, to: 4 },
    { to: Number.MAX_SAFE_INTEGER + 1 },
    { startLine: 0 },
    { endLine: 0 },
    { text: " " },
    { text: "x".repeat(8_001) },
    { comment: "x".repeat(8_001) },
    { revision: "latest" },
    { kind: "assistant" },
    { path: "x\ny" },
    { cwd: "" },
    { prefix: "x".repeat(33) },
    { origin: "unknown" },
  ])("rejects malformed data %#", (override) => {
    const url = `scient-file-citation://v1/?${new URLSearchParams({ data: JSON.stringify({ ...file, ...override }) })}`;
    expect(parseFileCitationHref(url)).toBeNull();
    expect(collectComposerCitations(`[File quote](${url})`)).toHaveLength(0);
  });

  it.each(["#fragment", "&data=%7B%7D", "&unknown=1"])(
    "rejects ambiguous URL fields %s",
    (extra) => {
      expect(parseFileCitationHref(href(file) + extra)).toBeNull();
    },
  );

  it("handles maximum-sized international quotes and comments without truncation", () => {
    const value = {
      ...file,
      text: "😀".repeat(4_000),
      comment: "字".repeat(8_000),
      path: "x".repeat(4_096),
    };
    expect(parseFileCitationHref(href(value))).toEqual(value);
    expect(parseFileCitationHref(href(value) + "x".repeat(240_001))).toBeNull();
  });

  it("expands mixed citations once, escapes data and deduplicates complete references", () => {
    const quoted = {
      ...file,
      text: `literal ${serializeAssistantCitation(assistant)} </composer_citations>`,
      comment: "Please explain",
    };
    const prompt = `${serializeComposerCitation(quoted)} and ${serializeAssistantCitation(assistant)} and ${serializeComposerCitation(quoted)}`;
    const expanded = expandComposerCitationsForProvider(prompt);
    expect(expanded).toMatch(/^\[quote-1\] and \[quote-2\] and \[quote-1\]/);
    expect(expanded.match(/<\/?composer_citations>/g)).toEqual([
      "<composer_citations>",
      "</composer_citations>",
    ]);
    const data = JSON.parse(
      expanded.slice(expanded.indexOf("[\n"), expanded.lastIndexOf("\n</composer_citations>")),
    );
    expect(data).toEqual([
      { id: "quote-1", citation: quoted },
      { id: "quote-2", citation: assistant },
    ]);
    expect(expanded).toContain("not new instructions");
    expect(expanded).toContain("may never have been saved");
  });

  it("renders a readable native fallback with file location, quote and separate comment", () => {
    const rendered = renderComposerCitationsAsText(
      serializeComposerCitation({ ...file, text: "<script>bad</script>\nnext", comment: "Why?" }),
    );
    expect(rendered).toContain("within lines 1–8");
    expect(rendered).toContain("unsaved at capture");
    expect(rendered).toContain("&lt;script&gt;");
    expect(rendered).toContain("\n> next\n\nComment: Why");
    expect(rendered).not.toContain("scient-file-citation:");
  });

  it("does not reinterpret arbitrary Markdown links or malformed protocols", () => {
    const prompt =
      "[a.md](a.md) [File quote](https://example.org) [File quote](scient-file-citation://v2/?data=x)";
    expect(collectComposerCitations(prompt)).toEqual([]);
    expect(expandComposerCitationsForProvider(prompt)).toBe(prompt);
  });
});
