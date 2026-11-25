import { describe, expect, it } from "vite-plus/test";

import { pdfPageImageCoverage, type PdfImageOps } from "./pdfOcrPageImage";

const ops: PdfImageOps = {
  save: 10,
  restore: 11,
  transform: 12,
  paintFormXObjectBegin: 74,
  paintFormXObjectEnd: 75,
  paintImageXObject: 85,
  paintInlineImageXObject: 86,
  paintImageMaskXObject: 83,
  paintSolidColorImageMask: 90,
  paintImageXObjectRepeat: 88,
};
const AREA = 612 * 792;

describe("page image coverage", () => {
  it("measures what images paint under the current transform", () => {
    // A scanner's page: one image drawn over the whole page.
    expect(
      pdfPageImageCoverage(
        {
          fnArray: [ops.save, ops.transform, ops.paintImageXObject, ops.restore],
          argsArray: [[], [612, 0, 0, 792, 0, 0], ["img_p0_1"], []],
        },
        ops,
        AREA,
      ),
    ).toBeCloseTo(1);
    // A small figure inside a form, then a transform undone by restore.
    expect(
      pdfPageImageCoverage(
        {
          fnArray: [
            ops.save,
            ops.transform,
            ops.paintFormXObjectBegin,
            ops.paintImageXObject,
            ops.paintFormXObjectEnd,
            ops.restore,
            ops.paintImageXObject,
          ],
          argsArray: [
            [],
            [2, 0, 0, 2, 0, 0],
            [[50, 0, 0, 50, 10, 10], null],
            ["img"],
            [],
            [],
            ["img"],
          ],
        },
        ops,
        AREA,
      ),
    ).toBeCloseTo((100 * 100 + 1) / AREA);
    // Strips of one repeated image add up.
    expect(
      pdfPageImageCoverage(
        {
          fnArray: [ops.paintImageXObjectRepeat],
          argsArray: [["img", 612, 79.2, [0, 0, 0, 79.2, 0, 158.4, 0, 237.6, 0, 316.8]]],
        },
        ops,
        AREA,
      ),
    ).toBeCloseTo(0.5);
  });
});
