function svgDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener(
      "load",
      () => {
        if (typeof reader.result === "string") resolve(reader.result);
        else reject(new Error("The browser could not read the SVG image."));
      },
      { once: true },
    );
    reader.addEventListener(
      "error",
      () => reject(new Error("The browser could not read the SVG image.")),
      { once: true },
    );
    reader.addEventListener(
      "abort",
      () => reject(new Error("Reading the SVG image was cancelled.")),
      { once: true },
    );
    reader.readAsDataURL(blob);
  });
}

/** Decode already-fetched bytes in the browser's non-interactive image context. */
export async function loadCanvasImage(blob: Blob): Promise<HTMLImageElement> {
  // Chromium/WebKit can taint canvases for blob-backed SVG with foreignObject.
  // A self-contained data URL supports HTML labels without weakening image
  // security or fetching their external resources. Keep raster images on blobs.
  const isSvg = blob.type.split(";", 1)[0]?.trim().toLowerCase() === "image/svg+xml";
  const objectUrl = isSvg ? null : URL.createObjectURL(blob);
  try {
    const url = objectUrl ?? (await svgDataUrl(blob));
    const image = new Image();
    image.decoding = "async";
    await new Promise<void>((resolve, reject) => {
      image.addEventListener("load", () => resolve(), { once: true });
      image.addEventListener(
        "error",
        () => reject(new Error("The browser could not decode the image.")),
        { once: true },
      );
      image.src = url;
    });
    return image;
  } finally {
    if (objectUrl != null) URL.revokeObjectURL(objectUrl);
  }
}
