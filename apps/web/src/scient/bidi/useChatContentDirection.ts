import type { MessageId } from "@t3tools/contracts";
import { useRef } from "react";

import { useContentDirection } from "./ContentDirectionScope";
import {
  resolveStreamingMarkdownDirection,
  type ContentDirection,
  type FixedContentDirection,
} from "./contentDirection";

/**
 * The direction a chat message renders in: the requested one, or the scoped
 * conversation direction. While an `auto` message streams, its first resolved
 * direction is held so the text does not flip as tokens arrive.
 */
export function useChatContentDirection(input: {
  readonly text: string;
  readonly contentDirection: ContentDirection | undefined;
  readonly messageId: MessageId | undefined;
  readonly directionHint: FixedContentDirection | null | undefined;
  readonly isStreaming: boolean;
}): {
  readonly effectiveContentDirection: ContentDirection;
  readonly resolvedContentDirection: FixedContentDirection;
} {
  const { text, contentDirection, messageId, directionHint, isStreaming } = input;
  const scopedContentDirection = useContentDirection();
  const effectiveContentDirection = contentDirection ?? scopedContentDirection;
  const streamingDirectionRef = useRef<{
    messageId: MessageId | null;
    direction: FixedContentDirection;
  } | null>(null);
  if (
    isStreaming &&
    effectiveContentDirection === "auto" &&
    streamingDirectionRef.current?.messageId !== (messageId ?? null)
  ) {
    streamingDirectionRef.current = {
      messageId: messageId ?? null,
      direction: resolveStreamingMarkdownDirection({
        markdown: text,
        requestedDirection: effectiveContentDirection,
        messageDirectionHint: directionHint,
        isStreaming: true,
      }),
    };
  }
  const frozenDirection =
    effectiveContentDirection === "auto" &&
    streamingDirectionRef.current?.messageId === (messageId ?? null)
      ? streamingDirectionRef.current.direction
      : null;
  const resolvedContentDirection = resolveStreamingMarkdownDirection({
    markdown: text,
    requestedDirection: effectiveContentDirection,
    messageDirectionHint: directionHint,
    frozenDirection,
    isStreaming,
  });
  if (!isStreaming) streamingDirectionRef.current = null;
  return { effectiveContentDirection, resolvedContentDirection };
}
