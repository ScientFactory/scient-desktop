import type { MessageId, ScopedThreadRef } from "@t3tools/contracts";
import { createContext } from "react";

/** Only assistant responses expose citation actions, never arbitrary document previews. */
export const AssistantCitationContext = createContext<
  (ScopedThreadRef & { messageId: MessageId }) | null
>(null);
