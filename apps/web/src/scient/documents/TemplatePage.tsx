import { useLayoutEffect, useRef, useState } from "react";

import type { TemplatePicture } from "./templatePreviews";

/** Content edges as fractions of the page, used only to frame the small card. */
interface ContentBounds {
  readonly left: number;
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
}

/** Read the thumbnail once after loading; the page-number footer is outside the crop. */
function measureImage(image: HTMLImageElement): ContentBounds | null {
  if (!image.naturalWidth || !image.naturalHeight) return null;
  const canvas = document.createElement("canvas");
  canvas.width = Math.min(480, image.naturalWidth);
  canvas.height = Math.round((canvas.width * image.naturalHeight) / image.naturalWidth);
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) return null;
  try {
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    const { data } = context.getImageData(0, 0, canvas.width, canvas.height);
    let left = canvas.width;
    let top = canvas.height;
    let right = 0;
    let bottom = 0;
    for (let y = 0; y < canvas.height * 0.93; y++)
      for (let x = 0; x < canvas.width; x++) {
        const pixel = (y * canvas.width + x) * 4;
        if (
          data[pixel + 3]! > 16 &&
          Math.min(data[pixel]!, data[pixel + 1]!, data[pixel + 2]!) < 220
        ) {
          left = Math.min(left, x);
          top = Math.min(top, y);
          right = Math.max(right, x + 1);
          bottom = Math.max(bottom, y + 1);
        }
      }
    return right > left && bottom > top
      ? {
          left: left / canvas.width,
          top: top / canvas.height,
          right: right / canvas.width,
          bottom: bottom / canvas.height,
        }
      : null;
  } catch {
    return null;
  }
}

/** The content of a captured page, measured without changing its typesetting. */
function measureContent(root: HTMLElement, width: number, height: number) {
  const page = root.getBoundingClientRect();
  if (page.width === 0) return null;
  const scale = page.width / width;
  let left = 1;
  let top = 1;
  let right = 0;
  let bottom = 0;
  const include = (rect: DOMRect) => {
    if (rect.width === 0 || rect.height === 0) return;
    const x = (rect.left - page.left) / (width * scale);
    const y = (rect.top - page.top) / (height * scale);
    const xEnd = (rect.right - page.left) / (width * scale);
    const yEnd = (rect.bottom - page.top) / (height * scale);
    if (xEnd <= 0 || yEnd <= 0 || x >= 1 || y >= 1) return;
    left = Math.min(left, Math.max(0, x));
    top = Math.min(top, Math.max(0, y));
    right = Math.max(right, Math.min(1, xEnd));
    bottom = Math.max(bottom, Math.min(1, yEnd));
  };
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (!node.textContent?.trim()) continue;
    const range = document.createRange();
    range.selectNodeContents(node);
    for (const rect of range.getClientRects()) include(rect);
  }
  for (const figure of root.querySelectorAll("img, svg, canvas, hr"))
    include(figure.getBoundingClientRect());
  return right > left && bottom > top ? { left, top, right, bottom } : null;
}

/** The same read-only page, with closer framing on hover and full margins when expanded. */
export function TemplatePage(props: {
  readonly picture: TemplatePicture;
  readonly width: number;
  readonly cropped?: boolean;
}) {
  const { picture, width, cropped = false } = props;
  const capturedPage = useRef<HTMLDivElement | null>(null);
  const html = picture.kind === "page" ? picture.html : null;
  const cropScale = picture.kind === "image" ? (picture.cropScale ?? 1.25) : 1.25;
  const magnification = cropped ? cropScale * 1.1 : 1;
  const source =
    picture.kind === "image"
      ? cropped && cropScale <= 1.25
        ? picture.src
        : picture.expandedSrc
      : html!;
  const [measured, setMeasured] = useState<{
    source: string;
    bounds: ContentBounds;
  } | null>(null);
  const sourceWidth = picture.kind === "page" ? picture.width : 1;
  const sourceHeight = picture.kind === "page" ? picture.height : Math.SQRT2;
  useLayoutEffect(() => {
    if (!cropped || html === null || !capturedPage.current) return;
    const bounds = measureContent(capturedPage.current, sourceWidth, sourceHeight);
    if (bounds) setMeasured({ source: html, bounds });
  }, [cropped, html, sourceWidth, sourceHeight]);
  const bounds = measured?.source === source ? measured.bounds : null;
  const height = (width * sourceHeight) / sourceWidth;
  const scale =
    cropped && bounds
      ? Math.min(
          (width * magnification) / sourceWidth,
          Math.max(1, width - 16) / (sourceWidth * (bounds.right - bounds.left)),
          Math.max(1, height - 16) / (sourceHeight * (bounds.bottom - bounds.top)),
        )
      : (width * magnification) / sourceWidth;
  const pageWidth = sourceWidth * scale;
  const left =
    cropped && bounds
      ? width / 2 - pageWidth * ((bounds.left + bounds.right) / 2)
      : (width - pageWidth) / 2;
  const top = cropped
    ? bounds
      ? height / 2 - sourceHeight * scale * ((bounds.top + bounds.bottom) / 2)
      : 12 - sourceHeight * scale * (picture.kind === "image" ? picture.cropTop : 0.1)
    : 0;
  return (
    <div
      aria-hidden="true"
      inert
      className="pointer-events-none relative overflow-hidden bg-white"
      style={{ width, height: Math.round(height) }}
    >
      {picture.kind === "image" ? (
        <img
          // A closer crop of a sparse page needs its sharper image too.
          src={source}
          alt=""
          className="absolute block max-w-none"
          style={{ width: pageWidth, left, top }}
          draggable={false}
          onLoad={(event) => {
            if (!cropped) return;
            const bounds = measureImage(event.currentTarget);
            if (bounds) setMeasured({ source, bounds });
          }}
        />
      ) : (
        <div
          ref={capturedPage}
          onLoadCapture={() => {
            if (!cropped || html === null || !capturedPage.current) return;
            const bounds = measureContent(capturedPage.current, sourceWidth, sourceHeight);
            if (bounds) setMeasured({ source: html, bounds });
          }}
          className="absolute origin-top-left"
          style={{
            width: sourceWidth,
            left,
            top,
            transform: `scale(${scale})`,
          }}
          // Saved Visual pages are sanitized before they reach either preview.
          dangerouslySetInnerHTML={{ __html: picture.html }}
        />
      )}
    </div>
  );
}
