import { describe, expect, it } from "vitest";

import {
  resolveAttachmentChatImageSource,
  resolveMarkdownChatImageSource,
} from "./chatImageSource";

describe("chat image source policy", () => {
  it("preserves trusted attachment URLs without reclassifying them", () => {
    expect(
      resolveAttachmentChatImageSource({
        previewUrl: "/attachments/generated-1",
        name: "capture.png",
      }),
    ).toEqual({
      kind: "attachment",
      previewUrl: "/attachments/generated-1",
      downloadUrl: "/attachments/generated-1",
      name: "capture.png",
    });
  });

  it.each(["javascript:alert(1)", "data:image/png;base64,abc", "blob:unowned"])(
    "rejects untrusted attachment URL %s",
    (previewUrl) => {
      expect(resolveAttachmentChatImageSource({ previewUrl, name: "Image" })).toEqual({
        kind: "unsupported",
        name: "Image",
      });
    },
  );

  it("allows a blob URL only through the explicit trusted composer path", () => {
    expect(
      resolveAttachmentChatImageSource({
        previewUrl: "blob:https://scient.local/owned",
        name: "Draft.png",
        allowTrustedBlob: true,
      }),
    ).toMatchObject({ kind: "attachment", previewUrl: "blob:https://scient.local/owned" });
  });

  it("routes local paths through the existing authenticated resolver", () => {
    expect(
      resolveMarkdownChatImageSource({
        src: "/tmp/generated image.png",
        alt: "Capture",
        cwd: "/workspace",
      }),
    ).toEqual({
      kind: "local",
      previewUrl: "/api/local-image?path=%2Ftmp%2Fgenerated+image.png&cwd=%2Fworkspace",
      downloadUrl: "/api/local-image?path=%2Ftmp%2Fgenerated+image.png&cwd=%2Fworkspace&download=1",
      name: "generated image.png",
    });
  });

  it.each([
    "data:image/png;base64,abc",
    "blob:https://example.com/id",
    "javascript:alert(1)",
    "sandbox:/tmp/capture.png",
    "custom://example.com/capture.png",
    "//example.com/capture.png",
    "https://user:secret@example.com/capture.png",
    "https://example.com/bad%capture.png",
    "not a valid url.png?%",
  ])("rejects unsupported or ambiguous source %s without proxying it", (src) => {
    const source = resolveMarkdownChatImageSource({ src, alt: "Unsafe", cwd: "/workspace" });
    expect(source).toEqual({ kind: "unsupported", name: "Unsafe" });
    expect(JSON.stringify(source)).not.toContain("/api/local-image");
  });

  it.each([
    ["https://example.com/capture.png", "https://example.com/capture.png"],
    ["http://cdn.example.com/a.webp?size=2", "http://cdn.example.com/a.webp?size=2"],
  ])("accepts only absolute credential-free HTTP image sources", (src, expected) => {
    expect(resolveMarkdownChatImageSource({ src, alt: "Remote", cwd: undefined })).toEqual({
      kind: "remote",
      previewUrl: expected,
      openUrl: expected,
      name: "Remote",
    });
  });
});
