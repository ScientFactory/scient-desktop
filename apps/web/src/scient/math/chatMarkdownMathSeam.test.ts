// @effect-diagnostics nodeBuiltinImport:off -- Static audit for the inherited chat-markdown seam.
import * as NodeFS from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ReactMarkdown from "react-markdown";
import rehypeRaw from "rehype-raw";
import rehypeSanitize, { defaultSchema } from "rehype-sanitize";
import remarkBreaks from "remark-breaks";
import remarkGfm from "remark-gfm";
import { describe, expect, it } from "vite-plus/test";

import { rehypeScientBidi } from "../bidi/rehypeScientBidi";
import { remarkScientMath, remarkScientMathRefinements } from "./remarkScientMath";
import { normalizeScientMathDelimiters } from "./scientMathText";
import { remarkScientSingleDollarMath } from "./scientSingleDollarMath";

const chatMarkdownSource = NodeFS.readFileSync(
  new URL("../../components/ChatMarkdown.tsx", import.meta.url),
  "utf8",
);

describe("ChatMarkdown math seam", () => {
  it("mounts the Scient math modules through the declared imports", () => {
    expect(chatMarkdownSource).toContain('} from "../scient/math/remarkScientMath";');
    expect(chatMarkdownSource).toContain('} from "../scient/math/scientMathText";');
    expect(chatMarkdownSource).toContain(
      'import { remarkScientSingleDollarMath } from "../scient/math/scientSingleDollarMath";',
    );
    expect(chatMarkdownSource).toContain("useScientMathMarkdownText,");
    expect(chatMarkdownSource).toContain("useScientMathRemarkPlugins,");
    expect(chatMarkdownSource).toContain(
      'import { ScientDisplayMath, ScientInlineMath } from "../scient/math/ScientMath";',
    );
  });

  it("registers the math plugins and refinements in both remark plugin arrays", () => {
    expect(
      chatMarkdownSource.match(
        /remarkGfm,\s+remarkScientMath,\s+remarkScientSingleDollarMath,\s+remarkScientMathRefinements,/gu,
      ),
    ).toHaveLength(2);
  });

  it("normalizes delimiters unconditionally — the rewrite is length-preserving", () => {
    expect(chatMarkdownSource).toContain("useScientMathMarkdownText(textProp)");
    expect(chatMarkdownSource).not.toContain("useScientMathMarkdownText(textProp,");
  });

  it("threads the original text through the per-message plugin hook", () => {
    expect(chatMarkdownSource).toContain("useScientMathRemarkPlugins(");
    expect(chatMarkdownSource).toContain("remarkPlugins={remarkPlugins}");
  });

  it("routes math code nodes to the Scient components, with streaming state", () => {
    expect(chatMarkdownSource).toContain(
      "<ScientInlineMath tex={nodeToPlainText(children)} isStreaming={isStreaming} />",
    );
    expect(chatMarkdownSource).toContain(
      "<ScientDisplayMath tex={codeBlock.code} isStreaming={isStreaming} />",
    );
  });
});

/**
 * The chat-shaped pipeline: ChatMarkdown's remark plugin order for math plus
 * the sanitize step that strips non-`language-*` classes. Inline math must
 * arrive as a bare `<code class="language-math">`; display math wrapped in
 * `<pre>`. `sourceText` mirrors the per-message hook: the pre-normalization
 * text the refinement plugin uses to recover authored intent.
 */
function renderChatShapedPipeline(markdown: string, sourceText?: string): string {
  return renderToStaticMarkup(
    createElement(
      ReactMarkdown,
      {
        remarkPlugins: [
          remarkGfm,
          remarkScientMath,
          remarkScientSingleDollarMath,
          [remarkScientMathRefinements, { sourceText }],
        ],
        rehypePlugins: [rehypeRaw, [rehypeSanitize, defaultSchema]],
      },
      markdown,
    ),
  );
}

/** The full chat surface for backslash-delimited input: normalize, then parse with the original riding along. */
function renderNormalized(markdown: string): string {
  return renderChatShapedPipeline(normalizeScientMathDelimiters(markdown), markdown);
}

const INLINE_MATH_SHAPE = '<code class="language-math"';

describe("dollar-form math", () => {
  it("renders double-dollar inline math as a bare code element", () => {
    const html = renderChatShapedPipeline("a $$x^2$$ b");

    expect(html).toContain(INLINE_MATH_SHAPE);
    expect(html).not.toContain("<pre>");
  });

  it("promotes a sole own-line expression to display math", () => {
    for (const markdown of ["$$x + y$$", "$$\nE = mc^2\n$$"]) {
      const html = renderChatShapedPipeline(markdown);
      expect(html).toContain("<pre>");
      expect(html).toContain(INLINE_MATH_SHAPE);
    }
  });

  it("renders a math fence as display math, matching GitHub", () => {
    const html = renderChatShapedPipeline("```math\nE = mc^2\n```");

    expect(html).toContain("<pre>");
    expect(html).toContain(INLINE_MATH_SHAPE);
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
      const html = renderChatShapedPipeline(`value: ${markdown} end`);
      expect(html).toContain(INLINE_MATH_SHAPE);
      expect(html).not.toContain("<pre>");
    }
  });

  it("recognizes a span whole before emphasis can fragment it", () => {
    const html = renderChatShapedPipeline("compute $a*b*c$ now");

    expect(html).toContain(INLINE_MATH_SHAPE);
    expect(html).toContain("a*b*c");
    expect(html).not.toContain("<em>");
  });

  it("renders valid math after an escaped dollar in the same run", () => {
    const html = renderChatShapedPipeline("literal \\$5 then $x+1$ renders");

    expect(html).toContain(INLINE_MATH_SHAPE);
    expect(html).toContain("x+1");
    expect(html).toContain("$5");
  });

  it("keeps a sole single-dollar paragraph inline", () => {
    const html = renderChatShapedPipeline("$x^2$");

    expect(html).toContain(INLINE_MATH_SHAPE);
    expect(html).not.toContain("<pre>");
  });

  it("keeps an unclosed single-dollar span literal while streaming", () => {
    const streaming = renderChatShapedPipeline("solve $x^2");
    const closed = renderChatShapedPipeline("solve $x^2$ now");

    expect(streaming).not.toContain("language-math");
    expect(closed).toContain(INLINE_MATH_SHAPE);
  });

  it("recognizes spans per table cell, never across cells", () => {
    const math = renderChatShapedPipeline("| a | b |\n| - | - |\n| $x^2$ | $y_1$ |");
    const prices = renderChatShapedPipeline("| a | b |\n| - | - |\n| $5 | $6 |");

    expect(math.match(/language-math/g)).toHaveLength(2);
    expect(prices).not.toContain("language-math");
  });
});

describe("single-dollar text that must stay text", () => {
  it("keeps shell fragments with separators literal", () => {
    const html = renderChatShapedPipeline("echo $HOME/bin:$PATH");

    expect(html).not.toContain("language-math");
    expect(html).toContain("$HOME/bin:$PATH");
  });

  it("keeps adjacent shell variables literal", () => {
    const html = renderChatShapedPipeline("use $HOME/$USER here");

    expect(html).not.toContain("language-math");
  });
});

describe("dollar text that must stay text", () => {
  it("keeps shell and environment identifiers literal", () => {
    for (const markdown of ["$PATH$", "$USD$", "$HOME and $PATH."]) {
      const html = renderChatShapedPipeline(`echo ${markdown} done`);
      expect(html).not.toContain("language-math");
    }
  });

  it("keeps prices literal", () => {
    const html = renderChatShapedPipeline("It costs $5 and $10 today.");

    expect(html).not.toContain("language-math");
    expect(html).toContain("$5 and $10");
  });

  it("keeps price ranges literal", () => {
    const html = renderChatShapedPipeline("between $5-$10 total");

    expect(html).not.toContain("language-math");
  });

  it("keeps file links with dollar route parameters intact", () => {
    const html = renderChatShapedPipeline("[_chat.$threadId.tsx](/tmp/_chat.$threadId.tsx)");

    expect(html).toContain('href="/tmp/_chat.$threadId.tsx"');
    expect(html).toContain("_chat.$threadId.tsx");
    expect(html).not.toContain("language-math");
  });

  it("respects escaped dollars", () => {
    const html = renderChatShapedPipeline("costs \\$50 and \\$60 total");

    expect(html).not.toContain("language-math");
    expect(html).toContain("$50 and $60");
  });

  it("leaves an unmatched dollar alone", () => {
    const html = renderChatShapedPipeline("only one $ here");

    expect(html).not.toContain("language-math");
  });

  it("never recognizes math inside inline code", () => {
    const html = renderChatShapedPipeline("run `echo $x$` now");

    expect(html).not.toContain("language-math");
  });
});

describe("backslash delimiters keep their authored intent", () => {
  it("renders \\(...\\) mid-sentence as inline math", () => {
    const html = renderNormalized("The value \\(x\\) appears mid-sentence.");

    expect(html).toContain(INLINE_MATH_SHAPE);
    expect(html).not.toContain("<pre>");
  });

  it("renders \\[...\\] mid-paragraph as display math, breaking the paragraph", () => {
    const html = renderNormalized("Consider \\[E = mc^2\\] within a paragraph of prose.");

    expect(html).toContain("<pre>");
    expect(html).toContain("Consider");
    expect(html).toContain("within a paragraph of prose.");
  });

  it("renders own-line \\[...\\] inside a prose paragraph as display math", () => {
    const html = renderNormalized("The energy is\n\\[E = mc^2\\]\nwhere m is mass.");

    expect(html).toContain("<pre>");
    expect(html).toContain("The energy is");
    expect(html).toContain("where m is mass.");
  });

  it("keeps a sole \\(...\\) paragraph inline", () => {
    const html = renderNormalized("\\(x\\)");

    expect(html).toContain(INLINE_MATH_SHAPE);
    expect(html).not.toContain("<pre>");
  });

  it("renders a sole \\[...\\] paragraph as display math", () => {
    const html = renderNormalized("\\[E = mc^2\\]");

    expect(html).toContain("<pre>");
  });

  it("keeps authored intent on the hard-break surface without stray breaks", () => {
    // Mirrors CHAT_MARKDOWN_REMARK_PLUGINS_WITH_BREAKS: the refinements run
    // before remark-breaks, so split paragraphs must not leak edge newlines.
    const source = "The energy is\n\\[E = mc^2\\]\nwhere m is mass.";
    const html = renderToStaticMarkup(
      createElement(
        ReactMarkdown,
        {
          remarkPlugins: [
            remarkGfm,
            remarkScientMath,
            [remarkScientMathRefinements, { sourceText: source }],
            remarkBreaks,
          ],
          rehypePlugins: [rehypeRaw, [rehypeSanitize, defaultSchema]],
        },
        normalizeScientMathDelimiters(source),
      ),
    );

    expect(html).toContain("<pre>");
    expect(html).not.toContain("<br");
  });
});

describe("literal regions survive normalization end to end", () => {
  it("keeps backslash delimiters literal in fenced, tilde-fenced, and indented code", () => {
    for (const markdown of ["```\n\\(x\\)\n```", "~~~\n\\(x\\)\n~~~", "text\n\n    \\(x\\)\n"]) {
      const html = renderNormalized(markdown);
      expect(html).not.toContain("language-math");
      expect(html).toContain("\\(x\\)");
    }
  });

  it("never turns raw HTML code content into math", () => {
    // Ordinary markdown escaping still consumes the backslashes here, exactly
    // as it did before math support; the content just must not become math.
    const html = renderNormalized("before <code>\\(x\\)</code> after");

    expect(html).not.toContain("language-math");
    expect(html).toContain("<code>(x)</code>");
  });

  it("never rewrites delimiter lookalikes inside raw HTML attributes", () => {
    const html = renderNormalized('See <a href="/path/\\(v1\\)/doc">link</a> now.');

    expect(html).not.toContain("$$");
    expect(html).toContain("\\(v1\\)");
  });

  it("still recognizes math in prose between raw HTML tags", () => {
    const html = renderNormalized("<span>\\(x\\)</span> trails <b>bold</b>");

    expect(html).toContain(INLINE_MATH_SHAPE);
  });

  it("renders normalized backslash delimiters as math outside those regions", () => {
    const inline = renderNormalized("Euler: \\(e^{i\\pi} = -1\\) holds.");
    const display = renderNormalized("\\[\nE = mc^2\n\\]");

    expect(inline).toContain(INLINE_MATH_SHAPE);
    expect(inline).not.toContain("<pre>");
    expect(display).toContain("<pre>");
  });
});

describe("incomplete and oversized math stays literal", () => {
  it("keeps an unclosed display block literal until its closer arrives", () => {
    const streaming = renderChatShapedPipeline("before\n\n$$\nx + y");
    const closed = renderChatShapedPipeline("before\n\n$$\nx + y\n$$");

    expect(streaming).not.toContain("language-math");
    expect(streaming).toContain("$$");
    expect(closed).toContain(INLINE_MATH_SHAPE);
  });

  it("keeps an unclosed backslash display block literal until its closer arrives", () => {
    const streaming = renderNormalized("prose \\[E = mc");
    const closed = renderNormalized("prose \\[E = mc^2\\] done");

    expect(streaming).not.toContain("language-math");
    expect(closed).toContain("<pre>");
  });

  it("keeps an unclosed math fence literal until its closer arrives", () => {
    const streaming = renderChatShapedPipeline("```math\nx + y");
    const closed = renderChatShapedPipeline("```math\nx + y\n```");

    expect(streaming).not.toContain("language-math");
    expect(closed).toContain(INLINE_MATH_SHAPE);
  });

  it("keeps oversized TeX literal in every form", () => {
    const oversized = "x + ".repeat(300);
    const inline = renderChatShapedPipeline(`a $$${oversized}$$ b`);
    const display = renderChatShapedPipeline(`$$\n${oversized}\n$$`);

    expect(inline).not.toContain("language-math");
    expect(display).not.toContain("language-math");
  });
});

describe("task lists and math coexist", () => {
  it("keeps checkboxes and marker structure alongside math", () => {
    const html = renderChatShapedPipeline("- [ ] solve $$x^2$$\n- [x] done");

    expect(html).toContain('type="checkbox"');
    expect(html).toContain(INLINE_MATH_SHAPE);
  });

  it("keeps checkboxes when a task item carries display-intent math", () => {
    const html = renderNormalized("- [ ] solve \\[x^2 = 4\\]\n- [x] done");

    expect(html).toContain('type="checkbox"');
    expect(html).toContain("<pre>");
  });
});

describe("math inside RTL prose", () => {
  it("keeps Hebrew paragraph direction while the equation stays an isolated math node", () => {
    const html = renderToStaticMarkup(
      createElement(
        ReactMarkdown,
        {
          remarkPlugins: [
            remarkGfm,
            remarkScientMath,
            remarkScientSingleDollarMath,
            [remarkScientMathRefinements, {}],
          ],
          rehypePlugins: [
            rehypeRaw,
            [rehypeSanitize, defaultSchema],
            [rehypeScientBidi, { direction: "rtl", requestedDirection: "auto" }],
          ],
        },
        "הנוסחה $x^2 + 1$ מופיעה במשפט הזה.",
      ),
    );

    expect(html).toContain('dir="rtl"');
    expect(html).toContain(INLINE_MATH_SHAPE);
    expect(html).toContain("x^2 + 1");
  });
});
