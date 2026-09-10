import { describe, expect, it, vi } from "vite-plus/test";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import {
  serializeComposerCitation,
  collectComposerCitations,
} from "@t3tools/shared/composerCitations";
import { ScientProseMirrorSession } from "./prosemirror/session";
import {
  createMarkdownCitation,
  resolveMarkdownCitation,
  markdownCitationRevision,
} from "./markdownCitation";

const source = {
  environmentId: EnvironmentId.make("remote"),
  threadId: ThreadId.make("thread"),
  cwd: "/project",
  path: "notes.md",
};
function session(text: string) {
  return new ScientProseMirrorSession({ source: text, revision: "sha256:fixture", mode: "write" });
}
function positions(s: ScientProseMirrorSession, text: string) {
  const result: number[] = [];
  s.state.doc.descendants((node, pos) => {
    if (node.isText)
      for (
        let offset = node.text!.indexOf(text);
        offset >= 0;
        offset = node.text!.indexOf(text, offset + 1)
      )
        result.push(pos + offset);
  });
  return result;
}
function cite(s: ScientProseMirrorSession, text: string, index = 0) {
  const from = positions(s, text)[index]!;
  const quote = createMarkdownCitation(s, source, from, from + text.length);
  expect(quote).not.toBeNull();
  return quote!;
}

describe("Markdown citation source mapping", () => {
  it("does not guess among thousands of repeated quotes after the source changes", () => {
    const original = session("Repeated sentence.\n\n".repeat(5_000));
    const quote = cite(original, "Repeated sentence.", 2_500);
    const changed = session("# New heading\n\n" + original.session.draftSource);
    expect(resolveMarkdownCitation(changed, quote)).toBeNull();
  });
  it("captures rendered text and containing source lines without mutation", () => {
    const text = "\uFEFF# Title\r\n\r\nA **bold** phrase &amp; reference.\r\n\r\nLast.\r\n";
    const onUserSourceChange = vi.fn();
    const s = new ScientProseMirrorSession({ source: text, revision: "saved", onUserSourceChange });
    const state = s.state;
    const from = positions(s, "bold")[0]!;
    const to = positions(s, "reference.")[0]! + "reference.".length;
    const quote = createMarkdownCitation(s, source, from, to)!;
    expect(quote.text).toBe("bold phrase & reference.");
    expect(quote.startLine).toBe(3);
    expect(text.slice(quote.sourceStart, quote.sourceEnd)).toContain("**bold**");
    expect(quote.origin).toBe("saved");
    expect(s.state).toBe(state);
    expect(s.session.draftSource).toBe(text);
    expect(s.createSaveIntent()).toBeNull();
    expect(onUserSourceChange).not.toHaveBeenCalled();
    expect(resolveMarkdownCitation(s, quote)).toEqual({ from, to });
  });

  it.each(["plain", "שלום עברית", "English עברית mixed", "日本語", "e\u0301", "🚀😀", "<br>"])(
    "round-trips selected text %s",
    (text) => {
      const s = session(`Before ${text === "<br>" ? "&lt;br&gt;" : text} after.\n`);
      const quote = cite(s, text);
      expect(collectComposerCitations(serializeComposerCitation(quote))[0]?.citation).toEqual(
        quote,
      );
      expect(resolveMarkdownCitation(s, quote)).toEqual({ from: quote.from, to: quote.to });
    },
  );

  it("captures text inside a table and across cells without Markdown pipes", () => {
    const s = session("| A | B |\n|---|---|\n| Alpha | Beta |\n");
    const a = positions(s, "Alpha")[0]!;
    const b = positions(s, "Beta")[0]!;
    const quote = createMarkdownCitation(s, source, a, b + 4)!;
    expect(quote.text).toBe("Alpha\nBeta");
    expect(quote.startLine).toBe(1);
    expect(quote.endLine).toBe(3);
  });

  it("retains code indentation and line breaks rather than selecting the whole fence", () => {
    const s = session("```python\nstart\n  one = 1\n  two = 2\nend\n```\n");
    const quote = cite(s, "  one = 1\n  two = 2");
    expect(quote.text).toBe("  one = 1\n  two = 2");
    expect(quote.startLine).toBe(1);
    expect(quote.endLine).toBe(6);
  });

  it("uses current draft block ranges after structural edits, without saving", () => {
    const s = session("Original.\n\nLast.\n");
    s.replaceUserSource("# Newly inserted heading\n\nOriginal expanded.\n\nLast.\n");
    const quote = cite(s, "Last.");
    expect(quote.startLine).toBe(5);
    expect(quote.origin).toBe("draft");
    expect(quote.revision).toBe(markdownCitationRevision(s));
    expect(s.session.baselineSource).toBe("Original.\n\nLast.\n");
    expect(s.createSaveIntent()).not.toBeNull();
  });

  it("trusts exact positions for repeated quotes only on the same revision", () => {
    const s = session("Same.\n\nSame.\n\nSame.\n");
    const quote = { ...cite(s, "Same.", 1), prefix: "", suffix: "" };
    expect(resolveMarkdownCitation(s, quote)).toEqual({ from: quote.from, to: quote.to });
    const changed = session("New.\n\nSame.\n\nSame.\n\nSame.\n");
    expect(resolveMarkdownCitation(changed, quote)).toBeNull();
  });

  it("reanchors a unique moved quote, but never guesses a missing selection", () => {
    const quote = cite(session("Original sentence.\n"), "Original sentence.");
    const changed = session("# New introduction\n\nOriginal sentence.\n");
    const from = positions(changed, quote.text)[0]!;
    expect(resolveMarkdownCitation(changed, quote)).toEqual({ from, to: from + quote.text.length });
    expect(resolveMarkdownCitation(session("Replacement sentence."), quote)).toBeNull();
  });

  it("rejects blank/oversized selections, invalid bounds and split surrogate pairs", () => {
    const s = session(`Before 😀 ${"x".repeat(8_001)} after`);
    expect(createMarkdownCitation(s, source, 0, 0)).toBeNull();
    expect(createMarkdownCitation(s, source, -1, 1)).toBeNull();
    expect(createMarkdownCitation(s, source, 1, s.state.doc.content.size + 1)).toBeNull();
    const emoji = positions(s, "😀")[0]!;
    expect(createMarkdownCitation(s, source, emoji, emoji + 1)).toBeNull();
    const x = positions(s, "xxx")[0]!;
    expect(createMarkdownCitation(s, source, x, x + 8_001)).toBeNull();
  });

  it("does not cite interactive or non-text atoms as if their display were plain text", () => {
    const s = session("Before ![chart](plot.png) after.");
    expect(createMarkdownCitation(s, source, 1, s.state.doc.content.size - 1)).toBeNull();
  });

  it("stress-tests 250 captures after repeated edits without changing the source or history", () => {
    const s = session("# Test\n\nInitial.\n");
    for (let i = 0; i < 250; i++) {
      s.replaceUserSource(`# Test ${i}\n\nUnique ${i} עברית 🚀.\n\nEnd.\n`);
      const snapshot = s.session;
      const state = s.state;
      const quote = cite(s, `Unique ${i} עברית 🚀.`);
      expect(resolveMarkdownCitation(s, quote)).toEqual({ from: quote.from, to: quote.to });
      expect(s.state).toBe(state);
      expect(s.session).toBe(snapshot);
    }
  });
});
