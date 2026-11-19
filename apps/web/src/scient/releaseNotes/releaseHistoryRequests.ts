// Lets a screen outside the sidebar ask for the release history window.
import { create } from "zustand";

export const useReleaseHistoryRequests = create<{
  readonly requestId: number;
  /** The element that asked, so the window can give focus back to it when it closes. */
  readonly opener: HTMLElement | null;
}>(() => ({
  requestId: 0,
  opener: null,
}));

/** Asks the release notes window to open on the version list. */
export function requestReleaseHistory(): void {
  const active = document.activeElement;
  useReleaseHistoryRequests.setState((state) => ({
    requestId: state.requestId + 1,
    opener: active instanceof HTMLElement ? active : null,
  }));
}
