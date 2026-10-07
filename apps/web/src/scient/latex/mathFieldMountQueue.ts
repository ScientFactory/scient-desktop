import { afterEditorPaint } from "./afterEditorPaint";

const pending = new Set<() => void>();
let cancelBatch: (() => void) | undefined;

function scheduleBatch() {
  if (cancelBatch || pending.size === 0) return;
  cancelBatch = afterEditorPaint(() => {
    cancelBatch = undefined;
    const start = performance.now();
    while (pending.size > 0) {
      const mount = pending.values().next().value!;
      mount();
      if (performance.now() - start >= 8) break;
    }
    scheduleBatch();
  });
}

/** Yield between native math-field mounts; an editing action can mount its field immediately. */
export function scheduleMathFieldMount(mount: () => void) {
  const run = () => {
    if (!pending.delete(run)) return;
    mount();
  };
  pending.add(run);
  scheduleBatch();
  return {
    flush: run,
    cancel: () => {
      pending.delete(run);
      if (pending.size === 0) {
        cancelBatch?.();
        cancelBatch = undefined;
      }
    },
  };
}
