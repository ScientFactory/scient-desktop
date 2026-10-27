import type { ScopedThreadRef } from "@t3tools/contracts";
import { useEffect } from "react";

import { useBrowserHistoryStore } from "~/browserHistoryStore";

/**
 * Files the thread's browser visits under its project, so a new Browser tab
 * lists them under "Recently used". Without this link every visit waits in
 * memory and is lost on reload. T3's orchestrator rewrite (upstream de34391427)
 * dropped the call that used to make it.
 */
export function useBrowserHistoryProjectLink(input: {
  readonly threadRef: ScopedThreadRef | null;
  readonly projectKey: string | null;
  readonly settingsHydrated: boolean;
}): void {
  const { threadRef, projectKey, settingsHydrated } = input;
  // oxlint-disable-next-line t3code/react-effect-budget -- Files the open thread's browser visits under its project once settings resolve the project key.
  useEffect(() => {
    if (!settingsHydrated || !threadRef || !projectKey) return;
    useBrowserHistoryStore.getState().registerThreadProject(threadRef, projectKey);
  }, [projectKey, settingsHydrated, threadRef]);
}
