import type { MathfieldElement } from "mathlive";
import { registerLatexSelection } from "./latexSelectionSession";
import { latexContainerScope } from "./latexStructuredSelection";
import {
  mathEditingScopes,
  mathScopeRects,
  mathSelectionRevision,
  mathCellRectangle,
  mathSelectionAtOffset,
  type MathRectangleSelection,
} from "./mathLiveSelection";

export function installMathSelectionSession(
  math: MathfieldElement,
  options: {
    rectangle: () => MathRectangleSelection | null;
    apply: (
      selection: MathfieldElement["selection"],
      rectangle: MathRectangleSelection | null,
    ) => void;
    exit: (direction: -1 | 1) => void;
  },
) {
  const history: {
    selection: MathfieldElement["selection"];
    rectangle: MathRectangleSelection | null;
  }[] = [];
  let expanding = false;
  let candidates = mathEditingScopes(math);
  const copySelection = () => ({
    ranges: math.selection.ranges.map(([from, to]) => [from, to] as [number, number]),
    direction: math.selection.direction ?? "none",
  });
  const session = registerLatexSelection({
    element: math,
    capture: () => {
      const selection = copySelection(),
        rectangle = options.rectangle();
      const revision = mathSelectionRevision(math),
        value = math.getValue();
      const scopes = mathEditingScopes(math);
      return {
        path: [...latexContainerScope(math), ...scopes.toReversed().map((scope) => scope.label)],
        selectionOverlay: Boolean(rectangle),
        scopes: () => scopes.slice(0, 2).flatMap((scope) => mathScopeRects(math, scope.range)),
        selection: () =>
          rectangle
            ? rectangle.ranges.flatMap((range) => mathScopeRects(math, range))
            : selection.ranges.flatMap((range) =>
                range[0] === range[1] ? [] : mathScopeRects(math, range),
              ),
        restore: (focus) => {
          if (
            !math.isConnected ||
            mathSelectionRevision(math) !== revision ||
            math.getValue() !== value
          )
            return false;
          options.apply(selection, rectangle);
          if (focus) math.focus();
          return true;
        },
      };
    },
    command: (command) => {
      if (math.readOnly) return false;
      if (command === "selectionShrink") {
        const previous = history.pop();
        if (!previous) return false;
        expanding = true;
        options.apply(previous.selection, previous.rectangle);
        expanding = false;
      } else if (command === "selectionExpand") {
        if (!history.length) candidates = mathEditingScopes(math);
        const ranges = math.selection.ranges;
        const from = Math.min(...ranges.flat()),
          to = Math.max(...ranges.flat());
        // A blank cell is a scope despite its collapsed numeric range.
        const scope = candidates.find(
          (candidate) =>
            candidate.range[0] <= from &&
            candidate.range[1] >= to &&
            (candidate.range[0] < from ||
              candidate.range[1] > to ||
              (candidate.kind === "cell" && math.selectionIsCollapsed && !options.rectangle())),
        );
        if (!scope) return false;
        history.push({ selection: copySelection(), rectangle: options.rectangle() });
        expanding = true;
        const cell =
          scope.kind === "cell" && scope.range[0] === scope.range[1]
            ? mathSelectionAtOffset(math, math.position).path.at(-1)
            : null;
        options.apply(
          { ranges: [[...scope.range]], direction: "forward" },
          cell ? mathCellRectangle(math, cell, cell) : null,
        );
        expanding = false;
      } else {
        history.length = 0;
        const scope = mathEditingScopes(math)[0];
        const direction = command === "leaveParentBefore" ? -1 : 1;
        if (!scope || scope.kind === "equation") {
          options.exit(direction);
          return true;
        } else {
          expanding = true;
          const position = scope.exit[direction < 0 ? 0 : 1];
          options.apply({ ranges: [[position, position]] }, null);
          if (scope.leaveStyle) math.applyStyle(scope.leaveStyle);
          expanding = false;
        }
      }
      if (math.isConnected) math.focus();
      return true;
    },
  });
  const changed = () => {
    if (!expanding) history.length = 0;
    session.refresh();
  };
  const input = () => {
    history.length = 0;
    session.refresh();
  };
  math.addEventListener("selection-change", changed);
  math.addEventListener("input", input);
  return {
    refresh: session.refresh,
    dispose: () => {
      session.dispose();
      math.removeEventListener("selection-change", changed);
      math.removeEventListener("input", input);
    },
  };
}
