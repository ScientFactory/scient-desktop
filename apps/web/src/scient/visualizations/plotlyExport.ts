import {
  downloadPresentationBlob,
  markdownFenceCopySource,
  presentationFileBaseName,
} from "../presentation/presentationExport";
import type { PlotlyViewController } from "./PlotlyView";

const MAX_PNG_DIMENSION = 8_192;
const MAX_PNG_PIXELS = 16_777_216;
const DEFAULT_PNG_SCALE = 2;

export function plotlyFileBaseName(title: string | null): string {
  const normalizedTitle = title?.replace(/(?:\.plotly)?\.json$/i, "") ?? null;
  return presentationFileBaseName(normalizedTitle, "plotly-chart");
}

export function plotlyMarkdownCopySource(
  source: string,
  language: string,
  fenceMeta: string | undefined,
): string {
  return markdownFenceCopySource(source, language || "plotly", fenceMeta);
}

export function downloadPlotlySource(source: string, title: string | null): void {
  downloadPresentationBlob(
    new Blob([source], { type: "application/json;charset=utf-8" }),
    `${plotlyFileBaseName(title)}.plotly.json`,
  );
}

export function plotlyPngScale(sourceWidth: number, sourceHeight: number): number {
  if (!(sourceWidth > 0 && sourceHeight > 0)) {
    throw new Error("The rendered Plotly figure has no measurable size.");
  }
  return Math.min(
    DEFAULT_PNG_SCALE,
    MAX_PNG_DIMENSION / sourceWidth,
    MAX_PNG_DIMENSION / sourceHeight,
    Math.sqrt(MAX_PNG_PIXELS / (sourceWidth * sourceHeight)),
  );
}

function decodeDataUrl(dataUrl: string, expectedType: string): Blob {
  if (!dataUrl.startsWith("data:")) throw new Error("Plotly returned an invalid image URL.");
  const separator = dataUrl.indexOf(",");
  if (separator < 0) throw new Error("Plotly returned an invalid image URL.");
  const metadata = dataUrl.slice(5, separator);
  const [mimeType = "", ...parameters] = metadata.split(";");
  if (mimeType.toLowerCase() !== expectedType) {
    throw new Error(`Plotly returned '${mimeType || "unknown"}' instead of '${expectedType}'.`);
  }
  const encoded = dataUrl.slice(separator + 1);
  if (parameters.some((parameter) => parameter.toLowerCase() === "base64")) {
    const binary = atob(encoded);
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    return new Blob([bytes], { type: expectedType });
  }
  return new Blob([decodeURIComponent(encoded)], { type: expectedType });
}

export async function plotlyPngBlob(controller: PlotlyViewController): Promise<Blob> {
  const dimensions = controller.getDimensions();
  const scale = plotlyPngScale(dimensions.width, dimensions.height);
  return decodeDataUrl(await controller.toImage("png", scale), "image/png");
}

export async function plotlySvgBlob(controller: PlotlyViewController): Promise<Blob> {
  return decodeDataUrl(await controller.toImage("svg", 1), "image/svg+xml");
}

export async function downloadPlotlyPng(
  controller: PlotlyViewController,
  title: string | null,
): Promise<void> {
  downloadPresentationBlob(await plotlyPngBlob(controller), `${plotlyFileBaseName(title)}.png`);
}

export async function downloadPlotlySvg(
  controller: PlotlyViewController,
  title: string | null,
): Promise<void> {
  downloadPresentationBlob(await plotlySvgBlob(controller), `${plotlyFileBaseName(title)}.svg`);
}

export async function copyPlotlyPng(controller: PlotlyViewController): Promise<void> {
  if (typeof ClipboardItem === "undefined" || navigator.clipboard?.write == null) {
    throw new Error("Copy image is unavailable in this environment.");
  }
  const blob = await plotlyPngBlob(controller);
  await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
}
