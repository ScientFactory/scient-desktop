import type { FileSaveResolutionAction } from "~/components/files/fileSaveCoordinator";

export interface VisualSaveGateState {
  readonly editing: boolean;
  readonly awaitingSave: boolean;
}

export interface VisualSaveResolutionState {
  readonly awaitingSave: boolean;
  readonly buildHeld: boolean;
}

/**
 * Discard adopts authoritative disk state, so only an active visual input may
 * keep the build hold. Retry keeps the same local checkpoint pending until its
 * exact source contents receive a normal save confirmation.
 */
export function visualStateAfterSaveResolution(
  state: VisualSaveGateState,
  action: FileSaveResolutionAction,
): VisualSaveResolutionState {
  const awaitingSave = action === "discard" ? false : state.awaitingSave;
  return { awaitingSave, buildHeld: state.editing || awaitingSave };
}
