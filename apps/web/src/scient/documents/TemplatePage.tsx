import type { TemplatePicture } from "./templatePreviews";

/** The same read-only page, with closer framing on hover and full margins when expanded. */
export function TemplatePage(props: {
  readonly picture: TemplatePicture;
  readonly width: number;
  readonly cropped?: boolean;
}) {
  const { picture, width, cropped = false } = props;
  const sourceWidth = picture.kind === "page" ? picture.width : 1;
  const sourceHeight = picture.kind === "page" ? picture.height : Math.SQRT2;
  const magnification = cropped
    ? picture.kind === "image"
      ? (picture.cropScale ?? 1.25)
      : 1.25
    : 1;
  const pageWidth = width * magnification;
  const scale = pageWidth / sourceWidth;
  const height = (width * sourceHeight) / sourceWidth;
  const top = cropped
    ? 12 - sourceHeight * scale * (picture.kind === "image" ? picture.cropTop : 0.1)
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
          src={cropped && magnification <= 1.25 ? picture.src : picture.expandedSrc}
          alt=""
          className="absolute block max-w-none"
          style={{ width: pageWidth, left: (width - pageWidth) / 2, top }}
          draggable={false}
        />
      ) : (
        <div
          className="absolute origin-top-left"
          style={{
            width: sourceWidth,
            left: (width - pageWidth) / 2,
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
