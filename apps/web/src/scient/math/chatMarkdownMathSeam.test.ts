// @effect-diagnostics nodeBuiltinImport:off -- Static audit for the inherited chat-markdown seam.
import * as NodeFS from "node:fs";
import { toHtml } from "hast-util-to-html";
import { describe, expect, it } from "vite-plus/test";

import { wordsHast } from "~/markdown/wordsHast";

const chatMarkdownSource = NodeFS.readFileSync(
  new URL("../../components/ChatMarkdown.tsx", import.meta.url),
  "utf8",
);

describe("ChatMarkdown math seam", () => {
  // No rendered chat case observes the streaming and focusable props yet, so this text check stays.
  it("routes math code nodes to the Scient components, with streaming state", () => {
    expect(chatMarkdownSource).toContain("const tex = nodeToPlainText(children);");
    expect(chatMarkdownSource).toMatch(
      /<ScientInlineMath\s+tex=\{tex\}\s+isStreaming=\{isStreaming\}\s+focusable=\{!inline\}\s*\/>/,
    );
    expect(chatMarkdownSource).toMatch(
      /<ScientDisplayMath\s+tex=\{codeBlock.code\}\s+isStreaming=\{isStreaming\}\s+focusable=\{!inline\}\s*\/>/,
    );
  });
});

/** Chat's sanitized tree for a message, as ChatMarkdown builds it, as HTML. */
function chatHtml(
  markdown: string,
  options: { breaks?: boolean; direction?: "ltr" | "rtl" } = {},
): string {
  return toHtml(
    wordsHast(markdown, {
      math: true,
      breaks: options.breaks ?? false,
      escapeHtml: false,
      insights: false,
      extensions: {},
      scient: {
        math: true,
        contentDirection: options.direction ?? "ltr",
        requestedContentDirection: "auto",
      },
    }),
  );
}

const INLINE_MATH_SHAPE = '<code class="language-math math-inline"';
const DISPLAY_MATH_SHAPE = '<code class="language-math math-display"';

describe("dollar-form math", () => {
  it("renders double-dollar math beside prose inline", () => {
    const html = chatHtml("a $$x^2$$ b");

    expect(html).toContain(INLINE_MATH_SHAPE);
    expect(html).not.toContain("<pre");
  });

  it("promotes a sole own-line expression to display math", () => {
    for (const markdown of ["$$x + y$$", "$$\nE = mc^2\n$$", "Then\n$$x + y$$\nholds."]) {
      const html = chatHtml(markdown);
      expect(html).toContain(DISPLAY_MATH_SHAPE);
      expect(html).not.toContain(INLINE_MATH_SHAPE);
    }
  });

  it("renders a math fence as display math, matching GitHub", () => {
    expect(chatHtml("```math\nE = mc^2\n```")).toContain(DISPLAY_MATH_SHAPE);
  });
});

describe("single-dollar math from model output", () => {
  it("renders well-formed single-dollar expressions as inline math", () => {
    for (const markdown of [
      "$x^2$",
      "$42$",
      "$1/2$",
      "$1+1$",
      "$12-15$",
      "$\\alpha$",
      "$E=mc^2$",
      "$f(x)$",
      "$a*b*c$",
    ]) {
      const html = chatHtml(`value: ${markdown} end`);
      expect(html).toContain(INLINE_MATH_SHAPE);
      expect(html).not.toContain("<pre");
    }
  });

  it("renders valid math after an escaped dollar in the same run", () => {
    const html = chatHtml("literal \\$5 then $x+1$ renders");

    expect(html).toContain(INLINE_MATH_SHAPE);
    expect(html).toContain("x+1");
    expect(html).toContain("$5");
  });

  it("keeps a sole single-dollar paragraph inline", () => {
    const html = chatHtml("$x^2$");

    expect(html).toContain(INLINE_MATH_SHAPE);
    expect(html).not.toContain("<pre");
  });

  it("keeps an unclosed single-dollar span literal while streaming", () => {
    expect(chatHtml("solve $x^2")).not.toContain("language-math");
    expect(chatHtml("solve $x^2$ now")).toContain(INLINE_MATH_SHAPE);
  });

  it("recognizes spans per table cell, and prices in cells stay text", () => {
    const math = chatHtml("| a | b |\n| - | - |\n| $x^2$ | $y_1$ |");
    const prices = chatHtml("| a | b |\n| - | - |\n| $5 | $6 |");

    expect(math.match(/language-math/g)).toHaveLength(2);
    expect(prices).not.toContain("language-math");
  });

  it("keeps a formula with a pipe in one table cell", () => {
    const html = chatHtml("| a | b |\n| - | - |\n| $x | y$ | 2 |");

    expect(html.match(/<td/g)).toHaveLength(2);
    expect(html).toContain('data-scient-math-source="$x | y$"');
  });
});

describe("dollar text that must stay text", () => {
  it("keeps shell fragments and variables literal", () => {
    for (const markdown of [
      "echo $HOME/bin:$PATH",
      "use $HOME/$USER here",
      "echo $PATH$ done",
      "echo $HOME$ done",
      "echo $HOME and $PATH. done",
    ]) {
      const html = chatHtml(markdown);
      expect(html).not.toContain("language-math");
      expect(html).toContain(markdown);
    }
  });

  it("keeps prices literal", () => {
    for (const markdown of ["It costs $5 and $10 today.", "from $3.50 to $4.00"]) {
      const html = chatHtml(markdown);
      expect(html).not.toContain("language-math");
      expect(html).toContain(markdown);
    }
  });

  it("respects escaped dollars", () => {
    const html = chatHtml("costs \\$50 and \\$60 total");

    expect(html).not.toContain("language-math");
    expect(html).toContain("$50 and $60");
  });

  it("leaves an unmatched dollar alone", () => {
    expect(chatHtml("only one $ here")).not.toContain("language-math");
  });

  it("never recognizes math inside inline code", () => {
    expect(chatHtml("run `echo $x$` now")).not.toContain("language-math");
  });
});

describe("backslash delimiters keep their authored intent", () => {
  it("renders \\(...\\) mid-sentence as inline math", () => {
    const html = chatHtml("The value \\(x\\) appears mid-sentence.");

    expect(html).toContain(INLINE_MATH_SHAPE);
    expect(html).not.toContain("<pre");
  });

  it("renders \\[...\\] mid-paragraph as display math, breaking the paragraph", () => {
    const html = chatHtml("Consider \\[E = mc^2\\] within a paragraph of prose.");

    expect(html).toContain(DISPLAY_MATH_SHAPE);
    expect(html).toContain('<p dir="ltr">Consider</p>');
    expect(html).toContain('<p dir="ltr">within a paragraph of prose.</p>');
  });

  it("renders own-line \\[...\\] inside a prose paragraph as display math", () => {
    const html = chatHtml("The energy is\n\\[E = mc^2\\]\nwhere m is mass.");

    expect(html).toContain(DISPLAY_MATH_SHAPE);
    expect(html).toContain("The energy is");
    expect(html).toContain("where m is mass.");
  });

  it("keeps a sole \\(...\\) paragraph inline", () => {
    const html = chatHtml("\\(x\\)");

    expect(html).toContain(INLINE_MATH_SHAPE);
    expect(html).not.toContain("<pre");
  });

  it("renders a sole \\[...\\] paragraph as display math", () => {
    expect(chatHtml("\\[E = mc^2\\]")).toContain(DISPLAY_MATH_SHAPE);
    expect(chatHtml("\\[\nE = mc^2\n\\]")).toContain(DISPLAY_MATH_SHAPE);
  });

  it("keeps authored intent with line breaks on, without stray breaks", () => {
    const html = chatHtml("The energy is\n\\[E = mc^2\\]\nwhere m is mass.", { breaks: true });

    expect(html).toContain(DISPLAY_MATH_SHAPE);
    expect(html).not.toContain("<br");
  });
});

describe("literal regions stay literal", () => {
  it("keeps backslash delimiters literal in fenced, tilde-fenced, and indented code", () => {
    for (const markdown of ["```\n\\(x\\)\n```", "~~~\n\\(x\\)\n~~~", "text\n\n    \\(x\\)\n"]) {
      const html = chatHtml(markdown);
      expect(html).not.toContain("language-math");
      expect(html).toContain("\\(x\\)");
    }
  });

  it("never turns raw HTML code content into math", () => {
    const html = chatHtml("before <code>$x$</code> after");

    expect(html).not.toContain("language-math");
    expect(html).toContain(">$x$</code>");
  });

  it("never rewrites delimiter lookalikes inside raw HTML attributes", () => {
    const html = chatHtml('See <a href="/path/\\(v1\\)/doc">link</a> now.');

    expect(html).not.toContain("language-math");
    expect(html).toContain('href="/path/%5C(v1%5C)/doc"');
  });

  it("still recognizes math in prose between raw HTML tags", () => {
    expect(chatHtml("<span>\\(x\\)</span> trails <b>bold</b>")).toContain(INLINE_MATH_SHAPE);
  });
});

describe("incomplete and oversized math stays literal", () => {
  it("keeps an unclosed display block literal until its closer arrives", () => {
    const streaming = chatHtml("before\n\n$$\nx + y");

    expect(streaming).not.toContain("language-math");
    expect(streaming).toContain("$$");
    expect(chatHtml("before\n\n$$\nx + y\n$$")).toContain(DISPLAY_MATH_SHAPE);
  });

  it("keeps an unclosed backslash display block literal until its closer arrives", () => {
    expect(chatHtml("prose \\[E = mc")).not.toContain("language-math");
    expect(chatHtml("prose \\[E = mc^2\\] done")).toContain(DISPLAY_MATH_SHAPE);
  });

  it("keeps an unclosed math fence as code until its closer arrives", () => {
    const streaming = chatHtml("```math\nx + y");

    expect(streaming).not.toContain("language-math");
    expect(streaming).toContain("<pre");
    expect(chatHtml("```math\nx + y\n```")).toContain(DISPLAY_MATH_SHAPE);
  });

  it("keeps oversized TeX literal in every form", () => {
    const oversized = "x + ".repeat(300);
    const inline = chatHtml(`a $$${oversized}$$ b`);
    const display = chatHtml(`$$\n${oversized}\n$$`);

    expect(inline).not.toContain("language-math");
    expect(inline).toContain(`a $$${oversized}$$ b`);
    expect(display).not.toContain("language-math");
    expect(display).toContain(`<pre><code>$$\n${oversized}\n$$</code></pre>`);
  });
});

describe("task lists and math coexist", () => {
  it("keeps checkboxes and marker structure alongside math", () => {
    const html = chatHtml("- [ ] solve $$x^2$$\n- [x] done");

    expect(html).toContain('type="checkbox"');
    expect(html).toContain(INLINE_MATH_SHAPE);
  });

  it("keeps checkboxes when a task item carries display-intent math", () => {
    const html = chatHtml("- [ ] solve \\[x^2 = 4\\]\n- [x] done");

    expect(html).toContain('type="checkbox"');
    expect(html).toContain(DISPLAY_MATH_SHAPE);
  });
});

describe("math inside RTL prose", () => {
  it("keeps Hebrew paragraph direction while the equation stays an isolated math node", () => {
    const html = chatHtml("הנוסחה $x^2 + 1$ מופיעה במשפט הזה.", { direction: "rtl" });

    expect(html).toContain('<p dir="rtl">');
    expect(html).toContain(`${INLINE_MATH_SHAPE} data-scient-math-source="$x^2 + 1$" dir="ltr">`);
  });
});
