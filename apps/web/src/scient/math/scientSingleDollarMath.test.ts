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
    expect(isPlausibleScientSingleDollarTex("x][r]")).toBe(false);
    expect(isPlausibleScientSingleDollarTex("[^1]")).toBe(false);
  });

  it("rejects content that ends in a bare binder — the glued-variable class", () => {
    for (const content of ["src/", "old/", "a=", "total=", "a,", "1==", "1,", "h{", "(BIN)/"]) {
      expect(isPlausibleScientSingleDollarTex(content)).toBe(false);
    }
  });

  it("rejects interpolation-shaped content but keeps parenthesized formulas", () => {
    for (const content of ["(pwd)", "(date)", "{row}", "{DIR}/", "('#total').text("]) {
      expect(isPlausibleScientSingleDollarTex(content)).toBe(false);
    }
    expect(isPlausibleScientSingleDollarTex("(a+b)^2")).toBe(true);
    expect(isPlausibleScientSingleDollarTex("{a \\over b}")).toBe(true);
  });

  it("rejects reference labels and tag shapes but keeps intervals", () => {
    expect(isPlausibleScientSingleDollarTex("[foo]")).toBe(false);
    expect(isPlausibleScientSingleDollarTex("<https://x.test/a>")).toBe(false);
    expect(isPlausibleScientSingleDollarTex("a</b>")).toBe(false);
    expect(isPlausibleScientSingleDollarTex("www.x.test")).toBe(false);
    expect(isPlausibleScientSingleDollarTex("[0,1]")).toBe(true);
    expect(isPlausibleScientSingleDollarTex("[a,b]")).toBe(true);
  });

  it("requires a real operator for spaced content — an emphasis star does not qualify", () => {
    expect(isPlausibleScientSingleDollarTex("b* c")).toBe(false);
    expect(isPlausibleScientSingleDollarTex("a + b")).toBe(true);
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

  it("keeps glued lowercase variables literal — shell, sed, perl, awk", () => {
    for (const markdown of [
      "cp $src/$dst now",
      'run sed "s/$old/$new/" file.txt',
      "assign $a=$b; in the loop",
      'echo "$a,$b" >> out.csv',
      "perl hash $h{$key} lookup",
      "awk '$1==$NF' data.txt",
      "awk '{print $1,$NF}' file",
    ]) {
      expect(render(markdown)).not.toContain("language-math");
    }
  });

  it("keeps interpolation syntax literal — bash, Make, PowerShell, jQuery", () => {
    for (const markdown of [
      'use "${DIR}/${FILE}" as the path',
      "run $(pwd)/$(basename $f) now",
      'Write-Host "$($user.Name)" today',
      "install $(BIN)/$(NAME) here",
      "call $('#total').text($('#a').val()) now",
      "key is ${row}${col} joined",
    ]) {
      expect(render(markdown)).not.toContain("language-math");
    }
  });

  it("never engulfs reference links, footnotes, or autolinks", () => {
    const referenceStraddle = render("[a $x][r]$\n\n[r]: /url");
    expect(referenceStraddle).toContain('href="/url"');
    expect(referenceStraddle).not.toContain("language-math");

    const shortcut = render("see $[foo]$ done\n\n[foo]: /url");
    expect(shortcut).toContain('href="/url"');
    expect(shortcut).not.toContain("language-math");

    const footnote = render("note $[^1]$ end\n\n[^1]: body");
    expect(footnote).toContain("body");
    expect(footnote).not.toContain("language-math");

    const autolink = render("pay $<https://x.test/a>$ now");
    expect(autolink).toContain('href="https://x.test/a"');
    expect(autolink).not.toContain("language-math");
  });

  it("never swallows an inline-HTML closing tag", () => {
    const html = render("<b>$a</b>$b$");

    // The straddling span `$a</b>$` is rejected, keeping the tag balanced;
    // the well-formed trailing `$b$` still renders.
    expect(html).toContain("$a");
    expect(html).toContain("&lt;/b&gt;");
    expect(html).toContain('">b</code>');
    expect(html).not.toContain("a&lt;/b&gt;</code>");
  });

  it("never destroys emphasis with a spaced straddle", () => {
    const html = render("*a $b* c$");

    expect(html).toContain("<em>");
    expect(html).not.toContain("language-math");
  });
});
