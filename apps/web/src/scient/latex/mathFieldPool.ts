import { afterEditorPaint } from "./afterEditorPaint";

// A soft limit: an active selection, command or unpublished draft always wins.
const capacity = 8;
const fields = new Set<() => boolean>();
let cancelTrim: (() => void) | undefined;

function trim() {
  if (cancelTrim || fields.size <= capacity) return;
  cancelTrim = afterEditorPaint(() => {
    cancelTrim = undefined;
    const scheduling = (navigator as Navigator & { scheduling?: { isInputPending: () => boolean } })
      .scheduling;
    if (scheduling?.isInputPending()) {
      trim();
      return;
    }
    // Dispose at most one input between paints. Protected inputs are skipped,
    // without polling or flushing a user's draft to satisfy the limit.
    for (const suspend of fields) {
      if (suspend()) {
        fields.delete(suspend);
        trim();
        break;
      }
    }
  });
}

/** Register a full input; previews and suspended model snapshots are not inputs. */
export function retainMathField(suspend: () => boolean) {
  fields.add(suspend);
  trim();
  return {
    touch: () => {
      if (fields.delete(suspend)) fields.add(suspend);
      trim();
    },
    release: () => {
      fields.delete(suspend);
      if (fields.size === 0) {
        cancelTrim?.();
        cancelTrim = undefined;
      }
    },
  };
}
