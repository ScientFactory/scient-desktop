// FILE: ChatImageAttachmentGallery.tsx
// Purpose: Role-neutral durable chat attachment gallery and preview grouping.
// Layer: Web chat presentation component

import { memo, useEffect, useMemo, useState } from "react";

import { ChatImageFrame } from "./ChatImageFrame";
import type { ExpandedImagePreview } from "./ExpandedImagePreview";
import {
  chatImageSourceKey,
  isSupportedChatImageSource,
  resolveAttachmentChatImageSource,
} from "./chatImageSource";

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
  /** Blob URLs are accepted only while an app-owned user preview capability is live. */
  readonly trustContext?: "durable" | "owned-user-preview";
}) {
  const [downloadError, setDownloadError] = useState<{
    readonly itemId: string;
    readonly sourceKey: string;
    readonly name: string;
    readonly message: string;
  } | null>(null);
  const previewItems = useMemo(
    () =>
      props.images.map((image) => ({
        id: image.id,
        name: image.name,
        source: resolveAttachmentChatImageSource({
          ...image,
          allowTrustedBlob: props.trustContext === "owned-user-preview",
        }),
      })),
    [props.images, props.trustContext],
  );
  useEffect(() => {
    setDownloadError((current) =>
      current &&
      !previewItems.some(
        (item) =>
          item.id === current.itemId && chatImageSourceKey(item.source) === current.sourceKey,
      )
        ? null
        : current,
    );
  }, [previewItems]);
  const visibleDownloadError =
    downloadError &&
    previewItems.some(
      (item) =>
        item.id === downloadError.itemId &&
        chatImageSourceKey(item.source) === downloadError.sourceKey,
    )
      ? downloadError
      : null;

  return (
    <div
      className={`max-w-[240px] ${props.align === "end" ? "self-end" : ""} ${props.hasFollowingText ? "mb-1" : ""}`}
      data-chat-image-gallery="true"
    >
      <div
        className={`flex flex-wrap gap-2 ${props.align === "end" ? "justify-end" : "justify-start"}`}
      >
        {previewItems.map((item) => (
          <ChatImageFrame
            key={item.id}
            source={item.source}
            accessibleName={item.name}
            display="thumbnail"
            onSettled={props.onImageSettled}
            onActionError={(message) => {
              if (!message) {
                setDownloadError(null);
                return;
              }
              setDownloadError({
                itemId: item.id,
                sourceKey: chatImageSourceKey(item.source),
                name: item.name,
                message,
              });
              props.onImageSettled?.();
            }}
            onActivate={(_source, trigger) => {
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
                returnFocus: trigger,
              });
            }}
          />
        ))}
      </div>
      {visibleDownloadError ? (
        <p
          className="mt-1 min-w-0 max-w-[240px] text-xs text-destructive [overflow-wrap:anywhere]"
          role="alert"
        >
          Could not download {visibleDownloadError.name}: {visibleDownloadError.message}
        </p>
      ) : null}
    </div>
  );
});
