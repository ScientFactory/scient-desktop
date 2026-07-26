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

export class UpdateQuitAuthorityLatch {
  #pendingReason: string | null = null;

  capture(reason: string): void {
    this.#pendingReason ??= reason;
  }

  consume(): string | null {
    const pendingReason = this.#pendingReason;
    this.#pendingReason = null;
    return pendingReason;
  }
}

export function routeDesktopQuitRequest(input: {
  readonly reason: string;
  readonly updaterInstallPreparing: boolean;
  readonly quitAuthority: UpdateQuitAuthorityLatch;
  readonly startShutdown: (reason: string) => void;
}): "deferred" | "shutdown-started" {
  if (input.updaterInstallPreparing) {
    input.quitAuthority.capture(input.reason);
    return "deferred";
  }
  input.startShutdown(input.reason);
  return "shutdown-started";
}

export function coordinateUpdaterFailureContinuation(input: {
  readonly pendingQuitReason: string | null;
  readonly requestQuit: (reason: string) => void;
  readonly recover: () => void;
}): "quit" | "recover" {
  if (input.pendingQuitReason !== null) {
    input.requestQuit(input.pendingQuitReason);
    return "quit";
  }
  input.recover();
  return "recover";
}

export function resolveQuittingAfterUpdaterFailure(input: {
  readonly desktopShutdownInFlight: boolean;
  readonly desktopShutdownComplete: boolean;
  readonly pendingQuitRequest: boolean;
}): boolean {
  // An updater failure may relinquish only updater-owned quit authority. A concurrent user or
  // operating-system shutdown remains authoritative and must not be canceled by updater recovery.
  return input.desktopShutdownInFlight || input.desktopShutdownComplete || input.pendingQuitRequest;
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
  if (
    resolveQuittingAfterUpdaterFailure({
      desktopShutdownInFlight: input.desktopShutdownInFlight,
      desktopShutdownComplete: input.desktopShutdownComplete,
      pendingQuitRequest: false,
    })
  ) {
    return "none";
  }
  return handleBackendRecoveryAfterUpdaterFailure({
    restartWasRequired: input.recoveryLatch.consume(),
    recoveryPending: input.recoveryPending,
    recoveryDialogOpen: input.recoveryDialogOpen,
    resume: input.resume,
    showRecovery: input.showRecovery,
  });
}
