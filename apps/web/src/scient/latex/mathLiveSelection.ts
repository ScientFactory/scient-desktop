import type { MathfieldElement, Style } from "mathlive";

interface MathAtom {
  readonly id?: string;
  readonly type?: string;
  readonly style?: Readonly<Record<string, string | number | undefined>>;
  readonly command?: string;
  readonly skipBoundary?: boolean;
  readonly isRoot?: boolean;
  readonly environmentName?: string;
  readonly parent?: MathAtom | null;
  readonly parentBranch?: unknown;
  readonly leftSibling?: MathAtom | null;
  readonly rightSibling?: MathAtom | null;
  readonly rowCount?: number;
  readonly colCount?: number;
  readonly getCell?: (row: number, column: number) => readonly MathAtom[] | undefined;
  readonly setCell?: (row: number, column: number, value: readonly MathAtom[]) => void;
  readonly branches?: readonly unknown[];
  readonly branch?: (name: unknown) => readonly MathAtom[] | undefined;
  readonly addChildrenAfter?: (
    children: readonly MathAtom[],
    after: MathAtom,
  ) => MathAtom | undefined;
  readonly removeChild?: (child: MathAtom) => void;
}

interface MathModel {
  readonly atoms: readonly MathAtom[];
  at(offset: number): MathAtom;
  offsetOf(atom: MathAtom): number;
  readonly anchor: number;
  readonly position: number;
  _anchor: number;
  _position: number;
  _selection: { ranges: [number, number][]; direction: "forward" | "backward" | "none" };
  selectionDidChange(): void;
  setState?: (
    state: {
      content: { type: "root"; mode: "math"; body: readonly unknown[] };
      selection: { ranges: [number, number][] };
      mode: "math";
    },
    options: { silenceNotifications: boolean },
  ) => void;
  contentWillChange?: (options: { inputType: string }) => boolean;
  deferNotifications?: (
    options: { content: boolean; selection: boolean; type: string },
    action: () => void,
  ) => boolean;
}

interface MathMutationController {
  readonly model?: MathModel;
  setValue?: (
    value: string,
    options: {
      silenceNotifications: boolean;
      insertionMode: "replaceAll";
      selectionMode: "after";
      format: "latex";
      mode: "math";
    },
  ) => void;
  snapshot?: () => void;
  stopCoalescingUndo?: () => void;
  flushInlineShortcutBuffer?: () => void;
}

/** Restore authoritative source without retaining empty arrays from the old model. */
export function restoreMathFieldValue(math: MathfieldElement, value: string): void {
  const controller = (math as unknown as { _mathfield?: MathMutationController })._mathfield;
  const options = {
    silenceNotifications: true,
    insertionMode: "replaceAll" as const,
    selectionMode: "after" as const,
    format: "latex" as const,
    mode: "math" as const,
  };
  if (!controller?.model?.setState || !controller.setValue) {
    math.setValue(value, options);
    return;
  }
  // MathLive's range deletion can retain an empty wrapper. Restore the entire
  // model before parsing the replacement, including when the replacement is empty.
  controller.model.setState(
    {
      content: { type: "root", mode: "math", body: [] },
      selection: { ranges: [[0, 0]] },
      mode: "math",
    },
    { silenceNotifications: true },
  );
  controller.setValue(value, options);
}

function mutateMath(math: MathfieldElement, action: (model: MathModel) => void): boolean {
  const controller = (math as unknown as { _mathfield?: MathMutationController })._mathfield;
  const model = mathModel(math);
  const type = "deleteContentBackward";
  if (
    math.readOnly ||
    !controller?.snapshot ||
    !model?.deferNotifications ||
    !model.contentWillChange?.({ inputType: type })
  )
    return false;
  controller.flushInlineShortcutBuffer?.();
  controller.stopCoalescingUndo?.();
  controller.snapshot();
  const changed = model.deferNotifications({ content: true, selection: true, type }, () =>
    action(model),
  );
  if (changed) controller.snapshot();
  return changed;
}

/** Clear every selected cell without merging rows or removing the array. */
export function clearMathRectangle(
  math: MathfieldElement,
  rectangle: MathRectangleSelection,
): boolean {
  const array = rectangle.anchor.array;
  if (!array.setCell) return false;
  const firstRow = Math.min(rectangle.anchor.row, rectangle.focus.row);
  const lastRow = Math.max(rectangle.anchor.row, rectangle.focus.row);
  const firstColumn = Math.min(rectangle.anchor.column, rectangle.focus.column);
  const lastColumn = Math.max(rectangle.anchor.column, rectangle.focus.column);
  return mutateMath(math, (model) => {
    for (let row = firstRow; row <= lastRow; row += 1)
      for (let column = firstColumn; column <= lastColumn; column += 1)
        array.setCell?.(row, column, []);
    const first = array.getCell?.(firstRow, firstColumn)?.[0];
    if (first) math.position = model.offsetOf(first);
  });
}

/** Remove an empty cell's nearest wrapper, preserving its remaining atoms. */
export function unwrapEmptyMathCell(math: MathfieldElement): boolean {
  const model = mathModel(math);
  if (!model) return false;
  if (
    !math.selectionIsCollapsed &&
    math.getValue(math.selection, "latex-without-placeholders").trim()
  )
    return false;
  let child = model.at(math.position);
  let wrapper: MathAtom | null = null;
  while (child.parent && !child.parent.isRoot) {
    const parent: MathAtom = child.parent;
    if (
      ["array", "genfrac", "surd", "leftright", "overunder", "box", "enclose"].includes(
        parent.type ?? "",
      )
    ) {
      const branch = parent.branch?.(child.parentBranch);
      if (branch?.length) {
        const from = model.offsetOf(branch[0]!);
        const to = model.offsetOf(branch[branch.length - 1]!);
        if (
          from >= 0 &&
          to >= from &&
          !math.getValue([from, to], "latex-without-placeholders").replace(/[{}\s]/gu, "")
        ) {
          wrapper = parent;
          break;
        }
      }
    }
    child = parent;
  }
  if (!wrapper?.parent) return false;
  const parent = wrapper.parent;
  if (!parent.addChildrenAfter || !parent.removeChild) return false;
  const target = wrapper;
  const contents: MathAtom[] = [];
  if (target.type === "array") {
    for (let row = 0; row < (target.rowCount ?? 0); row += 1)
      for (let column = 0; column < (target.colCount ?? 0); column += 1)
        contents.push(...(target.getCell?.(row, column) ?? []));
  }
  for (const branch of target.branches ?? []) contents.push(...(target.branch?.(branch) ?? []));
  // Matrix templates use {} for blank cells. Those anonymous groups are
  // empty slots, not expressions to move into the surrounding formula.
  // Inspect atoms instead of stripping braces from serialized source: macro
  // arguments, nested structures and script bases must retain their meaning.
  const remaining = contents.filter((atom) => !emptyMathSlot(atom));
  const before = target.leftSibling;
  return mutateMath(math, (current) => {
    if (remaining.length) parent.addChildrenAfter?.(remaining, target);
    parent.removeChild?.(target);
    math.position = before ? Math.max(0, current.offsetOf(before)) : 0;
  });
}

function emptyMathSlot(atom: MathAtom): boolean {
  if (atom.type === "first" || atom.type === "placeholder") return true;
  if (atom.type !== "group" || atom.command || !atom.skipBoundary) return false;
  if (atom.rightSibling?.type === "subsup") return false;
  return (atom.branches ?? []).every((branch) =>
    (atom.branch?.(branch) ?? []).every(emptyMathSlot),
  );
}

export interface MathCellSelection {
  readonly array: MathAtom;
  readonly row: number;
  readonly column: number;
  readonly cell: readonly [number, number];
  readonly environment: readonly [number, number];
}

export type MathStructureCommand = "addRowAfter" | "removeRow" | "addColumnAfter" | "removeColumn";

export interface MathArrayContext {
  readonly environment: string;
  readonly row: number;
  readonly column: number;
  readonly rows: number;
  readonly columns: number;
}

/** The caret's actual array controls availability, including nested matrices. */
export function mathArrayContext(math: MathfieldElement): MathArrayContext | null {
  const cell = mathSelectionAtOffset(math, math.position).path.at(-1);
  return cell
    ? {
        environment: cell.array.environmentName ?? "array",
        row: cell.row,
        column: cell.column,
        rows: cell.array.rowCount ?? 0,
        columns: cell.array.colCount ?? 0,
      }
    : null;
}

export function mathStructureCommandReason(
  context: MathArrayContext | null,
  command: MathStructureCommand,
): string | null {
  if (!context) return "Place the caret in a matrix, cases or aligned equation cell.";
  if (command.includes("Column") && ["cases", "aligned", "gathered"].includes(context.environment))
    return "This structure has a fixed number of columns.";
  if (command === "removeRow" && context.rows <= 1) return "Keep at least one row.";
  if (command === "removeColumn" && context.columns <= 1) return "Keep at least one column.";
  if (command === "addRowAfter" && context.rows >= 20) return "This editor supports up to 20 rows.";
  if (command === "addColumnAfter" && context.columns >= 20)
    return "This editor supports up to 20 columns.";
  return null;
}

export interface MathRectangleSelection {
  readonly anchor: MathCellSelection;
  readonly focus: MathCellSelection;
  readonly ranges: readonly (readonly [number, number])[];
  readonly source: string;
}

export interface MathSelectionGeometry {
  readonly arrays: WeakMap<object, DOMRect | null>;
  readonly cells: WeakMap<object, Map<string, DOMRect | null>>;
  readonly branches: WeakMap<object, Map<unknown, DOMRect | null>>;
  readonly scopes: readonly MathCellSelection[];
}

export function createMathSelectionGeometry(math: MathfieldElement): MathSelectionGeometry {
  const model = mathModel(math);
  const scopes: MathCellSelection[] = [];
  if (model) {
    for (const atom of model.atoms) {
      if (atom.type !== "array" || atom.isRoot) continue;
      for (let row = 0; row < (atom.rowCount ?? 0); row += 1) {
        for (let column = 0; column < (atom.colCount ?? 0); column += 1) {
          const cell = arrayCell(model, atom, row, column);
          if (cell) {
            scopes.push(cell);
            break;
          }
        }
        if (scopes.at(-1)?.array === atom) break;
      }
    }
  }
  const depth = (atom: MathAtom) => {
    let count = 0;
    for (let parent = atom.parent; parent; parent = parent.parent) count += 1;
    return count;
  };
  scopes.sort((a, b) => depth(a.array) - depth(b.array));
  return { arrays: new WeakMap(), cells: new WeakMap(), branches: new WeakMap(), scopes };
}

// MathLive 0.108 exposes offsets publicly but not the array cell that owns an
// offset. Keep the small model read here, at the library boundary.
function mathModel(math: MathfieldElement): MathModel | null {
  const model = (math as unknown as { _mathfield?: { model?: MathModel } })._mathfield?.model;
  if (!model || typeof model.at !== "function" || typeof model.offsetOf !== "function") return null;
  return model;
}

function isMathFormattingScope(atom: MathAtom): boolean {
  return (
    atom.type === "group" &&
    (atom.skipBoundary === true ||
      /^\\(?:text|math)(?:bf|it|tt|rm|sf|sc|sl|up)?$/u.test(atom.command ?? ""))
  );
}

export interface MathEditingScope {
  readonly label: string;
  readonly kind: "cell" | "slot" | "structure" | "format" | "equation";
  readonly range: readonly [number, number];
  readonly exit: readonly [number, number];
  readonly leaveStyle?: Style;
}
const mathScopeLabels: Readonly<Record<string, string>> = {
  genfrac: "Fraction",
  surd: "Root",
  leftright: "Brackets",
  subsup: "Scripts",
  textbf: "Bold",
  mathbf: "Bold",
  textit: "Italic",
  mathit: "Italic",
  texttt: "Monospace",
  mathtt: "Monospace",
  text: "Text",
};

/** Innermost first; formatting participates in explicit scope commands only. */
export function mathEditingScopes(math: MathfieldElement): MathEditingScope[] {
  const model = mathModel(math);
  if (!model) return [];
  const result: MathEditingScope[] = [];
  let atom = model.at(math.position);
  const branch = atom?.parentBranch;
  const siblings = Array.isArray(branch)
    ? atom.parent?.getCell?.(branch[0], branch[1])
    : atom.parent?.branch?.(branch);
  // MathLive represents font commands as styled runs, not always group atoms.
  const formats: {
    label: string;
    active: boolean;
    matches: (style: MathAtom["style"]) => boolean;
    leaveStyle: Style;
  }[] = [
    {
      label: "Bold",
      active:
        math.queryStyle({ fontSeries: "b" }) === "all" ||
        math.queryStyle({ variantStyle: "bold" }) === "all" ||
        math.queryStyle({ variantStyle: "bolditalic" }) === "all",
      matches: (style) =>
        style?.fontSeries === "b" || String(style?.variantStyle ?? "").includes("bold"),
      leaveStyle:
        math.mode === "text"
          ? { fontSeries: "m" }
          : {
              variantStyle:
                math.queryStyle({ variantStyle: "bolditalic" }) === "all" ? "italic" : "up",
            },
    },
    {
      label: "Italic",
      active:
        math.queryStyle({ fontShape: "it" }) === "all" ||
        math.queryStyle({ variantStyle: "italic" }) === "all" ||
        math.queryStyle({ variantStyle: "bolditalic" }) === "all",
      matches: (style) =>
        style?.fontShape === "it" || String(style?.variantStyle ?? "").includes("italic"),
      leaveStyle:
        math.mode === "text"
          ? { fontShape: "n" }
          : {
              variantStyle:
                math.queryStyle({ variantStyle: "bolditalic" }) === "all" ? "bold" : "up",
            },
    },
    {
      label: "Monospace",
      active:
        math.queryStyle({ fontFamily: "monospace" }) === "all" ||
        math.queryStyle({ variant: "monospace" }) === "all",
      matches: (style) => style?.fontFamily === "monospace" || style?.variant === "monospace",
      leaveStyle: math.mode === "text" ? { fontFamily: "roman" } : { variant: "main" },
    },
  ];
  for (const format of formats) {
    if (!format.active || !siblings) continue;
    let index = siblings.indexOf(atom);
    if (index < 0) continue;
    if (!format.matches(atom.style) && format.matches(siblings[index + 1]?.style)) index++;
    if (!format.matches(siblings[index]?.style)) continue;
    let start = index,
      end = index;
    while (start > 0 && format.matches(siblings[start - 1]?.style)) start--;
    while (end + 1 < siblings.length && format.matches(siblings[end + 1]?.style)) end++;
    const before = siblings[start]!.leftSibling ?? siblings[start]!;
    const range: [number, number] = [model.offsetOf(before), model.offsetOf(siblings[end]!)];
    result.push({
      label: format.label,
      kind: "format",
      range,
      exit: range,
      leaveStyle: format.leaveStyle,
    });
  }
  result.sort((a, b) => a.range[1] - a.range[0] - (b.range[1] - b.range[0]));
  while (atom?.parent && !atom.parent.isRoot) {
    const owner = atom.parent,
      branch = atom.parentBranch;
    const before = owner.leftSibling ? model.offsetOf(owner.leftSibling) : 0;
    const after = model.offsetOf(owner);
    if (owner.type === "array" && Array.isArray(branch)) {
      const cell = arrayCell(model, owner, branch[0], branch[1]);
      if (cell) {
        const columns = owner.colCount ?? 0,
          rows = owner.rowCount ?? 0;
        const index = cell.row * columns + cell.column;
        const previous =
          index > 0
            ? arrayCell(model, owner, Math.floor((index - 1) / columns), (index - 1) % columns)
            : null;
        const next =
          index + 1 < rows * columns
            ? arrayCell(model, owner, Math.floor((index + 1) / columns), (index + 1) % columns)
            : null;
        result.push({
          label: `Cell (${cell.row + 1}, ${cell.column + 1})`,
          kind: "cell",
          range: cell.cell,
          exit: [previous?.cell[1] ?? cell.environment[0], next?.cell[0] ?? cell.environment[1]],
        });
        result.push({
          label: /cases/u.test(owner.environmentName ?? "") ? "Cases" : "Matrix",
          kind: "structure",
          range: cell.environment,
          exit: cell.environment,
        });
      }
    } else {
      const contents = owner.branch?.(branch);
      const command = owner.command?.replace(/^\\/u, "");
      const label =
        mathScopeLabels[command ?? ""] ?? mathScopeLabels[owner.type ?? ""] ?? command ?? "Group";
      if (contents?.length && after >= before) {
        const range: [number, number] = [
          model.offsetOf(contents[0]!),
          model.offsetOf(contents.at(-1)!),
        ];
        const whole: [number, number] = [before, after];
        if (isMathFormattingScope(owner)) {
          if (command && !result.some((scope) => scope.label === label && scope.kind === "format"))
            result.push({ label, kind: "format", range, exit: whole });
        } else {
          const slotLabel =
            branch === "above"
              ? owner.type === "genfrac"
                ? "Numerator"
                : "Above"
              : branch === "below"
                ? owner.type === "genfrac"
                  ? "Denominator"
                  : "Below"
                : branch === "superscript"
                  ? "Superscript"
                  : branch === "subscript"
                    ? "Subscript"
                    : branch === "body"
                      ? "Body"
                      : String(branch);
          result.push({ label: slotLabel, kind: "slot", range, exit: whole });
          result.push({ label, kind: "structure", range: whole, exit: whole });
        }
      }
    }
    atom = owner;
  }
  result.push({
    label: "Equation",
    kind: "equation",
    range: [0, math.lastOffset],
    exit: [0, math.lastOffset],
  });
  return result;
}

export function mathScopeRects(
  math: MathfieldElement,
  range: readonly [number, number],
): DOMRect[] {
  const cell = mathCellPathAt(math, range[0]).at(-1);
  if (cell && cell.cell[0] === range[0] && cell.cell[1] === range[1]) {
    const rect = mathRenderedCellBounds(math, cell);
    if (rect) return [rect];
  }
  const bounds = math.shadowRoot
    ?.querySelector(".ML__caret,.ML__text-caret")
    ?.getBoundingClientRect();
  const rectangles: DOMRect[] = [];
  for (let offset = range[0]; offset <= range[1]; offset++) {
    const rect = math.getElementInfo(offset)?.bounds;
    if (rect?.height) rectangles.push(rect);
  }
  if (!rectangles.length) return bounds ? [bounds] : [];
  const left = Math.min(...rectangles.map((rect) => rect.left)),
    top = Math.min(...rectangles.map((rect) => rect.top));
  const right = Math.max(...rectangles.map((rect) => rect.right)),
    bottom = Math.max(...rectangles.map((rect) => rect.bottom));
  return [new DOMRect(left, top, Math.max(4, right - left), bottom - top)];
}

/** Tab visits structural slots, including blank cells, without stopping on styling. */
export function moveMathSlot(math: MathfieldElement, direction: -1 | 1): boolean {
  const model = mathModel(math);
  if (!model) return false;
  let atom = model.at(math.position);
  while (atom?.parent && !atom.parent.isRoot) {
    const owner = atom.parent;
    const branch = atom.parentBranch;
    if (isMathFormattingScope(owner)) {
      atom = owner;
      continue;
    }
    if (owner.type === "array" && Array.isArray(branch)) {
      const columns = owner.colCount ?? 0,
        rows = owner.rowCount ?? 0;
      const index = branch[0] * columns + branch[1] + direction;
      if (index >= 0 && index < rows * columns) {
        const cell = arrayCell(model, owner, Math.floor(index / columns), index % columns);
        if (cell) {
          math.position = cell.cell[direction < 0 ? 1 : 0];
          return true;
        }
      }
    } else {
      // Library branch order is the structural serialization order.
      const branches = (owner.branches ?? []).filter((name) => owner.branch?.(name)?.length);
      const next = branches[branches.indexOf(branch) + direction];
      const contents = next === undefined ? null : owner.branch?.(next);
      if (contents?.length) {
        math.position = model.offsetOf(contents[direction < 0 ? contents.length - 1 : 0]!);
        return true;
      }
    }
    const edge = direction < 0 ? owner.leftSibling : owner;
    if (edge) {
      math.position = Math.max(0, model.offsetOf(edge));
      return true;
    }
    atom = owner;
  }
  return false;
}

/** Repeated vertical moves retain the starting x even through short/empty rows. */
export function mathVerticalTarget(
  math: MathfieldElement,
  direction: -1 | 1,
  intent: number | null,
): { position: number; intent: number } | null {
  const model = mathModel(math);
  if (!model) return null;
  const caret = math.shadowRoot
    ?.querySelector(".ML__caret,.ML__text-caret")
    ?.getBoundingClientRect();
  const x = intent ?? caret?.left ?? math.getElementInfo(math.position)?.bounds?.right;
  if (x === undefined) return null;
  const nearest = (range: readonly [number, number]) => {
    let position = range[0],
      distance = Infinity;
    for (let offset = range[0]; offset <= range[1]; offset++) {
      const bounds = math.getElementInfo(offset)?.bounds;
      if (!bounds) continue;
      const dx = Math.abs(x - (offset === range[0] ? bounds.left : bounds.right));
      if (dx < distance) {
        position = offset;
        distance = dx;
      }
    }
    return { position, intent: x };
  };
  let atom = model.at(math.position);
  while (atom?.parent && !atom.parent.isRoot) {
    const owner = atom.parent,
      branch = atom.parentBranch;
    if (owner.type === "array" && Array.isArray(branch)) {
      const cell = arrayCell(model, owner, branch[0] + direction, branch[1]);
      if (cell) return nearest(cell.cell);
    } else if ((branch === "above" && direction > 0) || (branch === "below" && direction < 0)) {
      const contents = owner.branch?.(direction < 0 ? "above" : "below");
      if (contents?.length)
        return nearest([model.offsetOf(contents[0]!), model.offsetOf(contents.at(-1)!)]);
    }
    atom = owner;
  }
  return null;
}

export function mathSelectionEndpoints(math: MathfieldElement): readonly [number, number] | null {
  const model = mathModel(math);
  return model ? [model.anchor, model.position] : null;
}

export function mathSelectionRevision(math: MathfieldElement): object | null {
  return mathModel(math)?.at(0) ?? null;
}

/** A wrapper can contain a whole array or one cell's expression, never partial cells. */
export function mathSelectionWrapReason(math: MathfieldElement): string | null {
  if (math.selectionIsCollapsed) return null;
  const ranges = math.selection.ranges;
  if (ranges.length !== 1)
    return "Select an expression within one math cell, or select the complete matrix.";
  const [from, to] = ranges[0]!;
  const start = mathCellPathAt(math, Math.min(from, to));
  const end = mathCellPathAt(math, Math.max(from, to));
  return start.length !== end.length ||
    start.some((cell, index) => {
      const other = end[index];
      return (
        !other ||
        cell.array !== other.array ||
        cell.row !== other.row ||
        cell.column !== other.column
      );
    })
    ? "Select an expression within one math cell, or select the complete matrix."
    : null;
}

/** Start a newly mounted structured formula at its first editable cell. */
export function firstMathCell(math: MathfieldElement): MathCellSelection | null {
  const model = mathModel(math);
  if (!model) return null;
  const arrays = model.atoms.filter((atom) => atom.type === "array" && !atom.isRoot);
  const array = arrays.find(
    (candidate) =>
      !arrays.some((other) => {
        for (let parent = candidate.parent; parent; parent = parent.parent) {
          if (parent === other) return true;
        }
        return false;
      }),
  );
  return array ? arrayCell(model, array, 0, 0) : null;
}

function arrayCell(
  model: MathModel,
  array: MathAtom,
  row: number,
  column: number,
): MathCellSelection | null {
  const cell = array.getCell?.(row, column);
  if (!cell?.length) return null;
  const from = model.offsetOf(cell[0]!);
  const to = model.offsetOf(cell[cell.length - 1]!);
  const environmentEnd = model.offsetOf(array);
  const firstCell = array.getCell?.(0, 0);
  const beforeFirstCell = firstCell?.[0] ? model.offsetOf(firstCell[0]) - 1 : -1;
  const predecessor = array.leftSibling ? model.offsetOf(array.leftSibling) : -1;
  const environmentStart = predecessor >= 0 ? predecessor : beforeFirstCell;
  if (from < 0 || to < from || environmentStart < 0 || environmentEnd < 0) return null;
  return {
    array,
    row,
    column,
    cell: [from, to],
    environment: [environmentStart, environmentEnd],
  };
}

function mathCellPathAt(math: MathfieldElement, offset: number): readonly MathCellSelection[] {
  const model = mathModel(math);
  if (!model) return [];
  const path: MathCellSelection[] = [];
  let atom: MathAtom | null | undefined = model.at(offset);
  while (atom?.parent) {
    const array: MathAtom = atom.parent;
    const branch = atom.parentBranch;
    if (
      array.type === "array" &&
      Array.isArray(branch) &&
      branch.length === 2 &&
      typeof branch[0] === "number" &&
      typeof branch[1] === "number"
    ) {
      const cell = arrayCell(model, array, branch[0], branch[1]);
      if (cell) path.push(cell);
    }
    atom = array;
  }
  return path.reverse();
}

export function mathCellAtCoordinates(
  math: MathfieldElement,
  reference: MathCellSelection,
  row: number,
  column: number,
): MathCellSelection | null {
  const model = mathModel(math);
  return model ? arrayCell(model, reference.array, row, column) : null;
}

/** Find a row's left edge so horizontal navigation can leave the array. */
export function mathLeftCellBoundary(
  math: MathfieldElement,
  offset: number,
): MathCellSelection | null {
  return mathHorizontalCellBoundary(math, offset, -1);
}

/** Find a row's right edge with the same exit rules as its left edge. */
export function mathRightCellBoundary(
  math: MathfieldElement,
  offset: number,
): MathCellSelection | null {
  return mathHorizontalCellBoundary(math, offset, 1);
}

function mathHorizontalCellBoundary(
  math: MathfieldElement,
  offset: number,
  direction: -1 | 1,
): MathCellSelection | null {
  const edge = direction === -1 ? 0 : 1;
  const isEdgeColumn = (cell: MathCellSelection) =>
    cell.column === (direction === -1 ? 0 : (cell.array.colCount ?? 0) - 1);
  const path = mathCellPathAt(math, offset);
  const innermost = path.at(-1);
  const exact =
    innermost && isEdgeColumn(innermost) && offset === innermost.cell[edge] ? innermost : null;
  if (exact) return exact;
  const caret = math.shadowRoot?.querySelector(".ML__caret, .ML__text-caret");
  if (!caret) return null;
  const bounds = caret.getBoundingClientRect();
  const x = direction === -1 ? bounds.right : bounds.left;
  const y = bounds.top + bounds.height / 2;
  const cell = mathSelectionPoint(math, x, y).path.at(-1);
  if (!cell || !isEdgeColumn(cell) || (innermost && cell.array !== innermost.array)) return null;
  const start = direction === -1 ? cell.cell[0] + 1 : cell.cell[1];
  for (let index = start; index > cell.cell[0] && index <= cell.cell[1]; index -= direction) {
    const atomBounds = math.getElementInfo(index)?.bounds;
    if (atomBounds) {
      const middle = atomBounds.left + atomBounds.width / 2;
      return (direction === -1 ? x <= middle : x >= middle) ? cell : null;
    }
  }
  return cell;
}

export function mathEnvironmentBounds(
  math: MathfieldElement,
  cell: MathCellSelection,
  geometry?: MathSelectionGeometry,
): DOMRect | null {
  const cached = geometry?.arrays.get(cell.array);
  if (cached !== undefined) return cached;
  const arrayBounds = math.getElementInfo(cell.environment[1])?.bounds;
  const model = mathModel(math);
  if (!model) return arrayBounds ?? null;
  let left = arrayBounds?.left ?? Infinity;
  let top = arrayBounds?.top ?? Infinity;
  let right = arrayBounds?.right ?? -Infinity;
  let bottom = arrayBounds?.bottom ?? -Infinity;
  for (let row = 0; row < (cell.array.rowCount ?? 0); row += 1) {
    for (let column = 0; column < (cell.array.colCount ?? 0); column += 1) {
      for (const atom of cell.array.getCell?.(row, column) ?? []) {
        const bounds = math.getElementInfo(model.offsetOf(atom))?.bounds;
        if (!bounds) continue;
        left = Math.min(left, bounds.left);
        top = Math.min(top, bounds.top);
        right = Math.max(right, bounds.right);
        bottom = Math.max(bottom, bounds.bottom);
      }
    }
  }
  const bounds = left === Infinity ? null : new DOMRect(left, top, right - left, bottom - top);
  geometry?.arrays.set(cell.array, bounds);
  return bounds;
}

function containsPoint(bounds: DOMRect, x: number, y: number): boolean {
  return x >= bounds.left && x <= bounds.right && y >= bounds.top && y <= bounds.bottom;
}

function isInsideArray(atom: MathAtom, array: MathAtom): boolean {
  for (let parent = atom.parent; parent; parent = parent.parent) if (parent === array) return true;
  return false;
}

function mathCellBounds(
  math: MathfieldElement,
  cell: MathCellSelection,
  geometry?: MathSelectionGeometry,
): DOMRect | null {
  const key = `${cell.row}:${cell.column}`;
  const cached = geometry?.cells.get(cell.array)?.get(key);
  if (cached !== undefined) return cached;
  let left = Infinity;
  let top = Infinity;
  let right = -Infinity;
  let bottom = -Infinity;
  for (let offset = cell.cell[0]; offset <= cell.cell[1]; offset += 1) {
    const bounds = math.getElementInfo(offset)?.bounds;
    if (!bounds) continue;
    left = Math.min(left, bounds.left);
    top = Math.min(top, bounds.top);
    right = Math.max(right, bounds.right);
    bottom = Math.max(bottom, bounds.bottom);
  }
  const rendered = mathRenderedCellBounds(math, cell);
  const bounds =
    rendered ?? (left === Infinity ? null : new DOMRect(left, top, right - left, bottom - top));
  if (geometry) {
    let cells = geometry.cells.get(cell.array);
    if (!cells) {
      cells = new Map();
      geometry.cells.set(cell.array, cells);
    }
    cells.set(key, bounds);
  }
  return bounds;
}

/** Include the reserved hit box of an empty cell, rather than its zero-width sentinel. */
function mathRenderedCellBounds(math: MathfieldElement, cell: MathCellSelection): DOMRect | null {
  if (!cell.array.id) return null;
  const wrapper = math.shadowRoot?.querySelector(`[data-atom-id="${CSS.escape(cell.array.id)}"]`);
  const table = wrapper?.matches(".ML__mtable") ? wrapper : wrapper?.querySelector(".ML__mtable");
  if (!table) return null;
  const column = [...table.children].filter((element) =>
    element.matches(".col-align-l,.col-align-c,.col-align-r"),
  )[cell.column];
  const rendered = [
    ...(column?.querySelectorAll<HTMLElement>("[data-scient-math-cell]") ?? []),
  ].filter((element) => element.closest(".ML__mtable") === table)[cell.row];
  return rendered?.getBoundingClientRect() ?? null;
}

function nearestCell(
  math: MathfieldElement,
  reference: MathCellSelection,
  x: number,
  y: number,
  geometry?: MathSelectionGeometry,
): MathCellSelection {
  let nearest = reference;
  let distance = Infinity;
  for (let row = 0; row < (reference.array.rowCount ?? 0); row += 1) {
    for (let column = 0; column < (reference.array.colCount ?? 0); column += 1) {
      const cell = mathCellAtCoordinates(math, reference, row, column);
      if (!cell) continue;
      const bounds = mathCellBounds(math, cell, geometry);
      if (!bounds) continue;
      const dx = Math.max(bounds.left - x, 0, x - bounds.right);
      const dy = Math.max(bounds.top - y, 0, y - bounds.bottom);
      const nextDistance = dx * dx + dy * dy;
      if (nextDistance < distance) {
        nearest = cell;
        distance = nextDistance;
      }
    }
  }
  return nearest;
}

function offsetInCell(
  math: MathfieldElement,
  cell: MathCellSelection,
  offset: number,
  x: number,
  y: number,
): number {
  if (offset >= cell.cell[0] && offset <= cell.cell[1]) return offset;
  let nearest = cell.cell[0];
  let distance = Infinity;
  for (let candidate = cell.cell[0]; candidate <= cell.cell[1]; candidate += 1) {
    const bounds = math.getElementInfo(candidate)?.bounds;
    if (!bounds) continue;
    const dx = Math.max(bounds.left - x, 0, x - bounds.right);
    const dy = Math.max(bounds.top - y, 0, y - bounds.bottom);
    const nextDistance = dx * dx + dy * dy;
    if (nextDistance < distance) {
      nearest =
        x < bounds.left + bounds.width / 2 ? Math.max(cell.cell[0], candidate - 1) : candidate;
      distance = nextDistance;
    }
  }
  return nearest;
}

export interface MathSelectionPoint {
  readonly x: number;
  readonly y: number;
  readonly offset: number;
  readonly path: readonly MathCellSelection[];
  readonly nearby: MathCellSelection | null;
}

export function mathSelectionPoint(
  math: MathfieldElement,
  x: number,
  y: number,
  offset = math.getOffsetFromPoint(x, y, { bias: 0 }),
  geometry?: MathSelectionGeometry,
): MathSelectionPoint {
  offset = Math.max(0, Math.min(offset, math.lastOffset));
  const index = geometry ?? createMathSelectionGeometry(math);
  let nearby: MathCellSelection | null = null;
  for (const candidate of [offset, offset - 1, offset + 1]) {
    const scopes = mathCellPathAt(math, candidate);
    nearby ??= scopes.at(0) ?? null;
  }
  const path: MathCellSelection[] = [];
  for (const scope of index.scopes) {
    const parent = path.at(-1);
    if (parent && !isInsideArray(scope.array, parent.array)) continue;
    const bounds = mathEnvironmentBounds(math, scope, index);
    if (!bounds || !containsPoint(bounds, x, y)) continue;
    path.push(nearestCell(math, scope, x, y, index));
  }
  const cell = path.at(-1);
  return {
    x,
    y,
    offset: cell ? offsetInCell(math, cell, offset, x, y) : offset,
    path,
    nearby,
  };
}

export function mathSelectionAtOffset(math: MathfieldElement, offset: number): MathSelectionPoint {
  const bounds = math.getElementInfo(offset)?.bounds;
  return {
    x: bounds ? bounds.left + bounds.width / 2 : 0,
    y: bounds ? bounds.top + bounds.height / 2 : 0,
    offset,
    path: mathCellPathAt(math, offset),
    nearby: null,
  };
}

export type MathDragSelection =
  | {
      readonly kind: "range";
      readonly range: readonly [number, number];
      readonly direction: "forward" | "backward";
    }
  | { readonly kind: "rectangle"; readonly rectangle: MathRectangleSelection };

interface MathBranchScope {
  readonly owner: MathAtom;
  readonly branch: unknown;
  readonly content: readonly [number, number];
  readonly whole: readonly [number, number];
}

/** Named branches are slots too: fraction bodies, scripts, brace/arrow labels, etc. */
function mathBranchPath(model: MathModel, offset: number): MathBranchScope[] {
  const result: MathBranchScope[] = [];
  let atom = model.at(offset);
  while (atom?.parent && !atom.parent.isRoot) {
    const owner = atom.parent;
    const branch = atom.parentBranch;
    const contents = owner.branch?.(branch);
    // Array branches retain their existing rectangle and visible-boundary rules.
    if (owner.type !== "array" && contents?.length && owner.leftSibling) {
      const from = model.offsetOf(contents[0]!);
      const to = model.offsetOf(contents[contents.length - 1]!);
      const before = model.offsetOf(owner.leftSibling);
      const after = model.offsetOf(owner);
      if (from >= 0 && to >= from && before >= 0 && after > before)
        result.push({ owner, branch, content: [from, to], whole: [before, after] });
    }
    atom = owner;
  }
  return result;
}

function mathBranchBounds(
  math: MathfieldElement,
  scope: MathBranchScope,
  geometry: MathSelectionGeometry,
): DOMRect | null {
  let branches = geometry.branches.get(scope.owner);
  if (!branches) {
    branches = new Map();
    geometry.branches.set(scope.owner, branches);
  }
  const cached = branches.get(scope.branch);
  if (cached !== undefined) return cached;
  let left = Infinity,
    top = Infinity,
    right = -Infinity,
    bottom = -Infinity;
  for (let offset = scope.content[0]; offset <= scope.content[1]; offset++) {
    const bounds = math.getElementInfo(offset)?.bounds;
    if (!bounds) continue;
    left = Math.min(left, bounds.left);
    top = Math.min(top, bounds.top);
    right = Math.max(right, bounds.right);
    bottom = Math.max(bottom, bounds.bottom);
  }
  const bounds = left === Infinity ? null : new DOMRect(left, top, right - left, bottom - top);
  branches.set(scope.branch, bounds);
  return bounds;
}

function includeCrossedMathBranches(
  math: MathfieldElement,
  anchor: MathSelectionPoint,
  head: MathSelectionPoint,
  range: readonly [number, number],
  geometry?: MathSelectionGeometry,
): readonly [number, number] {
  const model = mathModel(math);
  if (!model) return range;
  const anchorPath = mathBranchPath(model, anchor.offset);
  const headPath = mathBranchPath(model, head.offset);
  let [from, to] = range;
  const include = (
    path: MathBranchScope[],
    other: MathBranchScope[],
    point: MathSelectionPoint,
  ) => {
    for (const scope of path) {
      // Formatting boundaries do not make ordinary character selection atomic.
      if (isMathFormattingScope(scope.owner)) continue;
      const sameSlot = other.some(
        (candidate) => candidate.owner === scope.owner && candidate.branch === scope.branch,
      );
      const bounds = geometry ? mathBranchBounds(math, scope, geometry) : null;
      // Hit testing may keep returning the last character after the pointer has
      // already left its slot. Geometry disambiguates that for pointer drags;
      // keyboard selections use branch ownership alone.
      const inside =
        !bounds ||
        (point.x >= bounds.left - 2 &&
          point.x <= bounds.right + 2 &&
          point.y >= bounds.top - 2 &&
          point.y <= bounds.bottom + 2);
      if (sameSlot && inside) continue;
      from = Math.min(from, scope.whole[0]);
      to = Math.max(to, scope.whole[1]);
    }
  };
  include(anchorPath, headPath, head);
  include(headPath, anchorPath, anchor);
  return [from, to];
}

export function resolveMathDragSelection(
  math: MathfieldElement,
  anchor: MathSelectionPoint,
  head: MathSelectionPoint,
  direction?: "forward" | "backward",
  geometry?: MathSelectionGeometry,
): MathDragSelection {
  let common = 0;
  while (
    common < anchor.path.length &&
    common < head.path.length &&
    anchor.path[common]!.array === head.path[common]!.array
  )
    common += 1;

  if (common > 0) {
    const startCell = anchor.path[common - 1]!;
    const endCell = head.path[common - 1]!;
    if (startCell.row !== endCell.row || startCell.column !== endCell.column) {
      const rectangle = mathCellRectangle(math, startCell, endCell);
      if (rectangle) return { kind: "rectangle", rectangle };
    }
  }

  const startScope = anchor.path[common];
  const endScope = head.path[common];
  let crossingDirection: boolean | undefined;
  if (startScope && !endScope) {
    const bounds = mathEnvironmentBounds(math, startScope, geometry);
    if (bounds) {
      if (head.x < bounds.left) crossingDirection = false;
      else if (head.x > bounds.right) crossingDirection = true;
      else if (head.y < bounds.top) crossingDirection = false;
      else if (head.y > bounds.bottom) crossingDirection = true;
    }
  } else if (endScope && !startScope) {
    const bounds = mathEnvironmentBounds(math, endScope, geometry);
    if (bounds) {
      if (anchor.x < bounds.left) crossingDirection = true;
      else if (anchor.x > bounds.right) crossingDirection = false;
      else if (anchor.y < bounds.top) crossingDirection = true;
      else if (anchor.y > bounds.bottom) crossingDirection = false;
    }
  }
  const forward = direction
    ? direction === "forward"
    : (crossingDirection ??
      (Math.abs(head.y - anchor.y) < math.getBoundingClientRect().height / 2
        ? head.x >= anchor.x
        : head.offset >= anchor.offset));
  const start = startScope ? startScope.environment[forward ? 0 : 1] : anchor.offset;
  let end = endScope ? endScope.environment[forward ? 1 : 0] : head.offset;

  // Once the pointer leaves the anchor's nested array, the entire array is
  // part of the selection even if MathLive reports a nearby cell offset.
  if (startScope && !endScope) {
    const bounds = mathEnvironmentBounds(math, startScope, geometry);
    if (bounds && !forward && head.x < bounds.left) end = Math.min(end, startScope.environment[0]);
    if (bounds && forward && head.x > bounds.right) end = Math.max(end, startScope.environment[1]);
  }

  // MathLive can snap a hit to an array atom before the pointer reaches its
  // visible bounds. Keep the head outside the array until it is actually hit.
  if (!endScope && head.nearby) {
    const bounds = mathEnvironmentBounds(math, head.nearby, geometry);
    if (bounds && forward && head.x < bounds.left) end = Math.min(end, head.nearby.environment[0]);
    if (bounds && !forward && head.x > bounds.right)
      end = Math.max(end, head.nearby.environment[1]);
  }
  end = forward ? Math.max(start, end) : Math.min(start, end);
  return {
    kind: "range",
    range: includeCrossedMathBranches(
      math,
      anchor,
      head,
      [Math.min(start, end), Math.max(start, end)],
      geometry,
    ),
    direction: forward ? "forward" : "backward",
  };
}

export function mathCellRectangle(
  math: MathfieldElement,
  anchor: MathCellSelection,
  focus: MathCellSelection,
): MathRectangleSelection | null {
  const model = mathModel(math);
  if (!model || anchor.array !== focus.array) return null;
  const firstRow = Math.min(anchor.row, focus.row);
  const lastRow = Math.max(anchor.row, focus.row);
  const firstColumn = Math.min(anchor.column, focus.column);
  const lastColumn = Math.max(anchor.column, focus.column);
  const ranges: [number, number][] = [];
  const rows: string[] = [];
  for (let row = firstRow; row <= lastRow; row += 1) {
    const cells: string[] = Array.from({ length: firstColumn }, () => "");
    for (let column = firstColumn; column <= lastColumn; column += 1) {
      const atoms = anchor.array.getCell?.(row, column);
      if (!atoms?.length) return null;
      const range: [number, number] = [
        model.offsetOf(atoms[0]!),
        model.offsetOf(atoms[atoms.length - 1]!),
      ];
      if (range[0] < 0 || range[1] < range[0]) return null;
      ranges.push(range);
      cells.push(math.getValue(range, "latex-without-placeholders"));
    }
    rows.push(cells.join(" & "));
  }
  const environment = anchor.array.environmentName;
  const body = rows.join(" \\\\ ");
  return {
    anchor,
    focus,
    ranges,
    source:
      environment && environment !== "lines"
        ? `\\begin{${environment}}${body}\\end{${environment}}`
        : `\\begin{aligned}${body}\\end{aligned}`,
  };
}

export function selectMathRectangle(
  math: MathfieldElement,
  rectangle: MathRectangleSelection,
): void {
  const model = mathModel(math);
  if (!model || rectangle.ranges.length === 0) return;
  const first = rectangle.ranges[0]!;
  const last = rectangle.ranges[rectangle.ranges.length - 1]!;
  const start = Math.min(first[0], last[0]);
  const end = Math.max(first[1], last[1]);
  const backward =
    rectangle.focus.row < rectangle.anchor.row ||
    (rectangle.focus.row === rectangle.anchor.row &&
      rectangle.focus.column < rectangle.anchor.column);
  const direction = backward ? "backward" : "forward";
  // The public setter schedules MathLive's own selection paint but flattens
  // disjoint cell ranges. Restore the ranges before that paint runs.
  math.selection = { ranges: [[start, end]], direction };
  model._selection = {
    ranges: rectangle.ranges.map(([from, to]) => [from, to]),
    direction,
  };
  model._anchor = backward ? rectangle.anchor.cell[1] : rectangle.anchor.cell[0];
  model._position = backward ? rectangle.focus.cell[0] : rectangle.focus.cell[1];
  model.selectionDidChange();
}

/** Resolve a rendered empty-cell guide through the owning array's atom id. */
export function focusMathCellGuide(
  math: MathfieldElement,
  table: Element,
  row: number,
  column: number,
): boolean {
  const model = mathModel(math);
  if (!model || row < 0 || column < 0) return false;
  for (let element: Element | null = table; element; element = element.parentElement) {
    const id = element.getAttribute("data-atom-id");
    if (!id) continue;
    const array = model.atoms.find((atom) => atom.type === "array" && atom.id === id);
    if (!array) continue;
    const cell = arrayCell(model, array, row, column);
    if (!cell) return false;
    math.focus();
    math.position = cell.cell[0];
    return true;
  }
  return false;
}
