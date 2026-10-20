import { Atom } from "effect/reactivity";
import type { KeepAwakeRequest, KeepAwakeState } from "@t3tools/contracts";
import { appAtomRegistry } from "../../rpc/atomRegistry";
import { toastManager } from "../../components/ui/toast";

export const keepAwakeStateAtom = Atom.make<KeepAwakeState | null>(null);
export const keepAwakeErrorAtom = Atom.make<string | null>(null);
let pending = Promise.resolve();
export function requestKeepAwake(request: KeepAwakeRequest): Promise<KeepAwakeState | null> {
  const bridge = window.desktopBridge?.keepAwake;
  if (!bridge) return Promise.resolve(null);
  const result = pending.then(async () => {
    try {
      const state = await bridge(request);
      appAtomRegistry.set(keepAwakeStateAtom, state);
      appAtomRegistry.set(keepAwakeErrorAtom, null);
      return state;
    } catch (error) {
      const message = error instanceof Error ? error.message : "Keep-awake is unavailable.";
      if (appAtomRegistry.get(keepAwakeErrorAtom) === null) {
        toastManager.add({
          type: "error",
          title: "Could not update keep-awake",
          description: message,
        });
      }
      appAtomRegistry.set(keepAwakeErrorAtom, message);
      return null;
    }
  });
  pending = result.then(() => undefined);
  return result;
}
