// FILE: updateBackendRecovery.ts
// Purpose: Preserves whether updater failure should restore the supervised desktop backend.

import {
  type BackendRecoveryAfterUpdaterFailureAction,
  handleBackendRecoveryAfterUpdaterFailure,
} from "./backendRestartRecovery";

export class UpdateBackendRecoveryLatch {
  #restoreRequired = false;

  capture(wasRunning: boolean): void {
    this.#restoreRequired = wasRunning;
  }

  consume(): boolean {
    const restoreRequired = this.#restoreRequired;
    this.#restoreRequired = false;
    return restoreRequired;
  }
}

export function resolveQuittingAfterUpdaterFailure(input: {
  readonly desktopShutdownInFlight: boolean;
  readonly desktopShutdownComplete: boolean;
}): boolean {
  // An updater failure may relinquish only updater-owned quit authority. A concurrent user or
  // operating-system shutdown remains authoritative and must not be canceled by updater recovery.
  return input.desktopShutdownInFlight || input.desktopShutdownComplete;
}

export function coordinateBackendRecoveryAfterUpdaterFailure(input: {
  readonly recoveryLatch: UpdateBackendRecoveryLatch;
  readonly desktopShutdownInFlight: boolean;
  readonly desktopShutdownComplete: boolean;
  readonly recoveryPending: boolean;
  readonly recoveryDialogOpen: boolean;
  readonly resume: () => void;
  readonly showRecovery: () => void;
}): BackendRecoveryAfterUpdaterFailureAction {
  if (resolveQuittingAfterUpdaterFailure(input)) return "none";
  return handleBackendRecoveryAfterUpdaterFailure({
    restartWasRequired: input.recoveryLatch.consume(),
    recoveryPending: input.recoveryPending,
    recoveryDialogOpen: input.recoveryDialogOpen,
    resume: input.resume,
    showRecovery: input.showRecovery,
  });
}
