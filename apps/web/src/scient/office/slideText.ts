import type { SlideDisplayList } from "@betteroffice/pptx";

import { layerFont, lineHeight, type WordSpan } from "~/components/files/office/word-protocol";
import { findOffsets } from "./officeFind";
import type { OfficeFindHit } from "./wordFind";

type SlidePrimitive = SlideDisplayList["primitives"][number];
type TextBox = Extract<SlidePrimitive, { kind: "textBox" }>;

/** Measures the text layer's font, at a size of 1. */
export type LayerMeasure = {
  readonly width: (text: string) => number;
  readonly ascent: number;
  readonly descent: number;
};

/** The worker's measure of the text layer's font; undefined where it has no 2D canvas. */
export function layerMeasure(): LayerMeasure | undefined {
  const context = new OffscreenCanvas(1, 1).getContext("2d");
  if (!context) return undefined;
  // Measured large and scaled down, so rounding stays well below a pixel at any zoom.
  context.font = `100px ${layerFont}`;
  const metrics = context.measureText("Hg");
  return {
    width: (text) => context.measureText(text).width / 100,
    ascent: metrics.fontBoundingBoxAscent / 100,
    descent: metrics.fontBoundingBoxDescent / 100,
  };
}

function textBoxes(primitives: readonly SlidePrimitive[]): TextBox[] {
  return primitives.flatMap((primitive) =>
    primitive.kind === "textBox"
      ? [primitive]
      : primitive.kind === "table" || primitive.kind === "chart"
        ? textBoxes(primitive.primitives)
        : [],
  );
}

const RTL = /[֐-ࣿיִ-﷿ﹰ-ﻼ]/;

type Run = TextBox["lines"][number]["runs"][number];

/**
 * A run's words, each with the left edge and width its glyphs paint, so a word's text sits over its
 * own glyphs whatever font the layer draws it in. A space stays with the word before it.
 */
function words(run: Run) {
  const parts = run.text.match(/\S+\s*|\s+/g) ?? [];
  if (run.glyphs.length === 0) return [{ text: run.text, left: run.x, width: run.width }];
  let from = 0;
  return parts.flatMap((text) => {
    const start = from;
    from += text.length;
    let left = Infinity;
    let right = -Infinity;
    for (const glyph of run.glyphs) {
      const at = glyph.cluster - run.start;
      if (at < start || at >= from) continue;
      left = Math.min(left, glyph.x);
      right = Math.max(right, glyph.x + glyph.advance);
    }
    return right > left ? [{ text, left, width: right - left }] : [];
  });
}

/**
 * A slide's text layer, in the Word layer's units: each laid-out word over its glyphs, turned with
 * its box, and a line break after every line.
 */
export function slideTextSpans(slide: SlideDisplayList, measure: LayerMeasure): WordSpan[] {
  const above = (lineHeight + measure.ascent - measure.descent) / 2;
  return textBoxes(slide.primitives).flatMap((box) => {
    const turn = box.transform?.rotationDeg ?? 0;
    return box.lines.flatMap((line) => {
      const spans = line.runs.flatMap((run) => {
        const size = run.fontSizePx;
        if (!run.text || size <= 0) return [];
        const top = line.baseline - (run.baselineOffsetPx ?? 0) - size * above;
        return words(run).map((word): WordSpan => {
          const natural = measure.width(word.text);
          const stretch = natural > 0 && word.width > 0 ? word.width / (natural * size) : 1;
          // A turned box turns its text about the box's centre, given in ems from the word's corner.
          const x = (box.x + box.w / 2 - word.left) / size;
          const y = (box.y + box.h / 2 - top) / size;
          return {
            text: word.text,
            left: word.left / slide.width,
            top: top / slide.height,
            size: size / slide.width,
            transform: `${turn ? `translate(${x}em, ${y}em) rotate(${turn}deg) translate(${-x}em, ${-y}em) ` : ""}scaleX(${stretch})`,
            dir: RTL.test(word.text) ? "rtl" : "ltr",
            link: undefined,
            title: undefined,
            after: undefined,
          };
        });
      });
      const last = spans.at(-1);
      if (last) spans[spans.length - 1] = { ...last, after: "br" };
      return spans;
    });
  });
}

/** How many times each slide's text holds `query`, for slides that hold it. */
export function slideFindHits(slides: readonly string[], query: string): OfficeFindHit[] {
  return slides.flatMap((text, index) => {
    const count = findOffsets(text, query).length;
    return count ? [{ index, count }] : [];
  });
}

/** A slide's text as the layer joins it: runs in order, lines apart. */
export function slidePlainText(spans: readonly WordSpan[]): string {
  return spans.map((span) => span.text + (span.after === "br" ? " " : "")).join("");
}
