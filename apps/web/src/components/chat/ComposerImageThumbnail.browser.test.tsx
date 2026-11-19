import "../../index.css";

import { expect, it, vi } from "vite-plus/test";

import { act, render } from "../../../test/render";
import { createComposerImageThumbnail } from "../../lib/imageCompression";
import { ComposerImageThumbnail } from "./ComposerImageThumbnail";

function previewEdges(image: HTMLImageElement) {
  const canvas = document.createElement("canvas");
  canvas.width = image.naturalWidth;
  canvas.height = image.naturalHeight;
  const context = canvas.getContext("2d")!;
  context.drawImage(image, 0, 0);
  const sample = (x: number) =>
    Array.from(context.getImageData(x, Math.floor(canvas.height / 2), 1, 1).data);
  return [sample(0), sample(Math.floor(canvas.width / 2)), sample(canvas.width - 1)];
}

it("keeps both screenshot edges visible after switching from a cached square preview", async () => {
  const source = document.createElement("canvas");
  source.width = 960;
  source.height = 400;
  const context = source.getContext("2d")!;
  context.fillStyle = "#00ff00";
  context.fillRect(0, 0, 960, 400);
  context.fillStyle = "#ff0000";
  context.fillRect(0, 0, 160, 400);
  context.fillStyle = "#0000ff";
  context.fillRect(800, 0, 160, 400);
  const blob = await new Promise<Blob>((resolve, reject) =>
    source.toBlob((value) => (value ? resolve(value) : reject(new Error("PNG encoding failed")))),
  );
  const file = new File([blob], "window.png", { type: "image/png" });
  const preview = (mode: "square" | "snapshot") => (
    <div style={{ width: 208, height: 112 }}>
      <ComposerImageThumbnail
        file={file}
        mode={mode}
        alt="Window snapshot"
        className="h-full w-full"
        fallback={<span>Preparing preview</span>}
      />
    </div>
  );
  await using screen = await render(preview("square"), { router: false });
  const squareResult = await act(() => createComposerImageThumbnail(file, "square"));
  expect(squareResult).not.toBeNull();
  // The local preview shows first, then the thumbnail replaces it once decoded.
  await expect.poll(() => screen.container.querySelector("img")?.src).toBe(squareResult);
  const square = screen.container.querySelector("img")!;
  await square.decode();
  const squareSrc = square.src;
  expect([square.naturalWidth, square.naturalHeight]).toEqual([256, 256]);
  expect(previewEdges(square)).toEqual([
    [0, 255, 0, 255],
    [0, 255, 0, 255],
    [0, 255, 0, 255],
  ]);
  expect(getComputedStyle(square).objectFit).toBe("cover");

  await screen.rerender(preview("snapshot"));
  const snapshotResult = await act(() => createComposerImageThumbnail(file, "snapshot"));
  expect(snapshotResult).not.toBeNull();
  await expect.poll(() => screen.container.querySelector("img")?.src).toBe(snapshotResult);
  const snapshot = screen.container.querySelector("img")!;
  await snapshot.decode();
  expect([snapshot.naturalWidth, snapshot.naturalHeight]).toEqual([832, 347]);
  expect(previewEdges(snapshot)).toEqual([
    [255, 0, 0, 255],
    [0, 255, 0, 255],
    [0, 0, 255, 255],
  ]);
  expect(getComputedStyle(snapshot).objectFit).toBe("contain");

  await screen.rerender(preview("square"));
  await expect.element(screen.getByRole("img", { name: "Window snapshot" })).toBeVisible();
  const restoredSquare = screen.container.querySelector("img")!;
  expect(restoredSquare.src).toBe(squareSrc);
  expect(getComputedStyle(restoredSquare).objectFit).toBe("cover");
});

it("keeps a native preview available after thumbnail generation has failed", async () => {
  const canvas = document.createElement("canvas");
  canvas.width = 2;
  canvas.height = 2;
  const blob = await new Promise<Blob>((resolve) => canvas.toBlob((blob) => resolve(blob!)));
  const file = new File([blob], "screenshot.png", { type: "image/png" });
  using _bitmap = vi
    .spyOn(window, "createImageBitmap")
    .mockRejectedValue(new Error("Thumbnail decoder unavailable"));
  expect(await createComposerImageThumbnail(file)).toBeNull();

  const container = document.createElement("div");
  const holdLoad = (event: Event) => event.stopPropagation();
  container.addEventListener("load", holdLoad, true);
  using complete = vi.spyOn(HTMLImageElement.prototype, "complete", "get").mockReturnValue(false);
  await using screen = await render(
    <ComposerImageThumbnail
      file={file}
      alt={file.name}
      className="size-16 object-cover"
      fallback={<span>Preview unavailable</span>}
    />,
    { container },
  );
  using revoke = vi.spyOn(URL, "revokeObjectURL");
  await expect.element(screen.getByText("Preview unavailable")).toBeVisible();
  const loadingImage = screen.container.querySelector("img")!;
  await loadingImage.decode();
  complete.mockRestore();
  container.removeEventListener("load", holdLoad, true);
  await act(() => loadingImage.dispatchEvent(new Event("load")));
  const image = screen.getByRole("img", { name: file.name });
  await expect.element(image).toBeVisible();
  await expect.element(screen.getByText("Preview unavailable")).not.toBeInTheDocument();
  const src = image.element().getAttribute("src");
  expect(src).toMatch(/^blob:/);
  await screen.unmount();
  expect(revoke).toHaveBeenCalledWith(src);
});

it("shows the fallback while HEIC preparation is pending", async () => {
  let finishReading!: (bytes: ArrayBuffer) => void;
  const metadata = new Promise<ArrayBuffer>((resolve) => {
    finishReading = resolve;
  });
  using _read = vi.spyOn(Blob.prototype, "arrayBuffer").mockReturnValue(metadata);
  const file = new File(["pending"], "photo.heic", { type: "image/heic" });

  await using screen = await render(
    <ComposerImageThumbnail
      file={file}
      alt={file.name}
      className="size-16 object-cover"
      fallback={<span role="img" aria-label="Preparing image" />}
    />,
  );
  try {
    expect(screen.container.querySelector('[aria-label="Preparing image"]')).not.toBeNull();
  } finally {
    finishReading(new ArrayBuffer(0));
    await createComposerImageThumbnail(file);
  }
});
