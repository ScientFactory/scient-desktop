import { describe, expect, it } from "vite-plus/test";

import { restoreQueuedImages } from "./queueImageRestore";

const pngDataUrl = `data:image/png;base64,${btoa("fake-png-bytes")}`;

describe("restoreQueuedImages", () => {
  it("rebuilds composer images from stored upload attachments", async () => {
    const restored = await restoreQueuedImages([
      {
        type: "image",
        name: "shot.png",
        mimeType: "image/png",
        sizeBytes: 14,
        dataUrl: pngDataUrl,
      },
    ]);
    expect(restored).toHaveLength(1);
    const image = restored[0]!;
    expect(image.name).toBe("shot.png");
    expect(image.mimeType).toBe("image/png");
    expect(image.sizeBytes).toBe(14);
    expect(image.id).toMatch(/^queued_[A-Za-z0-9-]+$/u);
    expect(image.previewUrl).toBeTruthy();
    expect(image.file.size).toBe(14);
  });

  it("skips malformed data URLs instead of failing the edit", async () => {
    const restored = await restoreQueuedImages([
      { type: "image", name: "bad.png", mimeType: "image/png", sizeBytes: 1, dataUrl: "nope" },
      { type: "image", name: "ok.png", mimeType: "image/png", sizeBytes: 14, dataUrl: pngDataUrl },
    ]);
    expect(restored.map((image) => image.name)).toEqual(["ok.png"]);
  });
});
