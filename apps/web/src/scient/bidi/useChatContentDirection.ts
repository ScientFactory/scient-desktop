import type { MessageId } from "@t3tools/contracts";
import { useState } from "react";

import { useContentDirection } from "./ContentDirectionScope";
import {
  resolveStreamingMarkdownDirection,
  type ContentDirection,
  type FixedContentDirection,
} from "./contentDirection";

/**
 * The direction a chat message renders in: the requested one, or the scoped
 * conversation direction. While an `auto` message streams, its first resolved
 * direction is held so the text does not flip as tokens arrive. After it
 * completes, that direction stays the fallback for text with no strong script,
 * on every render, until the message streams again.
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
  const id = messageId ?? null;
  const [held, setHeld] = useState<{
    readonly messageId: MessageId | null;
    readonly direction: FixedContentDirection;
    readonly streaming: boolean;
  } | null>(null);
  if (
    isStreaming &&
    effectiveContentDirection === "auto" &&
    (held === null || held.messageId !== id || !held.streaming)
  ) {
    setHeld({
      messageId: id,
      direction: resolveStreamingMarkdownDirection({
        markdown: text,
        requestedDirection: effectiveContentDirection,
        messageDirectionHint: directionHint,
        isStreaming: true,
      }),
      streaming: true,
    });
  } else if (!isStreaming && held?.streaming) {
    setHeld({ ...held, streaming: false });
  }
  const frozenDirection =
    effectiveContentDirection === "auto" && held?.messageId === id ? held.direction : null;
  const resolvedContentDirection = resolveStreamingMarkdownDirection({
    markdown: text,
    requestedDirection: effectiveContentDirection,
    messageDirectionHint: directionHint,
    frozenDirection,
    isStreaming,
  });
  return { effectiveContentDirection, resolvedContentDirection };
}
