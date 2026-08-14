import type { MermaidTheme } from "./mermaidRuntime";

const MAX_PNG_DIMENSION = 8_192;
const MAX_PNG_PIXELS = 16_777_216;
const DEFAULT_PNG_SCALE = 2;

export function diagramFileBaseName(title: string | null): string {
  const withoutExtension = title?.replace(/\.[^.]+$/, "") ?? "diagram";
  const slug = withoutExtension
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^\p{L}\p{N}._-]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  return slug || "diagram";
}

export function mermaidMarkdownCopySource(
  source: string,
  language: string,
  fenceMeta: string | undefined,
): string {
  const info = [language || "mermaid", fenceMeta?.trim()].filter(Boolean).join(" ");
  const longestRun = [...(source.match(/`{3,}/g) ?? [])].reduce(
    (maximum, run) => Math.max(maximum, run.length),
    0,
  );
  const fence = "`".repeat(Math.max(3, longestRun + 1));
  return `${fence}${info}\n${source.replace(/\n+$/, "")}\n${fence}\n\n`;
}

export function prepareSvgForExport(svg: string, theme: MermaidTheme): string {
  const background = theme === "dark" ? "#171717" : "#ffffff";
  let prepared = svg;
  if (!/\bxmlns=/.test(prepared)) {
    prepared = prepared.replace("<svg", '<svg xmlns="http://www.w3.org/2000/svg"');
  }
  if (!/\bxmlns:xlink=/.test(prepared)) {
    prepared = prepared.replace("<svg", '<svg xmlns:xlink="http://www.w3.org/1999/xlink"');
  }
  return prepared.replace(
    /(<svg\b[^>]*>)/,
    `$1<style>:root{color-scheme:${theme};}svg{background:${background};}</style>`,
  );
}

export function downloadBlob(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = fileName;
  anchor.rel = "noopener";
  anchor.style.display = "none";
  try {
    document.body.append(anchor);
    anchor.click();
  } finally {
    anchor.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1_000);
  }
}

export function downloadMermaidSvg(svg: string, title: string | null, theme: MermaidTheme): void {
  const prepared = prepareSvgForExport(svg, theme);
  downloadBlob(
    new Blob([prepared], { type: "image/svg+xml;charset=utf-8" }),
    `${diagramFileBaseName(title)}.svg`,
  );
}

function parseSvgDimensions(svg: string): { width: number; height: number } | null {
  const documentNode = new DOMParser().parseFromString(svg, "image/svg+xml");
  const svgElement = documentNode.documentElement;
  if (svgElement.tagName.toLowerCase() !== "svg") return null;

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

function loadSvgImage(svg: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const blobUrl = URL.createObjectURL(new Blob([svg], { type: "image/svg+xml;charset=utf-8" }));
    const image = new Image();
    image.decoding = "async";
    image.addEventListener(
      "load",
      () => {
        URL.revokeObjectURL(blobUrl);
        resolve(image);
      },
      { once: true },
    );
    image.addEventListener(
      "error",
      () => {
        URL.revokeObjectURL(blobUrl);
        reject(new Error("The rendered diagram could not be converted to an image."));
      },
      { once: true },
    );
    image.src = blobUrl;
  });
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

export async function mermaidSvgToPngBlob(svg: string, theme: MermaidTheme): Promise<Blob> {
  const prepared = prepareSvgForExport(svg, theme);
  const dimensions = parseSvgDimensions(prepared);
  const image = await loadSvgImage(prepared);
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
  if (typeof ClipboardItem === "undefined" || navigator.clipboard?.write == null) {
    throw new Error("Copy image is unavailable in this environment.");
  }
  const blob = await mermaidSvgToPngBlob(svg, theme);
  await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
}
