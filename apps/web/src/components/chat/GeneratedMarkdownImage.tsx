// FILE: GeneratedMarkdownImage.tsx
// Purpose: Applies the central source policy and shared image frame to chat markdown.
// Layer: Web chat presentation component

import { useMemo } from "react";

import { ChatImageFrame } from "./ChatImageFrame";
import type { ExpandedImagePreview } from "./ExpandedImagePreview";
import { isSupportedChatImageSource, resolveMarkdownChatImageSource } from "./chatImageSource";

export interface GeneratedMarkdownImageProps {
  src: string;
  alt: string;
  cwd: string | undefined;
  onImageSettled?: (() => void) | undefined;
  onImageExpand?: ((preview: ExpandedImagePreview) => void) | undefined;
}

export function GeneratedMarkdownImage(props: GeneratedMarkdownImageProps) {
  const source = useMemo(
    () =>
      resolveMarkdownChatImageSource({
        src: props.src,
        alt: props.alt,
        cwd: props.cwd,
      }),
    [props.alt, props.cwd, props.src],
  );
  const accessibleName = props.alt.trim() || source.name || "Chat image";
  const onImageExpand = props.onImageExpand;
  return (
    <ChatImageFrame
      source={source}
      accessibleName={accessibleName}
      onSettled={props.onImageSettled}
      onActivate={
        onImageExpand
          ? (_source, trigger) => {
              if (!isSupportedChatImageSource(source)) return;
              onImageExpand({
                images: [{ src: source.previewUrl, source, name: source.name || accessibleName }],
                index: 0,
                returnFocus: trigger,
              });
            }
          : undefined
      }
    />
  );
}
