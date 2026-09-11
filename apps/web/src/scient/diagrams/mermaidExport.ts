import type { MermaidTheme } from "./mermaidRuntime";
import {
  downloadPresentationBlob,
  markdownFenceCopySource,
  presentationFileBaseName,
} from "../presentation/presentationExport";
import { copyPngBlobToClipboard } from "../presentation/imageClipboard";
import { loadCanvasImage } from "../presentation/loadCanvasImage";

const MAX_PNG_DIMENSION = 8_192;
const MAX_PNG_PIXELS = 16_777_216;
const DEFAULT_PNG_SCALE = 2;

export function diagramFileBaseName(title: string | null): string {
  return presentationFileBaseName(title, "diagram");
}

export function mermaidMarkdownCopySource(
  source: string,
  language: string,
  fenceMeta: string | undefined,
): string {
  return markdownFenceCopySource(source, language || "mermaid", fenceMeta);
}

export function prepareSvgForExport(svg: string, theme: MermaidTheme): string {
  // Mermaid returns sanitized HTML-compatible markup, not necessarily XML
  // (for example HTML <br> labels). Parse inertly as the card does, then let
  // the XML serializer preserve SVG/XHTML/MathML namespaces and escape text.
  const template = document.createElement("template");
  template.innerHTML = svg;
  const svgElement = template.content.firstElementChild;
  const svgNamespace = "http://www.w3.org/2000/svg";
  if (
    template.content.childElementCount !== 1 ||
    svgElement?.localName !== "svg" ||
    svgElement.namespaceURI !== svgNamespace
  ) {
    throw new Error("The rendered diagram is not an SVG image.");
  }
  svgElement.setAttributeNS("http://www.w3.org/2000/xmlns/", "xmlns", svgNamespace);
  svgElement.setAttributeNS(
    "http://www.w3.org/2000/xmlns/",
    "xmlns:xlink",
    "http://www.w3.org/1999/xlink",
  );
  const background = theme === "dark" ? "#171717" : "#ffffff";
  const style = document.createElementNS(svgNamespace, "style");
  style.textContent = `:root{color-scheme:${theme};}svg{background:${background};}`;
  svgElement.prepend(style);
  const prepared = new XMLSerializer().serializeToString(svgElement);
  if (new DOMParser().parseFromString(prepared, "image/svg+xml").querySelector("parsererror")) {
    throw new Error("The rendered diagram could not be serialized as SVG.");
  }
  return prepared;
}

function downloadBlob(blob: Blob, fileName: string): void {
  downloadPresentationBlob(blob, fileName);
}

export function downloadMermaidSvg(svg: string, title: string | null, theme: MermaidTheme): void {
  const prepared = prepareSvgForExport(svg, theme);
  downloadBlob(
    new Blob([prepared], { type: "image/svg+xml;charset=utf-8" }),
    `${diagramFileBaseName(title)}.svg`,
  );
}

function parseSvgDimensions(svgElement: Element): { width: number; height: number } | null {
  const viewBox = svgElement
    .getAttribute("viewBox")
    ?.trim()
    .split(/[\s,]+/)
    .map(Number);
  if (
    viewBox?.length === 4 &&
    viewBox.every(Number.isFinite) &&
    viewBox[2]! > 0 &&
    viewBox[3]! > 0
  ) {
    return { width: viewBox[2]!, height: viewBox[3]! };
  }

  const width = Number.parseFloat(svgElement.getAttribute("width") ?? "");
  const height = Number.parseFloat(svgElement.getAttribute("height") ?? "");
  return Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0
    ? { width, height }
    : null;
}

function canvasToPngBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob == null) {
        reject(new Error("The browser could not encode the diagram as PNG."));
        return;
      }
      resolve(blob);
    }, "image/png");
  });
}

async function mermaidSvgToPngBlob(svg: string, theme: MermaidTheme): Promise<Blob> {
  const prepared = prepareSvgForExport(svg, theme);
  const svgElement = new DOMParser().parseFromString(prepared, "image/svg+xml").documentElement;
  const dimensions = parseSvgDimensions(svgElement);
  // Give the rasterizer an intrinsic viewport, independent of the chat's CSS
  // or the browser's default size for SVGs with width="100%".
  if (dimensions != null) {
    svgElement.setAttribute("width", String(dimensions.width));
    svgElement.setAttribute("height", String(dimensions.height));
  }
  const image = await loadCanvasImage(
    new Blob([new XMLSerializer().serializeToString(svgElement)], {
      type: "image/svg+xml;charset=utf-8",
    }),
  );
  const sourceWidth = dimensions?.width ?? image.naturalWidth;
  const sourceHeight = dimensions?.height ?? image.naturalHeight;
  if (
    !Number.isFinite(sourceWidth) ||
    !Number.isFinite(sourceHeight) ||
    !(sourceWidth > 0 && sourceHeight > 0)
  ) {
    throw new Error("The rendered diagram has no measurable size.");
  }

  const scale = Math.min(
    DEFAULT_PNG_SCALE,
    MAX_PNG_DIMENSION / sourceWidth,
    MAX_PNG_DIMENSION / sourceHeight,
    Math.sqrt(MAX_PNG_PIXELS / (sourceWidth * sourceHeight)),
  );
  const width = Math.max(1, Math.round(sourceWidth * scale));
  const height = Math.max(1, Math.round(sourceHeight * scale));
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");
  if (context == null) {
    throw new Error("Canvas image export is unavailable.");
  }
  try {
    context.fillStyle = theme === "dark" ? "#171717" : "#ffffff";
    context.fillRect(0, 0, width, height);
    context.drawImage(image, 0, 0, width, height);
    return await canvasToPngBlob(canvas);
  } finally {
    canvas.width = 1;
    canvas.height = 1;
  }
}

export async function downloadMermaidPng(
  svg: string,
  title: string | null,
  theme: MermaidTheme,
): Promise<void> {
  const blob = await mermaidSvgToPngBlob(svg, theme);
  downloadBlob(blob, `${diagramFileBaseName(title)}.png`);
}

export async function copyMermaidPng(svg: string, theme: MermaidTheme): Promise<void> {
  const blob = await mermaidSvgToPngBlob(svg, theme);
  await copyPngBlobToClipboard(blob);
}
