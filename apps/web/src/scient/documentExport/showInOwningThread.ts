import type { ScopedThreadRef } from "@t3tools/contracts";
import type { useNavigate } from "@tanstack/react-router";

import { buildThreadRouteParams } from "../../threadRoutes";

/**
 * Shows an exported document in the conversation that owns it: `open` puts
 * it in that thread's right panel, then the app goes to the thread. The
 * notice outlives the screen it came from, so by the time Open is chosen the
 * owning thread may no longer be the one shown.
 */
export function showInOwningThread(
  navigate: ReturnType<typeof useNavigate>,
  threadRef: ScopedThreadRef,
  open: () => void,
): void {
  open();
  void navigate({ to: "/$environmentId/$threadId", params: buildThreadRouteParams(threadRef) });
}
