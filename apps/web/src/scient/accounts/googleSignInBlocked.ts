import type {
  DesktopPreviewSignInBlockedEvent,
  DesktopPreviewTabState,
  EnvironmentId,
} from "@t3tools/contracts";
import { create } from "zustand";

import { recordAccountBrowserEvent } from "../analytics/accountBrowserAnalytics";

/** Enough for every open tab; a closed tab's entry is dropped once newer ones push it out. */
const KEPT = 32;

interface GoogleSignInBlockedState {
  /**
   * The latest stopped Google sign-in of each desktop tab, by runtime tab id. It applies only while
   * the tab still shows the event's `pageUrl`.
   */
  readonly byTabId: Readonly<Record<string, DesktopPreviewSignInBlockedEvent>>;
  readonly dismiss: (tabId: string) => void;
}

export const useGoogleSignInBlocked = create<GoogleSignInBlockedState>()((set) => ({
  byTabId: {},
  dismiss: (tabId) =>
    set((state) => {
      if (!(tabId in state.byTabId)) return state;
      const { [tabId]: _dismissed, ...byTabId } = state.byTabId;
      return { byTabId };
    }),
}));

/** Called once, by the app window that hosts the tab. */
export function noteGoogleSignInBlocked(
  environmentId: EnvironmentId,
  event: DesktopPreviewSignInBlockedEvent,
) {
  useGoogleSignInBlocked.setState((state) => {
    const { [event.tabId]: _replaced, ...others } = state.byTabId;
    const kept = Object.entries(others).slice(-(KEPT - 1));
    return { byTabId: { ...Object.fromEntries(kept), [event.tabId]: event } };
  });
  recordAccountBrowserEvent(environmentId, "accounts.google_signin.blocked", {
    variant: event.page,
    context: event.context,
  });
}

/**
 * A stopped sign-in is about one page: once the tab shows another address it is dropped, so coming
 * back to the same address later doesn't bring an old explanation back.
 */
export function noteTabState(tabId: string, state: DesktopPreviewTabState) {
  const blocked = useGoogleSignInBlocked.getState().byTabId[tabId];
  if (blocked && state.navStatus.kind !== "Idle" && state.navStatus.url !== blocked.pageUrl)
    useGoogleSignInBlocked.getState().dismiss(tabId);
}
