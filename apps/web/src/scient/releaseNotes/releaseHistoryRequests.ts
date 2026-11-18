// Lets a screen outside the sidebar ask for the release history window.
import { create } from "zustand";

export const useReleaseHistoryRequests = create<{ readonly requestId: number }>(() => ({
  requestId: 0,
}));

/** Asks the release notes window to open on the version list. */
export function requestReleaseHistory(): void {
  useReleaseHistoryRequests.setState((state) => ({ requestId: state.requestId + 1 }));
}
