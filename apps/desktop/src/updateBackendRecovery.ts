// FILE: updateBackendRecovery.ts
// Purpose: Preserves whether updater failure should restore the supervised desktop backend.

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
