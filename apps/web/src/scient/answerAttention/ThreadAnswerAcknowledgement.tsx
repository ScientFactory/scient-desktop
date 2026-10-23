import type { ScopedThreadRef } from "@t3tools/contracts";
import { useThread } from "../../state/entities";
import { useAcknowledgeAnswer } from "./useAcknowledgeAnswer";

/** Visit metadata reads must not subscribe the surrounding chat shell to streamed text. */
export function ThreadAnswerAcknowledgement({ threadRef }: { threadRef: ScopedThreadRef | null }) {
  useAcknowledgeAnswer(useThread(threadRef));
  return null;
}
