import type { MathfieldElement } from "mathlive";

interface MathAtom {
  readonly type?: string;
  readonly isRoot?: boolean;
  readonly environmentName?: string;
  readonly parent?: MathAtom | null;
  readonly parentBranch?: unknown;
  readonly leftSibling?: MathAtom | null;
  readonly rowCount?: number;
  readonly colCount?: number;
  readonly getCell?: (row: number, column: number) => readonly MathAtom[] | undefined;
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
}

export interface MathCellSelection {
  readonly array: MathAtom;
  readonly row: number;
  readonly column: number;
  readonly cell: readonly [number, number];
  readonly environment: readonly [number, number];
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
  return { arrays: new WeakMap(), cells: new WeakMap(), scopes };
}

// MathLive 0.108 exposes offsets publicly but not the array cell that owns an
// offset. Keep the small model read here, at the library boundary.
function mathModel(math: MathfieldElement): MathModel | null {
  const model = (math as unknown as { _mathfield?: { model?: MathModel } })._mathfield?.model;
  if (!model || typeof model.at !== "function" || typeof model.offsetOf !== "function") return null;
  return model;
}

export function mathSelectionEndpoints(math: MathfieldElement): readonly [number, number] | null {
  const model = mathModel(math);
  return model ? [model.anchor, model.position] : null;
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
  const path = mathCellPathAt(math, offset);
  const exact = [...path].reverse().find((cell) => cell.column === 0 && offset === cell.cell[0]);
  if (exact) return exact;
  const caret = math.shadowRoot?.querySelector(".ML__caret, .ML__text-caret");
  if (!caret) return null;
  const bounds = caret.getBoundingClientRect();
  const x = bounds.right;
  const y = bounds.top + bounds.height / 2;
  const cell = [...mathSelectionPoint(math, x, y).path]
    .reverse()
    .find((candidate) => candidate.column === 0);
  if (!cell) return null;
  for (let index = cell.cell[0] + 1; index <= cell.cell[1]; index += 1) {
    const first = math.getElementInfo(index)?.bounds;
    if (first) return x <= first.left + first.width / 2 ? cell : null;
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
  const bounds = left === Infinity ? null : new DOMRect(left, top, right - left, bottom - top);
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
    range: [Math.min(start, end), Math.max(start, end)],
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
