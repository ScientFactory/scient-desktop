// SCIENT-OWNED: opens a link's review in the side panel, as a tab like Diff.
import type { EnvironmentId, ScopedThreadRef } from "@t3tools/contracts";

import { useRightPanelStore } from "~/rightPanelStore";
import { scientOverleafReviewSurface } from "~/scient/rightPanel/surfaces";

import { readOverleafChanges } from "./overleafActions";

export function openOverleafReview(
  threadRef: ScopedThreadRef,
  input: { readonly cwd: string; readonly connectionId: string; readonly folder: string },
): void {
  useRightPanelStore.getState().openScient(threadRef, scientOverleafReviewSurface(input));
}

/** "See changes" reads what a sync would do now, unless a sync is already running. */
export function seeOverleafChanges(
  threadRef: ScopedThreadRef,
  input: {
    readonly environmentId: EnvironmentId;
    readonly cwd: string;
    readonly connectionId: string;
    readonly folder: string;
  },
): void {
  void readOverleafChanges(input.environmentId, input.cwd, input.connectionId);
  openOverleafReview(threadRef, input);
}
