import type { SlideDisplayList } from "@betteroffice/pptx";
import type { DisplayPage } from "@betteroffice/docx/layout/render";
import { describe, expect, it } from "vite-plus/test";

import { slideFindHits, slidePlainText, slideTextSpans } from "./slideText";
import { wordFindHits } from "./wordFind";

const built = (...starts: number[]) =>
  ({
    width: 816,
    height: 1056,
    primitives: starts.map((docStart) => ({ kind: "glyphRun", docStart })),
  }) as unknown as DisplayPage;
const unbuilt = (from: number, to: number) =>
  ({
    width: 816,
    height: 1056,
    primitives: [],
    unbuilt: true,
    positionSpan: [from, to],
  }) as unknown as DisplayPage;

describe("Office find placement", () => {
  it("places Word matches on the page that holds their document position", () => {
    const pages = [built(30, 1), built(), unbuilt(80, 120), built(130)];
    // The second page holds only a picture: matches past the first page's text stay on it until
    // the next page with text begins.
    expect(wordFindHits(pages, [130, 5, 79, 80, 0, 200])).toEqual([
      { index: 0, count: 3 },
      { index: 2, count: 1 },
      { index: 3, count: 2 },
    ]);
  });

  it("lays a slide's words over their own glyphs and finds them as the layer joins them", () => {
    const measure = { width: (text: string) => text.length * 0.5, ascent: 0.9, descent: -0.2 };
    const run = (text: string, x: number, start: number) => ({
      text,
      start,
      end: start + text.length,
      x,
      width: text.length * 10,
      fontSizePx: 20,
      glyphs: [...text].map((_, at) => ({ cluster: start + at, x: x + at * 10, advance: 10 })),
    });
    const slide = {
      width: 960,
      height: 540,
      primitives: [
        {
          kind: "table",
          primitives: [
            {
              kind: "textBox",
              x: 100,
              y: 100,
              w: 400,
              h: 100,
              lines: [
                { baseline: 140, runs: [run("Head ache", 100, 0)] },
                { baseline: 170, runs: [run("כאב ראש", 100, 9)] },
              ],
            },
          ],
        },
      ],
    } as unknown as SlideDisplayList;
    const spans = slideTextSpans(slide, measure);
    expect(spans.map((span) => [span.text, span.left * 960, span.dir, span.after])).toEqual([
      ["Head ", 100, "ltr", undefined],
      ["ache", 150, "ltr", "br"],
      ["כאב ", 100, "rtl", undefined],
      ["ראש", 140, "rtl", "br"],
    ]);
    const text = slidePlainText(spans);
    expect(slideFindHits([text, "nothing"], "ACHE כאב")).toEqual([{ index: 0, count: 1 }]);
  });
});
