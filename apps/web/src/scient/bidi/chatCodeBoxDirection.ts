import { extractFenceTitle } from "../presentation/CodeBlockTitle";
import {
  resolveFenceDirection,
  resolvePlainTextBoxDirection,
  type ContentDirection,
} from "./contentDirection";

/**
 * The direction chat gives a code or plain-text box, from its content and
 * fence metadata. Shared by chat's code block and the Copy message button's
 * rich flavour, so a pasted box keeps the direction it is shown with.
 */
export function chatCodeBoxDirection(input: {
  readonly code: string;
  readonly language: string;
  readonly fenceMeta: string | undefined;
  readonly conversationDirection: ContentDirection;
  readonly isStreaming: boolean;
}): "auto" | "rtl" | "ltr" {
  return resolvePlainTextBoxDirection({
    code: input.code,
    language: input.language,
    fenceTitle: extractFenceTitle(input.fenceMeta),
    fenceDirection: resolveFenceDirection(input.fenceMeta),
    conversationDirection: input.conversationDirection,
    isStreaming: input.isStreaming,
  });
}
