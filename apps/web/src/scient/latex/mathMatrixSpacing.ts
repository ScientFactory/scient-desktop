import type { MathfieldElement } from "mathlive";
import { DISPLAY_MATRIX_ROW_GAP_EM, isDisplayMatrix } from "../math/input/matrix";

interface Gap {
  dimension: number;
  unit?: string;
}
interface ArrayAtom {
  type: "array";
  environmentName: string;
  rowCount: number;
  rowGaps: Gap[];
  addRowBefore(row: number): void;
  addRowAfter(row: number): void;
  removeRow(row: number): void;
}
interface Atom {
  type?: string;
  parent?: Atom;
}

/** MathLive 0.108 changes array rows without extending their explicit row gaps.
 * Decorate only this field's atoms, inside the native mutation/history boundary.
 * No source changes happen on mount, input, selection, or restoration. */
export function installMathMatrixSpacing(
  math: MathfieldElement,
  display: () => boolean,
): () => void {
  const wrapped = new WeakSet<ArrayAtom>();
  let disposed = false;
  const prepare = () => {
    const model = (
      math as unknown as { _mathfield?: { model?: { at(offset: number): Atom | undefined } } }
    )._mathfield?.model;
    // Only the caret's array ancestors can gain/lose rows. Avoid scanning the
    // entire expression on every keystroke in a large formula.
    for (let atom = model?.at(math.position); atom; atom = atom.parent) {
      if (atom.type !== "array") continue;
      const array = atom as ArrayAtom;
      if (wrapped.has(array)) continue;
      wrapped.add(array);
      for (const command of ["addRowBefore", "addRowAfter", "removeRow"] as const) {
        const native = array[command];
        array[command] = function (row) {
          const gaps = this.rowGaps.slice(0, Math.max(0, this.rowCount - 1));
          const uniform =
            this.rowCount > 1 &&
            this.rowGaps.length === this.rowCount - 1 &&
            gaps.every((gap) => gap?.dimension === DISPLAY_MATRIX_ROW_GAP_EM && gap.unit === "em");
          // A one-row matrix has no separator. Adding its first separator is a
          // new insertion; do not replace any explicitly authored row option.
          const single =
            this.rowCount === 1 && this.rowGaps.length === 0 && command !== "removeRow";
          const maintain =
            !disposed && display() && isDisplayMatrix(this.environmentName) && (uniform || single);
          native.call(this, row);
          if (maintain) {
            this.rowGaps = Array.from({ length: Math.max(0, this.rowCount - 1) }, () => ({
              dimension: DISPLAY_MATRIX_ROW_GAP_EM,
              unit: "em",
            }));
          }
        };
      }
    }
  };
  // beforeinput covers toolbar, keyboard, native menu, and split-row actions;
  // input also decorates newly parsed/inserted and undo-restored arrays.
  math.addEventListener("beforeinput", prepare);
  math.addEventListener("input", prepare);
  prepare();
  return () => {
    disposed = true;
    math.removeEventListener("beforeinput", prepare);
    math.removeEventListener("input", prepare);
  };
}
