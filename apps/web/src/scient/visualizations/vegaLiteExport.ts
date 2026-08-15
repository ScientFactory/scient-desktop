import {
  downloadPresentationBlob,
  markdownFenceCopySource,
  presentationFileBaseName,
} from "../presentation/presentationExport";
import type { VegaLiteViewController } from "./VegaLiteView";

const MAX_PNG_DIMENSION = 8_192;
const MAX_PNG_PIXELS = 16_777_216;
const DEFAULT_PNG_SCALE = 2;

export function vegaLiteFileBaseName(title: string | null): string {
  const normalizedTitle = title?.replace(/(?:\.vega-?lite|\.vl)?\.json$/i, "") ?? null;
  return presentationFileBaseName(normalizedTitle, "chart");
}

export function vegaLiteMarkdownCopySource(
  source: string,
  language: string,
  fenceMeta: string | undefined,
): string {
  return markdownFenceCopySource(source, language || "vega-lite", fenceMeta);
}

export function downloadVegaLiteSource(source: string, title: string | null): void {
  downloadPresentationBlob(
    new Blob([source], { type: "application/json;charset=utf-8" }),
    `${vegaLiteFileBaseName(title)}.vl.json`,
  );
}

export async function downloadVegaLiteSvg(
  controller: VegaLiteViewController,
  title: string | null,
): Promise<void> {
  const svg = await controller.toSvg();
  downloadPresentationBlob(
    new Blob([svg], { type: "image/svg+xml;charset=utf-8" }),
    `${vegaLiteFileBaseName(title)}.svg`,
  );
}

export function vegaLitePngScale(sourceWidth: number, sourceHeight: number): number {
  if (!(sourceWidth > 0 && sourceHeight > 0)) {
    throw new Error("The rendered chart has no measurable size.");
  }
  return Math.min(
    DEFAULT_PNG_SCALE,
    MAX_PNG_DIMENSION / sourceWidth,
    MAX_PNG_DIMENSION / sourceHeight,
    Math.sqrt(MAX_PNG_PIXELS / (sourceWidth * sourceHeight)),
  );
}

function canvasToPngBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob == null) {
        reject(new Error("The browser could not encode the chart as a PNG image."));
        return;
      }
      resolve(blob);
    }, "image/png");
  });
}

export async function vegaLitePngBlob(controller: VegaLiteViewController): Promise<Blob> {
  const dimensions = controller.getDimensions();
  const scale = vegaLitePngScale(dimensions.width, dimensions.height);
  const canvas = await controller.toCanvas(scale);
  try {
    return await canvasToPngBlob(canvas);
  } finally {
    canvas.width = 1;
    canvas.height = 1;
  }
}

export async function downloadVegaLitePng(
  controller: VegaLiteViewController,
  title: string | null,
): Promise<void> {
  const blob = await vegaLitePngBlob(controller);
  downloadPresentationBlob(blob, `${vegaLiteFileBaseName(title)}.png`);
}

export async function copyVegaLitePng(controller: VegaLiteViewController): Promise<void> {
  if (typeof ClipboardItem === "undefined" || navigator.clipboard?.write == null) {
    throw new Error("Copy image is unavailable in this environment.");
  }
  const blob = await vegaLitePngBlob(controller);
  await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
}
