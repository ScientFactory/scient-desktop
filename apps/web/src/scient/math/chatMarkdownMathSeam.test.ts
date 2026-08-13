// @effect-diagnostics nodeBuiltinImport:off -- Static audit for the inherited chat-markdown seam.
import * as NodeFS from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ReactMarkdown from "react-markdown";
import rehypeRaw from "rehype-raw";
import rehypeSanitize, { defaultSchema } from "rehype-sanitize";
import remarkGfm from "remark-gfm";
import { describe, expect, it } from "vite-plus/test";

import { remarkScientMath } from "./remarkScientMath";
import { normalizeScientMathDelimiters } from "./scientMathText";

const chatMarkdownSource = NodeFS.readFileSync(
  new URL("../../components/ChatMarkdown.tsx", import.meta.url),
  "utf8",
);

describe("ChatMarkdown math seam", () => {
  it("mounts the Scient math modules through the declared imports", () => {
    expect(chatMarkdownSource).toContain(
      'import { isScientMathCodeClassName, remarkScientMath } from "../scient/math/remarkScientMath";',
    );
    expect(chatMarkdownSource).toContain(
      'import { useScientMathMarkdownText } from "../scient/math/scientMathText";',
    );
    expect(chatMarkdownSource).toContain(
      'import { ScientDisplayMath, ScientInlineMath } from "../scient/math/ScientMath";',
    );
  });

  it("registers the math plugin in both remark plugin arrays", () => {
    expect(chatMarkdownSource.match(/remarkGfm,\s+remarkScientMath,/gu)).toHaveLength(2);
  });

  it("normalizes delimiters only where no offset-based task-list writer exists", () => {
    expect(chatMarkdownSource).toContain(
      "useScientMathMarkdownText(textProp, onTaskListChange === undefined)",
    );
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
 * The chat pipeline shape the seam branches rely on: `language-math` must
 * survive sanitization, inline math must arrive as a bare `<code>`, and
 * display math must arrive wrapped in `<pre>`.
 */
function renderChatShapedPipeline(markdown: string): string {
  return renderToStaticMarkup(
    createElement(
      ReactMarkdown,
      {
        remarkPlugins: [remarkGfm, remarkScientMath],
        rehypePlugins: [rehypeRaw, [rehypeSanitize, defaultSchema]],
      },
      markdown,
    ),
  );
}

describe("chat-shaped math pipeline", () => {
  it("keeps language-math on inline math as a bare code element", () => {
    const html = renderChatShapedPipeline("Euler: $e^{i\\pi} = -1$");

    expect(html).toContain('<code class="language-math"');
    expect(html).not.toContain("<pre>");
  });

  it("drops the math-inline and math-display classes, so detection cannot use them", () => {
    const inline = renderChatShapedPipeline("$x$");
    const display = renderChatShapedPipeline("$$\nx\n$$");

    expect(inline).not.toContain("math-inline");
    expect(display).not.toContain("math-display");
  });

  it("wraps own-line display math in pre, the shape the pre override intercepts", () => {
    const html = renderChatShapedPipeline("$$\nE = mc^2\n$$");

    expect(html).toContain("<pre>");
    expect(html).toContain('<code class="language-math"');
  });

  it("parses a math fence like display math, matching GitHub", () => {
    const html = renderChatShapedPipeline("```math\nE = mc^2\n```");

    expect(html).toContain("<pre>");
    expect(html).toContain('<code class="language-math"');
  });

  it("renders normalized backslash delimiters through the same shapes", () => {
    const inline = renderChatShapedPipeline(
      normalizeScientMathDelimiters("Euler: \\(e^{i\\pi} = -1\\) holds."),
    );
    const display = renderChatShapedPipeline(normalizeScientMathDelimiters("\\[\nE = mc^2\n\\]"));

    expect(inline).toContain('<code class="language-math"');
    expect(inline).not.toContain("<pre>");
    expect(display).toContain("<pre>");
    expect(display).toContain('<code class="language-math"');
  });

  it("parses space-separated prices as math, which the currency guard renders literally", () => {
    const html = renderChatShapedPipeline("It costs $5 and $10 today.");

    // The parser cannot tell money from math; `isLikelyCurrencyText` restores
    // the literal text at render time (covered in ScientMath.test.ts).
    expect(html).toContain('<code class="language-math">5 and </code>');
  });
});
