/** A page mostly covered by images, with this share of its area or more, can be a scan. */
export const PDF_SCAN_IMAGE_COVERAGE = 0.5;

/** The PDF.js operator codes the coverage reads (`OPS` from pdfjs-dist). */
export interface PdfImageOps {
  readonly save: number;
  readonly restore: number;
  readonly transform: number;
  readonly paintFormXObjectBegin: number;
  readonly paintFormXObjectEnd: number;
  readonly paintImageXObject: number;
  readonly paintInlineImageXObject: number;
  readonly paintImageMaskXObject: number;
  readonly paintSolidColorImageMask: number;
  readonly paintImageXObjectRepeat: number;
}

type Matrix = readonly [number, number, number, number, number, number];
const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0];

function multiply(m: Matrix, n: ReadonlyArray<unknown>): Matrix {
  const [a, b, c, d, e, f] = n.map(Number) as unknown as Matrix;
  if (![a, b, c, d, e, f].every(Number.isFinite)) return m;
  return [
    m[0] * a + m[2] * b,
    m[1] * a + m[3] * b,
    m[0] * c + m[2] * d,
    m[1] * c + m[3] * d,
    m[0] * e + m[2] * f + m[4],
    m[1] * e + m[3] * f + m[5],
  ];
}

/**
 * The share of the page area that images paint, from its operator list: each image fills
 * the unit square under the current transform. Overlaps count twice, which only matters for
 * pages already well covered; clipping is ignored.
 */
export function pdfPageImageCoverage(
  operators: { readonly fnArray: ArrayLike<number>; readonly argsArray: ArrayLike<unknown> },
  ops: PdfImageOps,
  pageArea: number,
): number {
  if (!(pageArea > 0)) return 0;
  let matrix = IDENTITY;
  const saved: Matrix[] = [];
  let area = 0;
  for (let index = 0; index < operators.fnArray.length; index += 1) {
    const op = operators.fnArray[index];
    const args = (operators.argsArray[index] ?? []) as ReadonlyArray<unknown>;
    const unitArea = () => Math.abs(matrix[0] * matrix[3] - matrix[1] * matrix[2]);
    switch (op) {
      case ops.save:
        saved.push(matrix);
        break;
      case ops.restore:
        matrix = saved.pop() ?? IDENTITY;
        break;
      case ops.transform:
        matrix = multiply(matrix, args);
        break;
      case ops.paintFormXObjectBegin:
        saved.push(matrix);
        if (Array.isArray(args[0])) matrix = multiply(matrix, args[0]);
        break;
      case ops.paintFormXObjectEnd:
        matrix = saved.pop() ?? IDENTITY;
        break;
      case ops.paintImageXObject:
      case ops.paintInlineImageXObject:
      case ops.paintImageMaskXObject:
      case ops.paintSolidColorImageMask:
        area += unitArea();
        break;
      case ops.paintImageXObjectRepeat: {
        const scaleX = Number(args[1]);
        const scaleY = Number(args[2]);
        const positions = args[3] as ArrayLike<number> | undefined;
        if (Number.isFinite(scaleX) && Number.isFinite(scaleY) && positions) {
          area += Math.abs(scaleX * scaleY) * unitArea() * Math.floor(positions.length / 2);
        }
        break;
      }
    }
  }
  return area / pageArea;
}
