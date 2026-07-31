import { resolveAttachmentChatImageSource, type SupportedChatImageSource } from "./chatImageSource";

export interface ExpandedImageItem {
  /** Compatibility URL for non-chat preview consumers. Chat uses `source`. */
  src: string;
  source: SupportedChatImageSource;
  name: string;
}

export interface ExpandedImagePreview {
  images: ExpandedImageItem[];
  index: number;
}

export function buildExpandedImagePreview(
  images: ReadonlyArray<{ id: string; name: string; previewUrl?: string }>,
  selectedImageId: string,
): ExpandedImagePreview | null {
  const previewableImages = images.flatMap((image) => {
    if (!image.previewUrl) return [];
    const source = resolveAttachmentChatImageSource({
      previewUrl: image.previewUrl,
      name: image.name,
      allowTrustedBlob: true,
    });
    return source.kind === "unsupported"
      ? []
      : [{ id: image.id, src: image.previewUrl, name: image.name, source }];
  });
  if (previewableImages.length === 0) {
    return null;
  }
  const selectedIndex = previewableImages.findIndex((image) => image.id === selectedImageId);
  if (selectedIndex < 0) {
    return null;
  }
  return {
    images: previewableImages.map((image) => ({
      src: image.src,
      source: image.source,
      name: image.name,
    })),
    index: selectedIndex,
  };
}

export function wrappedExpandedImageIndex(input: {
  readonly index: number;
  readonly imageCount: number;
  readonly direction: -1 | 1;
}): number {
  if (input.imageCount <= 1) return Math.max(0, input.index);
  return (input.index + input.direction + input.imageCount) % input.imageCount;
}
