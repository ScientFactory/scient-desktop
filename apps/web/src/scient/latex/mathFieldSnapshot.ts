import type { MathfieldElement } from "mathlive";

type Controller = {
  model: {
    getState: () => unknown;
    setState: (state: unknown, options: { silenceNotifications: boolean }) => void;
  };
  undoManager: { stack: unknown[]; index: number; lastOp: string; recording: boolean };
};
export type MathFieldSnapshot = {
  model: unknown;
  undo: Controller["undoManager"];
};

// MathLive's public value API omits undo and empty-slot state. Keep this small
// adapter guarded: an incompatible library retains the live input instead.
function controller(math: MathfieldElement): Controller | undefined {
  const native = (math as unknown as { _mathfield?: Controller })._mathfield;
  if (
    typeof native?.model?.getState !== "function" ||
    typeof native.model.setState !== "function" ||
    !Array.isArray(native.undoManager?.stack) ||
    !Number.isInteger(native.undoManager.index) ||
    typeof native.undoManager.lastOp !== "string" ||
    typeof native.undoManager.recording !== "boolean"
  )
    return;
  return native;
}

export function captureMathField(math: MathfieldElement): MathFieldSnapshot | undefined {
  const native = controller(math);
  if (!native) return;
  try {
    const { stack, index, lastOp, recording } = native.undoManager;
    // Only plain model data survives; no detached DOM, controller or listeners.
    return structuredClone({
      model: native.model.getState(),
      undo: { stack, index, lastOp, recording },
    });
  } catch {
    return;
  }
}

export function restoreMathField(math: MathfieldElement, snapshot: MathFieldSnapshot): boolean {
  const native = controller(math);
  if (!native) return false;
  try {
    const restored = structuredClone(snapshot);
    native.model.setState(restored.model, { silenceNotifications: true });
    Object.assign(native.undoManager, restored.undo);
    // Public selection assignment schedules MathLive's normal rendering path.
    math.selection = structuredClone(math.selection);
    return true;
  } catch {
    return false;
  }
}
