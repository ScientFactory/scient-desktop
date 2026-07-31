// FILE: ChatImageAttachmentGallery.tsx
// Purpose: Role-neutral durable chat attachment gallery and preview grouping.
// Layer: Web chat presentation component

import { memo, useMemo } from "react";

import { ChatImageFrame } from "./ChatImageFrame";
import type { ExpandedImagePreview } from "./ExpandedImagePreview";
import { isSupportedChatImageSource, resolveAttachmentChatImageSource } from "./chatImageSource";

export interface ChatImageAttachmentItem {
  readonly id: string;
  readonly name: string;
  readonly previewUrl?: string | undefined;
}

export const ChatImageAttachmentGallery = memo(function ChatImageAttachmentGallery(props: {
  readonly images: readonly ChatImageAttachmentItem[];
  readonly onImageExpand: (preview: ExpandedImagePreview) => void;
  readonly onImageSettled?: (() => void) | undefined;
  readonly align?: "start" | "end";
  readonly hasFollowingText?: boolean;
}) {
  const previewItems = useMemo(
    () =>
      props.images.map((image) => ({
        id: image.id,
        name: image.name,
        source: resolveAttachmentChatImageSource(image),
      })),
    [props.images],
  );

  return (
    <div
      className={`flex max-w-[240px] flex-wrap gap-2 ${props.align === "end" ? "justify-end self-end" : "justify-start"} ${props.hasFollowingText ? "mb-1" : ""}`}
      data-chat-image-gallery="true"
    >
      {previewItems.map((item) => (
        <ChatImageFrame
          key={item.id}
          source={item.source}
          accessibleName={item.name}
          display="thumbnail"
          onSettled={props.onImageSettled}
          onActivate={() => {
            if (!isSupportedChatImageSource(item.source)) return;
            const supportedItems = previewItems.flatMap((candidate) =>
              isSupportedChatImageSource(candidate.source)
                ? [{ ...candidate, source: candidate.source }]
                : [],
            );
            const supportedIndex = supportedItems.findIndex(
              (candidate) => candidate.id === item.id,
            );
            if (supportedIndex < 0) return;
            props.onImageExpand({
              images: supportedItems.map((candidate) => ({
                src: candidate.source.previewUrl,
                source: candidate.source,
                name: candidate.name,
              })),
              index: supportedIndex,
            });
          }}
        />
      ))}
    </div>
  );
});
