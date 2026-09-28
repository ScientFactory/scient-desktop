import { describe, expect, it } from "@effect/vitest";

import { scanHtmlStartTags } from "./htmlTags.ts";

const attributesOf = (html: string) =>
  scanHtmlStartTags(html).map((tag) => [tag.name, Object.fromEntries(tag.attributes)]);

describe("HTML start tags", () => {
  it("reads each attribute within its own quotes", () => {
    expect(attributesOf(`<img alt='x src="https://e/a.png"' src="./x.png">`)).toEqual([
      ["img", { alt: 'x src="https://e/a.png"', src: "./x.png" }],
    ]);
    expect(attributesOf(`<img alt="a src='./x.png'" src='https://e/b.png'>`)).toEqual([
      ["img", { alt: "a src='./x.png'", src: "https://e/b.png" }],
    ]);
    expect(attributesOf("<IMG SRC=./u.png ALT=U/>")).toEqual([
      ["img", { src: "./u.png", alt: "U/" }],
    ]);
    expect(
      attributesOf('<img data-src="./x.png" src = "https://e/c.png" src="./second.png">'),
    ).toEqual([["img", { "data-src": "./x.png", src: "https://e/c.png" }]]);
  });

  it("gives offsets, skips comments and raw text, and stops at an unterminated tag", () => {
    const html = `<!-- <img src="./c.png"> --><p title='<img src="./t.png">'>x</p><script><img src="./s.png"></script><img src="./x.png">`;
    const tags = scanHtmlStartTags(html);
    expect(tags.map((tag) => tag.name)).toEqual(["p", "script", "img"]);
    const img = tags.at(-1)!;
    expect(html.slice(img.start, img.end)).toBe('<img src="./x.png">');
    expect(scanHtmlStartTags(`<img alt="open src="./x.png">`).map((tag) => tag.name)).toEqual([
      "img",
    ]);
    expect(scanHtmlStartTags(`<img alt='never closed src="./x.png">`)).toEqual([]);
    expect(scanHtmlStartTags("a < b and 1<2")).toEqual([]);
  });
});
