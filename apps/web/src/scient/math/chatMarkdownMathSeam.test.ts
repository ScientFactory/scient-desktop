// @effect-diagnostics nodeBuiltinImport:off -- Static audit for the inherited chat-markdown seam.
import * as NodeFS from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ReactMarkdown from "react-markdown";
import rehypeRaw from "rehype-raw";
import rehypeSanitize, { defaultSchema } from "rehype-sanitize";
import remarkGfm from "remark-gfm";
import { describe, expect, it } from "vite-plus/test";

import { rehypeScientBidi } from "../bidi/rehypeScientBidi";
import { remarkScientMath, remarkScientMathRefinements } from "./remarkScientMath";
import { normalizeScientMathDelimiters } from "./scientMathText";

const chatMarkdownSource = NodeFS.readFileSync(
  new URL("../../components/ChatMarkdown.tsx", import.meta.url),
  "utf8",
);

describe("ChatMarkdown math seam", () => {
  it("mounts the Scient math modules through the declared imports", () => {
    expect(chatMarkdownSource).toContain('} from "../scient/math/remarkScientMath";');
    expect(chatMarkdownSource).toContain(
      'import { useScientMathMarkdownText } from "../scient/math/scientMathText";',
    );
    expect(chatMarkdownSource).toContain(
      'import { ScientDisplayMath, ScientInlineMath } from "../scient/math/ScientMath";',
    );
  });

  it("registers the math plugin and its refinements in both remark plugin arrays", () => {
    expect(
      chatMarkdownSource.match(/remarkGfm,\s+remarkScientMath,\s+remarkScientMathRefinements,/gu),
    ).toHaveLength(2);
  });

  it("normalizes delimiters unconditionally — the rewrite is length-preserving", () => {
    expect(chatMarkdownSource).toContain("useScientMathMarkdownText(textProp)");
    expect(chatMarkdownSource).not.toContain("useScientMathMarkdownText(textProp,");
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
 * `<pre>`.
 */
function renderChatShapedPipeline(markdown: string): string {
  return renderToStaticMarkup(
    createElement(
      ReactMarkdown,
      {
        remarkPlugins: [remarkGfm, remarkScientMath, remarkScientMathRefinements],
        rehypePlugins: [rehypeRaw, [rehypeSanitize, defaultSchema]],
      },
      markdown,
    ),
  );
}

function renderNormalized(markdown: string): string {
  return renderChatShapedPipeline(normalizeScientMathDelimiters(markdown));
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

  it("renders validated single-dollar spans as inline math", () => {
    for (const markdown of ["$x^2$", "$42$", "$1/2$", "$1+1$", "$12-15$", "$\\alpha$"]) {
      const html = renderChatShapedPipeline(`value: ${markdown} end`);
      expect(html).toContain(INLINE_MATH_SHAPE);
    }
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

  it("keeps price ranges literal — a digit after the closer rejects the span", () => {
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
    const html = renderChatShapedPipeline("- [ ] solve $x^2$\n- [x] done");

    expect(html).toContain('type="checkbox"');
    expect(html).toContain(INLINE_MATH_SHAPE);
  });
});

describe("math inside RTL prose", () => {
  it("keeps Hebrew paragraph direction while the equation stays an isolated math node", () => {
    const html = renderToStaticMarkup(
      createElement(
        ReactMarkdown,
        {
          remarkPlugins: [remarkGfm, remarkScientMath, remarkScientMathRefinements],
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
