import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { describe, expect, it } from "vite-plus/test";

import { remarkScientMath, remarkScientMathRefinements } from "./remarkScientMath";
import {
  isPlausibleScientSingleDollarTex,
  MAX_SCIENT_SINGLE_DOLLAR_TEX_LENGTH,
  remarkScientSingleDollarMath,
} from "./scientSingleDollarMath";

function render(markdown: string): string {
  return renderToStaticMarkup(
    createElement(
      ReactMarkdown,
      {
        remarkPlugins: [
          remarkGfm,
          remarkScientMath,
          remarkScientSingleDollarMath,
          remarkScientMathRefinements,
        ],
      },
      markdown,
    ),
  );
}

const INLINE_MATH_SHAPE = 'class="language-math';

describe("isPlausibleScientSingleDollarTex", () => {
  it("accepts compact expressions, numbers, and control sequences", () => {
    for (const content of ["x^2", "42", "1/2", "a*b*c", "E=mc^2", "f(x)", "\\alpha", "dx/dt"]) {
      expect(isPlausibleScientSingleDollarTex(content)).toBe(true);
    }
  });

  it("accepts spaced content only with a TeX signal", () => {
    expect(isPlausibleScientSingleDollarTex("a + b")).toBe(true);
    expect(isPlausibleScientSingleDollarTex("f: X \\to Y")).toBe(true);
    expect(isPlausibleScientSingleDollarTex("5 and ")).toBe(false);
    expect(isPlausibleScientSingleDollarTex("plain words here")).toBe(false);
  });

  it("rejects shell identifiers and identifier paths", () => {
    for (const content of ["PATH", "USD", "USER_ID", "HOME/bin:", "HOME/", "PATH:", "USD.x"]) {
      expect(isPlausibleScientSingleDollarTex(content)).toBe(false);
    }
  });

  it("rejects colons without a strong TeX signal and link boundaries", () => {
    expect(isPlausibleScientSingleDollarTex("x:y")).toBe(false);
    expect(isPlausibleScientSingleDollarTex("label](/url")).toBe(false);
  });

  it("rejects empty and oversized content", () => {
    expect(isPlausibleScientSingleDollarTex("")).toBe(false);
    expect(
      isPlausibleScientSingleDollarTex("x".repeat(MAX_SCIENT_SINGLE_DOLLAR_TEX_LENGTH + 1)),
    ).toBe(false);
  });
});

describe("guarded single-dollar tokenizer", () => {
  it("recognizes math the tree pass never could — emphasis stays whole", () => {
    const html = render("compute $a*b*c$ now");

    expect(html).toContain(INLINE_MATH_SHAPE);
    expect(html).toContain("a*b*c");
    expect(html).not.toContain("<em>");
  });

  it("leaves double-dollar forms to remark-math", () => {
    const html = render("a $$x^2$$ b");

    expect(html).toContain(INLINE_MATH_SHAPE);
    expect(html.match(/language-math/g)).toHaveLength(1);
  });

  it("treats a backslash-escaped dollar inside a span as content", () => {
    const html = render("price is $\\$5 + \\$10$ total");

    expect(html).toContain(INLINE_MATH_SHAPE);
    expect(html).toContain("\\$5 + \\$10");
  });

  it("never opens after a word character", () => {
    const html = render("file$x$ and US$5$ stay literal");

    expect(html).not.toContain("language-math");
  });

  it("never closes before a digit or another dollar", () => {
    expect(render("between $5-$10 total")).not.toContain("language-math");
    expect(render("odd $x$$ tail")).not.toContain("language-math");
  });

  it("requires the span to close on its line", () => {
    expect(render("start $x + y\nmore text")).not.toContain("language-math");
  });

  it("keeps link labels and destinations whole around stray dollars", () => {
    const html = render("[_chat.$threadId.tsx](/tmp/_chat.$threadId.tsx)");

    expect(html).toContain('href="/tmp/_chat.$threadId.tsx"');
    expect(html).toContain("_chat.$threadId.tsx");
    expect(html).not.toContain("language-math");
  });

  it("renders math inside a link label when properly delimited", () => {
    const html = render("[see $f(x)$ chart](https://example.test)");

    expect(html).toContain(INLINE_MATH_SHAPE);
    expect(html).toContain('href="https://example.test"');
  });

  it("recognizes math after an escaped dollar in the same text run", () => {
    const html = render("literal \\$5 then $x+1$ renders");

    expect(html).toContain(INLINE_MATH_SHAPE);
    expect(html).toContain("x+1");
  });
});
