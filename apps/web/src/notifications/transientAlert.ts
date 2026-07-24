// FILE: transientAlert.ts
// Purpose: Explicitly gates the rare ownerless errors allowed to interrupt the current screen.
// Layer: Notification routing

import { toastManager } from "../components/ui/toast";

type ToastInput = Parameters<typeof toastManager.add>[0];

export type TransientAlertInput = Omit<ToastInput, "type"> & {
  readonly type?: "error" | "warning" | undefined;
};

/**
 * Use only when an immediate error has no stable owning surface. Routine success,
 * progress, undo, and background work belong to local state, Undo, or Activity.
 */
export const transientAlertManager = {
  add(input: TransientAlertInput): ReturnType<typeof toastManager.add> {
    return toastManager.add({ ...input, type: input.type ?? "error" });
  },
  close(id?: ReturnType<typeof toastManager.add>): void {
    toastManager.close(id);
  },
};
