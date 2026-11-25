import { degrees, PDFDocument } from "pdf-lib";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import { describe, expect, it } from "vite-plus/test";

import { pdfRegionFromPageFractions, pdfRegionPageBox } from "./pdfRegionGeometry";

/** One page whose view box does not start at the origin and which the PDF itself turns. */
async function turnedPage() {
  const source = await PDFDocument.create();
  const page = source.addPage([612, 792]);
  page.setMediaBox(10, 20, 612, 792);
  page.setRotation(degrees(90));
  const task = getDocument({ data: await source.save() });
  const document = await task.promise;
  return { page: await document.getPage(1), [Symbol.asyncDispose]: () => task.destroy() };
}

describe("PDF region geometry", () => {
  it("stores the same PDF box whatever zoom and rotation it was drawn at", async () => {
    await using fixture = await turnedPage();
    const { page } = fixture;
    const viewBox = page.view as [number, number, number, number];
    expect(viewBox).toEqual([10, 20, 622, 812]);
    const rect = [72, 400, 300, 700] as const;
    for (const scale of [0.75, 2]) {
      for (const turn of [0, 90, 180, 270]) {
        const viewport = page.getViewport({ scale, rotation: (page.rotate + turn) % 360 });
        const box = pdfRegionPageBox(viewport, rect);
        // pdf.js itself puts the box's corners where the reader paints them.
        const corners = [
          viewport.convertToViewportPoint(rect[0], rect[1]),
          viewport.convertToViewportPoint(rect[2], rect[3]),
        ];
        expect(box.left).toBeCloseTo(Math.min(corners[0]![0]!, corners[1]![0]!) / viewport.width);
        expect(box.top).toBeCloseTo(Math.min(corners[0]![1]!, corners[1]![1]!) / viewport.height);

        // Dragged from either corner, the painted box reads back as the stored one.
        const stored = pdfRegionFromPageFractions(
          viewport,
          viewBox,
          { x: box.left + box.width, y: box.top },
          { x: box.left, y: box.top + box.height },
        );
        expect(stored).not.toBeNull();
        stored!.forEach((value, index) => expect(value).toBeCloseTo(rect[index]!));
      }
    }
  });

  it("keeps a drag to the page's edges inside its view box and drops one with no area", async () => {
    await using fixture = await turnedPage();
    const { page } = fixture;
    const viewBox = page.view as [number, number, number, number];
    const viewport = page.getViewport({ scale: 1.3, rotation: (page.rotate + 90) % 360 });
    const whole = pdfRegionFromPageFractions(viewport, viewBox, { x: 0, y: 0 }, { x: 1, y: 1 })!;
    expect(whole[0]).toBeGreaterThanOrEqual(viewBox[0]);
    expect(whole[1]).toBeGreaterThanOrEqual(viewBox[1]);
    expect(whole[2]).toBeLessThanOrEqual(viewBox[2]);
    expect(whole[3]).toBeLessThanOrEqual(viewBox[3]);
    whole.forEach((value, index) => expect(value).toBeCloseTo(viewBox[index]!));
    expect(
      pdfRegionFromPageFractions(viewport, viewBox, { x: 0.4, y: 0.2 }, { x: 0.4, y: 0.6 }),
    ).toBeNull();
  });
});
