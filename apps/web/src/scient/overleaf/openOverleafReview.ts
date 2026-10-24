// SCIENT-OWNED: opens a link's review in the side panel, as a tab like Diff.
import type { EnvironmentId, ScopedThreadRef } from "@t3tools/contracts";

import { useRightPanelStore } from "~/rightPanelStore";
import { scientOverleafReviewSurface } from "~/scient/rightPanel/surfaces";

import { readOverleafChanges } from "./overleafActions";
import { readOverleafWorkspace } from "./overleafStore";

export function openOverleafReview(
  threadRef: ScopedThreadRef,
  input: { readonly cwd: string; readonly connectionId: string; readonly folder: string },
): void {
  useRightPanelStore.getState().openScient(threadRef, scientOverleafReviewSurface(input));
}

/** "See changes": the review tab, reading the changes first when no sync here has shown them. */
export function seeOverleafChanges(
  threadRef: ScopedThreadRef,
  input: {
    readonly environmentId: EnvironmentId;
    readonly cwd: string;
    readonly connectionId: string;
    readonly folder: string;
  },
): void {
  const workspace = readOverleafWorkspace(input.environmentId, input.cwd);
  const last = workspace.lastSync.get(input.connectionId)?.result;
  const shown =
    (last !== undefined && (last._tag === "synced" || last._tag === "needs-decision")) ||
    workspace.previews.has(input.connectionId);
  if (!shown) void readOverleafChanges(input.environmentId, input.cwd, input.connectionId);
  openOverleafReview(threadRef, input);
}
