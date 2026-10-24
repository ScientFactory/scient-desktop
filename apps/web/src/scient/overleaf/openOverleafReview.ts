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

/** "See changes": the review tab, reading the changes unless a review still to run is shown. */
export function seeOverleafChanges(
  threadRef: ScopedThreadRef,
  input: {
    readonly environmentId: EnvironmentId;
    readonly cwd: string;
    readonly connectionId: string;
    readonly folder: string;
  },
): void {
  // A review still to run (a read, or a conflict waiting) is current; one a sync applied is
  // history, so the changes are read again for what the next sync would do.
  const shown = readOverleafWorkspace(input.environmentId, input.cwd).reviews.get(
    input.connectionId,
  );
  if (!shown || shown.applied)
    void readOverleafChanges(input.environmentId, input.cwd, input.connectionId);
  openOverleafReview(threadRef, input);
}
