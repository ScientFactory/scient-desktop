import { describe, expect, it } from "vite-plus/test";

import { normalizeScientMathDelimiters } from "./scientMathText";

describe("normalizeScientMathDelimiters", () => {
  it("rewrites inline pairs to double dollars, preserving length exactly", () => {
    const input = "Euler: \\(e^{i\\pi} = -1\\) holds.";
    const output = normalizeScientMathDelimiters(input);

    expect(output).toBe("Euler: $$e^{i\\pi} = -1$$ holds.");
    expect(output).toHaveLength(input.length);
  });

  it("rewrites display pairs in place, keeping every line untouched", () => {
    const input = "\\[\nE = mc^2\n\\]";

    expect(normalizeScientMathDelimiters(input)).toBe("$$\nE = mc^2\n$$");
  });

  it("rewrites a single-line display pair", () => {
    expect(normalizeScientMathDelimiters("\\[x + y\\]")).toBe("$$x + y$$");
  });

  it("keeps interior padding, which remark-math strips like a code span", () => {
    expect(normalizeScientMathDelimiters("a \\( x \\) b")).toBe("a $$ x $$ b");
  });

  it("keeps list indentation intact for nested display math", () => {
    const input = "- item\n\n  \\[\n  x^2\n  \\]";

    expect(normalizeScientMathDelimiters(input)).toBe("- item\n\n  $$\n  x^2\n  $$");
  });

  it("returns the same reference when no backslash delimiter is present", () => {
    const input = "plain $x$ text";

    expect(normalizeScientMathDelimiters(input)).toBe(input);
  });

  it("never rewrites inside backtick fences", () => {
    const input = "```\n\\(x\\)\n```";

    expect(normalizeScientMathDelimiters(input)).toBe(input);
  });

  it("never rewrites inside tilde fences", () => {
    const input = "~~~\n\\(x\\)\n~~~";

    expect(normalizeScientMathDelimiters(input)).toBe(input);
  });

  it("protects an unclosed fence through the end of the text", () => {
    const input = "```math\n\\(x\\)\nstill inside";

    expect(normalizeScientMathDelimiters(input)).toBe(input);
  });

  it("never rewrites indented code lines", () => {
    const input = "text\n\n    \\(x\\)\n";

    expect(normalizeScientMathDelimiters(input)).toBe(input);
  });

  it("never rewrites inside raw HTML code or pre regions", () => {
    const code = "before <code>\\(x\\)</code> after";
    const pre = "before <pre>\\[y\\]</pre> after";
    const unclosed = "before <code>\\(x\\)";

    expect(normalizeScientMathDelimiters(code)).toBe(code);
    expect(normalizeScientMathDelimiters(pre)).toBe(pre);
    expect(normalizeScientMathDelimiters(unclosed)).toBe(unclosed);
  });

  it("never rewrites inside raw HTML tag attributes", () => {
    const anchor = 'See <a href="/path/\\(v1\\)/doc">link</a> now.';
    const span = '<span title="\\(x\\)">label</span>';

    expect(normalizeScientMathDelimiters(anchor)).toBe(anchor);
    expect(normalizeScientMathDelimiters(span)).toBe(span);
  });

  it("still rewrites prose between raw HTML tags", () => {
    expect(normalizeScientMathDelimiters("<span>\\(x\\)</span>")).toBe("<span>$$x$$</span>");
  });

  it("never rewrites inside HTML comments, closed or streaming", () => {
    const comment = "before <!-- \\(x\\) --> after";
    const unclosed = "before <!-- \\(x\\)";

    expect(normalizeScientMathDelimiters(comment)).toBe(comment);
    expect(normalizeScientMathDelimiters(unclosed)).toBe(unclosed);
  });

  it("never rewrites inside inline code spans, including multi-backtick spans", () => {
    const single = "use `\\(x\\)` here";
    const double = "use ``a \\(x\\) b`` here";

    expect(normalizeScientMathDelimiters(single)).toBe(single);
    expect(normalizeScientMathDelimiters(double)).toBe(double);
  });

  it("leaves escaped and unmatched delimiters alone", () => {
    expect(normalizeScientMathDelimiters("literal \\\\(x\\\\) parens")).toBe(
      "literal \\\\(x\\\\) parens",
    );
    expect(normalizeScientMathDelimiters("an unmatched \\( opener")).toBe(
      "an unmatched \\( opener",
    );
  });

  it("leaves empty pairs alone", () => {
    expect(normalizeScientMathDelimiters("empty \\(  \\) pair")).toBe("empty \\(  \\) pair");
  });

  it("preserves length on mixed documents so no offset can drift", () => {
    const input = [
      "- [ ] solve \\(x^2 + 1 = 0\\)",
      "",
      "```",
      "\\(protected\\)",
      "```",
      "",
      "\\[",
      "\\int_0^1 f",
      "\\]",
      "done 🎉 \\(y\\)",
    ].join("\n");
    const output = normalizeScientMathDelimiters(input);

    expect(output).toHaveLength(input.length);
    expect(output).toContain("- [ ] solve $$x^2 + 1 = 0$$");
    expect(output).toContain("```\n\\(protected\\)\n```");
    expect(output).toContain("$$\n\\int_0^1 f\n$$");
    expect(output).toContain("done 🎉 $$y$$");
    expect(output.indexOf("[ ]")).toBe(input.indexOf("[ ]"));
  });

  it("handles CRLF text without corrupting line structure", () => {
    const input = "\\[\r\nE = mc^2\r\n\\]";

    expect(normalizeScientMathDelimiters(input)).toBe("$$\r\nE = mc^2\r\n$$");
  });
});
