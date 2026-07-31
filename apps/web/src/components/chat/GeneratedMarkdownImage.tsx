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
  linkedHref?: string | undefined;
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
  return (
    <ChatImageFrame
      source={source}
      accessibleName={accessibleName}
      linkedHref={props.linkedHref}
      onSettled={props.onImageSettled}
      onActivate={() => {
        if (!isSupportedChatImageSource(source)) return;
        props.onImageExpand?.({
          images: [{ src: source.previewUrl, source, name: source.name || accessibleName }],
          index: 0,
        });
      }}
    />
  );
}
