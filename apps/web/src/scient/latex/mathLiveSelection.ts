import type { MathfieldElement, Style } from "mathlive";
import { mathFormattingScopeCommand } from "./mathTextFormatting";

interface MathAtom {
  readonly id?: string;
  readonly type?: string;
  readonly style?: Readonly<Record<string, string | number | undefined>>;
  readonly command?: string;
  readonly args?: readonly unknown[];
  readonly skipBoundary?: boolean;
  readonly isFirstSibling?: boolean;
  readonly isLastSibling?: boolean;
  readonly inCaptureSelection?: boolean;
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
  readonly addRowAfter?: (row: number) => void;
  readonly branches?: readonly unknown[];
  readonly branch?: (name: unknown) => readonly MathAtom[] | undefined;
  readonly addChildrenAfter?: (
    children: readonly MathAtom[],
    after: MathAtom,
  ) => MathAtom | undefined;
  readonly removeChild?: (child: MathAtom) => void;
}

interface MathModel {
  readonly root?: MathAtom;
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
  readonly atomBoundsCache?: Map<string, unknown>;
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
  defaultStyle?: Style;
  styleBias?: "left" | "right" | "none";
}

/** Preserve native typing/history preparation while owning the pointer gesture. */
export function prepareMathPointerSelection(math: MathfieldElement): void {
  const controller = (math as unknown as { _mathfield?: MathMutationController })._mathfield;
  controller?.flushInlineShortcutBuffer?.();
  controller?.stopCoalescingUndo?.();
  refreshMathGeometry(math);
}

export function setMathPointerPosition(math: MathfieldElement, offset: number): void {
  const controller = (math as unknown as { _mathfield?: MathMutationController })._mathfield;
  if (controller && offset !== math.position) {
    const variantStyle = controller.defaultStyle?.variantStyle;
    controller.defaultStyle = variantStyle === undefined ? {} : { variantStyle };
    controller.styleBias = "left";
  }
  math.position = offset;
}

/** MathLive caches screen coordinates until rendering, even when an ancestor scrolls. */
function refreshMathGeometry(math: MathfieldElement): void {
  const controller = (math as unknown as { _mathfield?: MathMutationController })._mathfield;
  controller?.atomBoundsCache?.clear();
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

function mutateMath(
  math: MathfieldElement,
  action: (model: MathModel) => void,
  type = "deleteContentBackward",
): boolean {
  const controller = (math as unknown as { _mathfield?: MathMutationController })._mathfield;
  const model = mathModel(math);
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

/** Split the caret's math flow, keeping complete nested atoms and column positions. */
export function splitMathRow(math: MathfieldElement): string | null {
  const model = mathModel(math);
  if (math.readOnly || !model) return "This formula is not editable.";
  if (math.mode === "latex") return "Finish the math command before splitting the row.";
  let position = math.position;
  if (!math.selectionIsCollapsed) {
    const range = math.selection.ranges[0];
    if (
      math.selection.ranges.length !== 1 ||
      !range ||
      range[1] - range[0] !== 1 ||
      model.at(range[1]).type !== "placeholder"
    )
      return "Place the caret where the math row should split.";
    position = range[0];
  }
  const cursor = model.at(position);
  const parent = cursor.parent;
  const branch = cursor.parentBranch;
  if (!parent) return "Place the caret inside the math row.";
  const mode = math.mode;
  if (parent.type === "array" && Array.isArray(branch)) {
    const [row, column] = branch;
    if (
      typeof row !== "number" ||
      typeof column !== "number" ||
      !parent.addRowAfter ||
      !parent.setCell ||
      !parent.getCell
    )
      return "This math layout cannot split rows.";
    if ((parent.rowCount ?? 0) >= 20) return "This editor supports up to 20 rows.";
    const cell = parent.getCell(row, column);
    const index = cell?.indexOf(cursor) ?? -1;
    if (!cell || index < 0) return "Place the caret inside the math cell.";
    const before = cell.slice(0, index + 1).filter((atom) => atom.type !== "first");
    const tails = Array.from({ length: (parent.colCount ?? 0) - column }, (_, offset) =>
      (offset === 0 ? cell.slice(index + 1) : (parent.getCell!(row, column + offset) ?? [])).filter(
        (atom) => atom.type !== "first",
      ),
    );
    const changed = mutateMath(
      math,
      (current) => {
        parent.addRowAfter!(row);
        for (let offset = 0; offset < tails.length; offset++) {
          parent.setCell!(row, column + offset, offset === 0 ? before : []);
          parent.setCell!(row + 1, column + offset, tails[offset]!);
        }
        const first = parent.getCell!(row + 1, column)?.[0];
        if (first) math.position = current.offsetOf(first);
        math.executeCommand(["switchMode", mode]);
      },
      "insertLineBreak",
    );
    return changed ? null : "The math row could not be split.";
  }
  // A fraction/root body remains intact: add rows within its own flow rather
  // than extracting incomplete parts into the surrounding equation.
  const siblings = parent.branch?.(branch);
  if (!siblings?.length || !siblings.includes(cursor))
    return "This math slot cannot contain multiple rows.";
  const from = model.offsetOf(siblings[0]!);
  const to = model.offsetOf(siblings.at(-1)!);
  if (from < 0 || to < position || from > position) return "Place the caret inside the math row.";
  const before = math.getValue([from, position], "latex");
  const after = math.getValue([position, to], "latex");
  const selection = math.selection;
  math.selection = { ranges: [[from, to]] };
  const inserted = math.insert(
    `\\begin{gathered}${before || "#?"} \\\\ ${after || "#?"}\\end{gathered}`,
    {
      format: "latex",
      mode: "math",
      insertionMode: "replaceSelection",
      selectionMode: "after",
    },
  );
  if (!inserted) {
    math.selection = selection;
    return "The math row could not be split.";
  }
  const array = model.at(math.position);
  const first = array.type === "array" ? array.getCell?.(1, 0)?.[0] : null;
  if (first) math.position = model.offsetOf(first);
  math.executeCommand(["switchMode", mode]);
  return null;
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
      Boolean(mathFormattingScopeCommand(parent)) ||
      ["array", "genfrac", "surd", "leftright", "overunder", "box", "enclose"].includes(
        parent.type ?? "",
      )
    ) {
      const branch = parent.branch?.(child.parentBranch);
      if (branch?.length) {
        if (mathFormattingScopeCommand(parent) && branch.every(emptyMathSlot)) {
          wrapper = parent;
          break;
        }
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

/** Empty anonymous groups and placeholders contain no mathematical content. */
export function mathFieldIsEmpty(math: MathfieldElement): boolean {
  if (math.mode === "latex") return false;
  const model = mathModel(math);
  return model
    ? model.atoms.every(emptyMathSlot)
    : math.getValue("latex-without-placeholders").trim() === "";
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
  refreshMathGeometry(math);
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
    Boolean(mathFormattingScopeCommand(atom)) ||
    (atom.type === "group" &&
      (atom.skipBoundary === true ||
        /^\\(?:text|math)(?:bf|it|tt|rm|sf|sc|sl|up)?$/u.test(atom.command ?? "")))
  );
}

/** Accent bodies have less vertical room than the enclosing accented expression. */
export function mathCaretInAccentBody(math: MathfieldElement, offset = math.position): boolean {
  const model = mathModel(math);
  if (!model) return false;
  for (let atom = model.at(offset); atom?.parent; atom = atom.parent) {
    if (atom.parent.type === "accent" && atom.parentBranch === "body") return true;
  }
  return false;
}

/** Empty-slot guides belong to the nearest structural owner, excluding formatting. */
export function mathGuideScopeId(math: MathfieldElement): string | null {
  const model = mathModel(math);
  if (!model) return null;
  for (let atom = model.at(math.position); atom?.parent; atom = atom.parent) {
    const owner = atom.parent;
    if (owner.isRoot) return null;
    if (
      !isMathFormattingScope(owner) &&
      !(owner.type === "group" && owner.skipBoundary && !owner.command)
    )
      return owner.id ?? null;
  }
  return null;
}
function mathScriptOwner(atom: MathAtom): MathAtom | null {
  if (atom.type === "first") return null;
  if (atom.rightSibling?.type === "subsup") return atom.rightSibling;
  return atom.type === "subsup" ||
    atom.branch?.("superscript")?.length ||
    atom.branch?.("subscript")?.length
    ? atom
    : null;
}

/** The outer boundary includes scripts whether MathLive attaches or detaches them. */
function mathOwnerRange(model: MathModel, owner: MathAtom): [number, number] {
  const base = owner.type === "subsup" ? owner.leftSibling : null;
  const before = base && base.type !== "first" ? base.leftSibling : owner.leftSibling;
  const after = owner.rightSibling?.type === "subsup" ? owner.rightSibling : owner;
  return [before ? model.offsetOf(before) : 0, model.offsetOf(after)];
}

/** Selecting a complete base also selects scripts rendered beside that base. */
function includeCompleteMathScriptBases(
  model: MathModel,
  range: readonly [number, number],
): [number, number] {
  let from = Math.min(...range),
    to = Math.max(...range);
  if (from === to) return [from, to];
  for (
    let offset = Math.max(0, from + 1);
    offset <= Math.min(to, model.atoms.length - 1);
    offset++
  ) {
    const atom = model.at(offset);
    const script = atom ? mathScriptOwner(atom) : null;
    if (!script) continue;
    const base = script.type === "subsup" ? script.leftSibling : script;
    if (!base || base.type === "first") continue;
    const before = base.leftSibling ? model.offsetOf(base.leftSibling) : 0;
    const baseEnd = model.offsetOf(base);
    if (before < 0 || from > before || to < baseEnd) continue;
    const whole = mathOwnerRange(model, script);
    if (whole[0] >= 0 && whole[1] >= baseEnd) {
      from = Math.min(from, whole[0]);
      to = Math.max(to, whole[1]);
    }
  }
  return [from, to];
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
  underbrace: "Underbrace",
  overbrace: "Overbrace",
  textbf: "Bold",
  mathbf: "Bold",
  textit: "Italic",
  mathit: "Italic",
  texttt: "Monospace",
  mathtt: "Monospace",
  text: "Text",
  mathcal: "Calligraphic",
  mathbb: "Blackboard bold",
  mathfrak: "Fraktur",
  mathscr: "Script",
  mathrm: "Roman",
  mathsf: "Sans serif",
  mathnormal: "Math",
  mathbfit: "Bold italic",
  boldsymbol: "Bold",
  bm: "Bold",
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
  const script = atom ? mathScriptOwner(atom) : null;
  if (script) {
    const range = mathOwnerRange(model, script);
    result.push({ label: "Scripts", kind: "structure", range, exit: range });
  }
  while (atom?.parent && !atom.parent.isRoot) {
    const owner = atom.parent,
      branch = atom.parentBranch;
    const [before, after] = mathOwnerRange(model, owner);
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
          range: [before, after],
          exit: [before, after],
        });
      }
    } else {
      const contents = owner.branch?.(branch);
      const command = mathFormattingScopeCommand(owner) ?? owner.command?.replace(/^\\/u, "");
      const label =
        mathScopeLabels[command ?? ""] ?? mathScopeLabels[owner.type ?? ""] ?? command ?? "Group";
      if (contents?.length && after >= before) {
        const range: [number, number] = [
          model.offsetOf(contents[0]!),
          model.offsetOf(contents.at(-1)!),
        ];
        const whole: [number, number] = [before, after];
        if (isMathFormattingScope(owner)) {
          if (command && mathFormattingScopeCommand(owner)) {
            const styled = result.findIndex(
              (scope) =>
                scope.label === label &&
                scope.kind === "format" &&
                scope.range[0] === range[0] &&
                scope.range[1] === range[1],
            );
            const scope: MathEditingScope = { label, kind: "format", range, exit: whole };
            if (styled >= 0) result[styled] = scope;
            else result.push(scope);
          } else if (
            command &&
            !result.some((scope) => scope.label === label && scope.kind === "format")
          )
            result.push({ label, kind: "format", range, exit: whole });
        } else {
          const slotLabel =
            (command === "underbrace" || command === "overbrace") &&
            (branch === "subscript" || branch === "superscript")
              ? "Label"
              : branch === "above"
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
          if (owner.rightSibling?.type === "subsup") {
            const scripted = mathOwnerRange(model, owner.rightSibling);
            result.push({ label: "Scripts", kind: "structure", range: scripted, exit: scripted });
          }
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

const emptySlotAnchors = new WeakMap<HTMLElement, { baseline: HTMLElement; atom: MathAtom }>();
const caretBaselines = new WeakMap<HTMLElement, HTMLElement>();

/** A zero-size baseline anchor measures the same DOM stop where MathLive paints a caret. */
function mathCaretBaseline(after: HTMLElement): HTMLElement {
  let baseline = caretBaselines.get(after);
  if (!baseline || baseline.parentElement !== after.parentElement) {
    baseline = after.ownerDocument.createElement("span");
    baseline.setAttribute("data-scient-math-caret-anchor", "");
    baseline.setAttribute("aria-hidden", "true");
    after.after(baseline);
    caretBaselines.set(after, baseline);
  }
  return baseline;
}

/** Painted stroke bounds use the native baseline, pseudo-element offsets and local font size. */
export function mathCaretRect(
  math: MathfieldElement,
  caret: HTMLElement,
  inAccentBody = mathCaretInAccentBody(math),
): DOMRect {
  const baseline = caret.hasAttribute("data-scient-math-caret-anchor")
    ? caret
    : mathCaretBaseline(caret);
  const bounds = baseline.getBoundingClientRect();
  const after = getComputedStyle(caret, "::after");
  const scale = math.getBoundingClientRect().width / (math.offsetWidth || 1);
  const height = parseFloat(after.height) * scale * (inAccentBody ? 0.85 : 1);
  const width = parseFloat(after.borderRightWidth) * scale;
  return new DOMRect(
    bounds.left + parseFloat(after.left) * scale,
    bounds.top - parseFloat(after.bottom) * scale - height,
    width,
    height,
  );
}

function mathEmptySlotAnchor(math: MathfieldElement, slot: HTMLElement) {
  const cached = emptySlotAnchors.get(slot);
  if (cached?.baseline.isConnected) return cached;
  const model = mathModel(math);
  if (!model) return null;
  let atom: MathAtom | undefined;
  if (slot.hasAttribute("data-scient-math-cell")) {
    const table = slot.closest(".ML__mtable");
    const column = slot.closest(".col-align-l,.col-align-c,.col-align-r");
    if (!table || !column) return null;
    const columns = [...table.children].filter((element) =>
      element.matches(".col-align-l,.col-align-c,.col-align-r"),
    );
    const cells = [...column.querySelectorAll<HTMLElement>("[data-scient-math-cell]")].filter(
      (cell) => cell.closest(".ML__mtable") === table,
    );
    for (let element: Element | null = table; element; element = element.parentElement) {
      const id = element.getAttribute("data-atom-id");
      if (!id) continue;
      const array = [model.root, ...model.atoms].find(
        (candidate) => candidate?.type === "array" && candidate.id === id,
      );
      if (!array) continue;
      atom = array.getCell?.(cells.indexOf(slot), columns.indexOf(column))?.[0];
      break;
    }
  } else {
    const id = slot.closest("[data-atom-id]")?.getAttribute("data-atom-id");
    atom = id
      ? model.atoms.find((candidate) => candidate.id === id && candidate.type === "placeholder")
      : undefined;
  }
  if (!atom?.id) return null;
  const selector = `[data-atom-id="${CSS.escape(atom.id)}"]`;
  const rendered = slot.matches(selector) ? slot : slot.querySelector<HTMLElement>(selector);
  const after = rendered ?? math.shadowRoot?.querySelector<HTMLElement>(selector);
  if (!after) return null;
  const anchor = { baseline: mathCaretBaseline(after), atom };
  emptySlotAnchors.set(slot, anchor);
  return anchor;
}

/** Empty markers follow their insertion stop, without moving the native caret. */
export function mathEmptySlotRect(math: MathfieldElement, slot: HTMLElement): DOMRect {
  const anchor = mathEmptySlotAnchor(math, slot);
  const bounds = anchor
    ? mathCaretRect(
        math,
        anchor.baseline,
        mathCaretInAccentBody(math, mathModel(math)?.offsetOf(anchor.atom)),
      )
    : slot.getBoundingClientRect();
  const scale = math.getBoundingClientRect().width / (math.offsetWidth || 1);
  const em = parseFloat(getComputedStyle(anchor?.baseline ?? slot).fontSize) * scale;
  return new DOMRect(
    bounds.left + (bounds.width - 0.6 * em) / 2,
    bounds.top + (bounds.height - 0.75 * em) / 2,
    0.6 * em,
    0.75 * em,
  );
}

/** Marker painting and pointer placement refer to the same native model offset. */
export function mathEmptySlotOffset(math: MathfieldElement, slot: HTMLElement): number | null {
  const anchor = mathEmptySlotAnchor(math, slot);
  const offset = anchor ? mathModel(math)?.offsetOf(anchor.atom) : undefined;
  return offset !== undefined && offset >= 0 ? offset : null;
}

export function mathScopeRects(
  math: MathfieldElement,
  range: readonly [number, number],
): DOMRect[] {
  const rects = mathSelectionRects(math, [range]);
  if (rects.length) return rects;
  const caret = math.shadowRoot
    ?.querySelector(".ML__caret,.ML__text-caret")
    ?.getBoundingClientRect();
  return caret ? [caret] : [];
}

function isMathRowFlow(atom: MathAtom): boolean {
  return (
    atom.type === "array" &&
    /^(?:lines|align\*?|aligned|alignat\*?|alignedat|gather\*?|gathered|multline\*?|split|eqnarray\*?)$/u.test(
      atom.environmentName ?? "",
    ) &&
    (Boolean(atom.isRoot) ||
      (Boolean(atom.parent?.isRoot) &&
        (!atom.leftSibling || atom.leftSibling.type === "first") &&
        !atom.rightSibling))
  );
}

function unionMathRects(rectangles: readonly DOMRect[]): DOMRect | null {
  if (!rectangles.length) return null;
  const left = Math.min(...rectangles.map((rect) => rect.left)),
    top = Math.min(...rectangles.map((rect) => rect.top));
  const right = Math.max(...rectangles.map((rect) => rect.right)),
    bottom = Math.max(...rectangles.map((rect) => rect.bottom));
  return new DOMRect(left, top, Math.max(2, right - left), bottom - top);
}

/** Measure glyphs and printed rules, excluding VBox struts and caret anchors. */
function mathAtomInkBounds(math: MathfieldElement, atom: MathAtom): DOMRect | null {
  if (!atom.id || atom.type === "first") return null;
  const nodes = math.shadowRoot?.querySelectorAll<HTMLElement>(
    `[data-atom-id="${CSS.escape(atom.id)}"]`,
  );
  const rectangles: DOMRect[] = [];
  for (const node of nodes ?? []) {
    if (node.matches(".ML__pstrut,.ML__empty-line-anchor")) continue;
    if (atom.type === "placeholder") {
      const slot = node.matches(".ML__placeholder,[data-scient-math-slot]")
        ? node
        : node.querySelector<HTMLElement>(".ML__placeholder,[data-scient-math-slot]");
      if (slot) rectangles.push(mathEmptySlotRect(math, slot));
      continue;
    }
    for (const slot of node.querySelectorAll<HTMLElement>(
      ".ML__placeholder,[data-scient-math-slot]",
    ))
      rectangles.push(
        mathEmptySlotRect(
          math,
          slot.closest<HTMLElement>("[data-scient-math-cell][data-empty]") ?? slot,
        ),
      );
    const texts = math.ownerDocument.createTreeWalker(node, NodeFilter.SHOW_TEXT);
    for (let text = texts.nextNode(); text; text = texts.nextNode()) {
      if (
        !text.nodeValue?.trim() ||
        text.parentElement?.closest(".ML__pstrut,.ML__tooltip-content")
      )
        continue;
      const range = math.ownerDocument.createRange();
      range.selectNodeContents(text);
      for (const bounds of range.getClientRects())
        if (bounds.height > 0 && bounds.width > 0) rectangles.push(bounds);
    }
    for (const ink of node.querySelectorAll(
      "svg,.ML__frac-line,.ML__sqrt-line,.overline-line,.underline-line,.ML__rule,.ML__notation",
    )) {
      const bounds = ink.getBoundingClientRect();
      if (bounds.height > 0 && bounds.width > 0) rectangles.push(bounds);
    }
    if (node.matches("svg,.ML__frac-line,.ML__sqrt-line,.ML__rule,.ML__notation")) {
      const bounds = node.getBoundingClientRect();
      if (bounds.height > 0 && bounds.width > 0) rectangles.push(bounds);
    }
    if (atom.type === "spacing") {
      const bounds = node.getBoundingClientRect();
      if (bounds.height > 0 && bounds.width > 0) rectangles.push(bounds);
    }
  }
  return unionMathRects(rectangles);
}

/** One selection painter for partial content, complete cells and equation rows. */
export function mathSelectionRects(
  math: MathfieldElement,
  ranges: readonly (readonly [number, number])[],
  cellArray?: MathAtom,
): DOMRect[] {
  refreshMathGeometry(math);
  const model = mathModel(math);
  if (!model) return [];
  const empty: DOMRect[] = [];
  const selected = new Set<MathAtom>();
  for (const range of ranges) {
    const cell = mathCellPathAt(math, range[0]).at(-1);
    const rendered =
      cell && cell.cell[0] === range[0] && cell.cell[1] === range[1]
        ? mathRenderedCell(math, cell)
        : null;
    if (rendered?.hasAttribute("data-empty")) {
      const marker = mathEmptySlotRect(math, rendered);
      const inset = Math.min(1, marker.width / 4, marker.height / 4);
      empty.push(
        new DOMRect(
          marker.left + inset,
          marker.top + inset,
          marker.width - 2 * inset,
          marker.height - 2 * inset,
        ),
      );
      continue;
    }
    // Every range excludes its first caret offset; internal first atoms are
    // anchors too and must never borrow the bounds of an enclosing row.
    for (
      let offset = Math.max(0, range[0] + 1);
      offset <= Math.min(range[1], math.lastOffset);
      offset++
    ) {
      const atom = model.at(offset);
      if (atom?.type !== "first") selected.add(atom);
    }
  }
  const groups = new Map<string, DOMRect[]>();
  for (const atom of selected) {
    if (isMathRowFlow(atom)) continue;
    let key = "expression";
    for (let child = atom; child.parent; child = child.parent) {
      const owner = child.parent;
      const branch = child.parentBranch;
      if (Array.isArray(branch) && (isMathRowFlow(owner) || owner === cellArray))
        key = `${owner.id ?? "root"}:${branch[0]}${isMathRowFlow(owner) ? "" : `:${branch[1]}`}`;
    }
    // A selected owner's rendered box may omit its scripts; detached subsup
    // atoms have no bound box at all. Measure selected children as well and
    // merge their ink into the same row rectangle, without another paint layer.
    const bounds = mathAtomInkBounds(math, atom);
    if (!bounds) continue;
    const group = groups.get(key) ?? [];
    group.push(bounds);
    groups.set(key, group);
  }
  return [
    ...empty,
    ...[...groups.values()].flatMap((rects) => {
      const bounds = unionMathRects(rects);
      return bounds ? [bounds] : [];
    }),
  ];
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
  offset = math.position,
): { position: number; intent: number } | null {
  const model = mathModel(math);
  if (!model) return null;
  const x = intent ?? mathSelectionAtOffset(math, offset).x;
  const nearest = (contents: readonly MathAtom[]) => {
    let position = model.offsetOf(contents[0]!),
      distance = Infinity;
    for (const atom of contents) {
      const candidate = model.offsetOf(atom);
      if (candidate < 0) continue;
      const dx = Math.abs(x - mathSelectionAtOffset(math, candidate).x);
      if (dx < distance) {
        position = candidate;
        distance = dx;
      }
    }
    return { position, intent: x };
  };
  let atom = model.at(offset);
  while (atom?.parent) {
    const owner = atom.parent,
      branch = atom.parentBranch;
    if (owner.type === "array" && Array.isArray(branch)) {
      const contents = owner.getCell?.(branch[0] + direction, branch[1]);
      if (contents?.length) return nearest(contents);
    } else if ((branch === "above" && direction > 0) || (branch === "below" && direction < 0)) {
      const contents = owner.branch?.(direction < 0 ? "above" : "below");
      if (contents?.length) return nearest(contents);
    }
    if (owner.isRoot) break;
    atom = owner;
  }
  return null;
}

/** Visit native caret stops without invoking MathLive's separate range-expansion rules. */
export function mathHorizontalSelectionTarget(
  math: MathfieldElement,
  offset: number,
  direction: -1 | 1,
): number {
  const model = mathModel(math);
  if (!model) return Math.max(0, Math.min(math.lastOffset, offset + direction));
  for (let next = offset + direction; next >= 0 && next <= math.lastOffset; next += direction) {
    const atom = model.at(next);
    let captured = false;
    for (let parent = atom.parent; parent; parent = parent.parent)
      if (parent.inCaptureSelection) {
        captured = true;
        break;
      }
    if (captured) continue;
    if (
      atom.parent?.skipBoundary &&
      (atom.type === "first" || (!atom.isFirstSibling && atom.isLastSibling))
    )
      continue;
    return next;
  }
  return direction < 0 ? 0 : math.lastOffset;
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
  const environmentEnd = array.isRoot ? model.atoms.length - 1 : model.offsetOf(array);
  const firstCell = array.getCell?.(0, 0);
  const beforeFirstCell = firstCell?.[0] ? model.offsetOf(firstCell[0]) - 1 : -1;
  const predecessor = array.leftSibling ? model.offsetOf(array.leftSibling) : -1;
  const environmentStart = array.isRoot ? 0 : predecessor >= 0 ? predecessor : beforeFirstCell;
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
  const rendered = mathRenderedCellBounds(math, cell);
  const ink = unionMathRects(mathSelectionRects(math, [cell.cell]));
  // Preserve column hit width while deriving the row's height from its content.
  // A VBox can extend through the row gap and is not a useful vertical target.
  const bounds =
    ink && rendered
      ? new DOMRect(
          Math.min(rendered.left, ink.left),
          ink.top,
          Math.max(rendered.right, ink.right) - Math.min(rendered.left, ink.left),
          ink.height,
        )
      : (ink ?? rendered);
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
  const rendered = mathRenderedCell(math, cell);
  if (!rendered) return null;
  const bounds = rendered.getBoundingClientRect();
  if (!rendered.hasAttribute("data-empty")) return bounds;
  // Empty native spans can have zero height. The visible marker is also a
  // navigation target, including when a drag starts above the row baseline.
  const marker = mathEmptySlotRect(math, rendered);
  const left = Math.min(bounds.left, marker.left),
    top = Math.min(bounds.top, marker.top);
  return new DOMRect(
    left,
    top,
    Math.max(bounds.right, marker.right) - left,
    Math.max(bounds.bottom, marker.bottom) - top,
  );
}

function mathRenderedCell(math: MathfieldElement, cell: MathCellSelection): HTMLElement | null {
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
  return rendered ?? null;
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
  for (const slot of math.shadowRoot?.querySelectorAll<HTMLElement>(
    "[data-scient-math-cell][data-empty][data-guide-active],.ML__placeholder[data-guide-active],[data-scient-math-slot][data-guide-active]",
  ) ?? []) {
    if (
      !slot.hasAttribute("data-scient-math-cell") &&
      slot.closest("[data-scient-math-cell][data-empty]")
    )
      continue;
    if (!containsPoint(mathEmptySlotRect(math, slot), x, y)) continue;
    const insertion = mathEmptySlotOffset(math, slot);
    if (insertion !== null)
      return { x, y, offset: insertion, path: mathCellPathAt(math, insertion), nearby: null };
  }
  // MathLive can resolve a closing fence to the adjacent script sentinel.
  // Use the actual delimiter hit target before resolving enclosing grid cells.
  const delimiter = math.shadowRoot
    ?.elementFromPoint?.(x, y)
    ?.closest<HTMLElement>(".ML__open,.ML__close");
  const model = mathModel(math);
  const fence = delimiter?.dataset.atomId
    ? model?.atoms.find((atom) => atom.id === delimiter.dataset.atomId && atom.type === "leftright")
    : null;
  if (fence && model && delimiter) {
    const bounds = delimiter.getBoundingClientRect();
    const rightHalf = x >= bounds.left + bounds.width / 2;
    const body = fence.branch?.("body");
    const boundary = delimiter.classList.contains("ML__close")
      ? rightHalf
        ? fence
        : body?.at(-1)
      : rightHalf
        ? body?.[0]
        : fence.leftSibling;
    if (boundary) offset = model.offsetOf(boundary);
  }
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
  const atom = mathModel(math)?.at(offset);
  const first = atom?.type === "first";
  const target = first ? atom.rightSibling : atom;
  const bounds = target ? mathAtomInkBounds(math, target) : null;
  const path = mathCellPathAt(math, offset);
  const cell = path.at(-1);
  const rendered = cell ? mathRenderedCell(math, cell) : null;
  const empty =
    !bounds && cell
      ? rendered?.hasAttribute("data-empty")
        ? mathEmptySlotRect(math, rendered)
        : mathCellBounds(math, cell)
      : null;
  return {
    x: bounds ? (first ? bounds.left : bounds.right) : empty ? empty.left + empty.width / 2 : 0,
    y: bounds ? bounds.top + bounds.height / 2 : empty ? empty.top + empty.height / 2 : 0,
    offset,
    path,
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

const scriptedExpressionBranch = Symbol("scripted-expression");

/** Named branches are slots too: fraction bodies, scripts, brace/arrow labels, etc. */
function mathBranchPath(model: MathModel, offset: number): MathBranchScope[] {
  const result: MathBranchScope[] = [];
  let atom = model.at(offset);
  while (atom?.parent) {
    // A base and its script may be siblings rather than a shared model parent.
    // Give both the same enclosing scope, including when the endpoint is the base.
    const script = mathScriptOwner(atom);
    if (script) {
      const whole = mathOwnerRange(model, script);
      if (whole[0] >= 0 && whole[1] > whole[0])
        result.push({
          owner: script,
          branch: scriptedExpressionBranch,
          content: [whole[0] + 1, whole[1]],
          whole,
        });
    }
    const owner = atom.parent;
    if (owner.isRoot) break;
    const branch = atom.parentBranch;
    const contents = owner.branch?.(branch);
    // Array branches retain their existing rectangle and visible-boundary rules.
    if (owner.type !== "array" && contents?.length && owner.leftSibling) {
      const from = model.offsetOf(contents[0]!);
      const to = model.offsetOf(contents[contents.length - 1]!);
      const [before, after] = mathOwnerRange(model, owner);
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
  const bounds = unionMathRects(
    mathSelectionRects(math, [
      scope.branch === scriptedExpressionBranch ? scope.whole : scope.content,
    ]),
  );
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
  const backward =
    rectangle.focus.row < rectangle.anchor.row ||
    (rectangle.focus.row === rectangle.anchor.row &&
      rectangle.focus.column < rectangle.anchor.column);
  const direction = backward ? "backward" : "forward";
  applyMathSelection(
    math,
    { ranges: rectangle.ranges.map(([from, to]) => [from, to]), direction },
    {
      anchor: backward ? rectangle.anchor.cell[1] : rectangle.anchor.cell[0],
      head: backward ? rectangle.focus.cell[0] : rectangle.focus.cell[1],
    },
  );
}

/** Our scope rules determine ranges; the native setter only schedules rendering. */
export function applyMathSelection(
  math: MathfieldElement,
  selection: MathfieldElement["selection"],
  endpoints?: { readonly anchor: number; readonly head: number },
): void {
  const model = mathModel(math);
  if (!model || !selection.ranges.length) {
    math.selection = selection;
    return;
  }
  const ranges = selection.ranges.map((range) => includeCompleteMathScriptBases(model, range));
  const from = Math.min(...ranges.flat()),
    to = Math.max(...ranges.flat());
  const direction = selection.direction ?? "none";
  // MathLive expands attached scripts and flattens cells in its public setter.
  // Restore the resolved ranges before either its renderer or ours reads them.
  math.selection = { ranges: [[from, to]], direction };
  model._selection = {
    ranges,
    direction,
  };
  model._anchor = endpoints?.anchor ?? (direction === "backward" ? to : from);
  model._position = endpoints?.head ?? (direction === "backward" ? from : to);
  model.selectionDidChange();
}
