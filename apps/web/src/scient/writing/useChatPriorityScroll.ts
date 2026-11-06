import { useStableCallback } from "~/hooks/useStableCallback";
import { prioritizeChatOverScroll } from "./chatPriorityScroll";

export function useChatPriorityScroll() {
  return useStableCallback((container: HTMLElement | null) => {
    if (container) return prioritizeChatOverScroll(container);
  });
}
