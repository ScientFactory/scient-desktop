import type { MathfieldElement } from "mathlive";
import { enterMathFormattingArgument } from "./mathTextFormatting";
import { registerLatexSelection } from "./latexSelectionSession";
import { mathEditingGuideRects } from "./mathEditingGuides";
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
    scopeIndex: number;
  }[] = [];
  let expanding = false;
  let candidates = mathEditingScopes(math);
  let scopeIndex = 0;
  const copySelection = () => ({
    ranges: math.selection.ranges.map(([from, to]) => [from, to] as [number, number]),
    direction: math.selection.direction ?? "none",
  });
  const selectionStyle = document.createElement("style");
  selectionStyle.textContent = `
    .ML__selection { opacity: 0 !important; }
    .ML__empty-line-anchor.ML__selected::after { background: transparent !important; }
  `;
  math.shadowRoot?.append(selectionStyle);
  const session = registerLatexSelection({
    element: math,
    capture: () => {
      const selection = copySelection(),
        rectangle = options.rectangle();
      const revision = mathSelectionRevision(math),
        value = math.getValue();
      const selectedScope = candidates[scopeIndex - 1];
      const scopeSelected =
        history.length > 0 &&
        selectedScope &&
        selection.ranges.length === 1 &&
        selection.ranges[0]![0] === selectedScope.range[0] &&
        selection.ranges[0]![1] === selectedScope.range[1];
      const scopes = scopeSelected ? candidates.slice(scopeIndex - 1) : mathEditingScopes(math);
      return {
        path: [...latexContainerScope(math), ...scopes.toReversed().map((scope) => scope.label)],
        selectionOverlay: Boolean(rectangle) || selection.ranges.some(([from, to]) => from !== to),
        selectionKind: rectangle ? ("cells" as const) : ("text" as const),
        scopePadding: 0,
        scopes: () => mathEditingGuideRects(math),
        selection: () =>
          rectangle
            ? rectangle.ranges.flatMap((range) => mathScopeRects(math, range))
            : selection.ranges.flatMap((range) =>
                range[0] === range[1] ? [] : mathScopeRects(math, range, true),
              ),
        restore: (focus) => {
          if (
            !math.isConnected ||
            mathSelectionRevision(math) !== revision ||
            math.getValue() !== value
          )
            return false;
          expanding = true;
          options.apply(selection, rectangle);
          if (focus) math.focus();
          lastSelection = JSON.stringify(math.selection.ranges);
          expanding = false;
          return true;
        },
      };
    },
    command: (command) => {
      if (math.readOnly) return false;
      if (command === "enterScope") {
        if (!enterMathFormattingArgument(math, true)) return false;
        history.length = 0;
        scopeIndex = 0;
        lastSelection = JSON.stringify(math.selection.ranges);
        math.focus();
        session.refresh();
        return true;
      }
      if (command === "selectionShrink") {
        const previous = history.pop();
        if (!previous) return false;
        expanding = true;
        scopeIndex = previous.scopeIndex;
        options.apply(previous.selection, previous.rectangle);
        expanding = false;
      } else if (command === "selectionExpand" || command === "selectionScopeExpand") {
        if (!history.length) candidates = mathEditingScopes(math);
        const ranges = math.selection.ranges;
        const from = Math.min(...ranges.flat()),
          to = Math.max(...ranges.flat());
        // A blank cell is a scope despite its collapsed numeric range.
        const next = candidates.findIndex(
          (candidate, index) =>
            (command !== "selectionScopeExpand" || index >= scopeIndex) &&
            candidate.range[0] <= from &&
            candidate.range[1] >= to &&
            (command === "selectionScopeExpand" ||
              candidate.range[0] < from ||
              candidate.range[1] > to ||
              (candidate.kind === "cell" && math.selectionIsCollapsed && !options.rectangle())),
        );
        const scope = candidates[next];
        if (!scope) return false;
        history.push({ selection: copySelection(), rectangle: options.rectangle(), scopeIndex });
        scopeIndex = next + 1;
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
        scopeIndex = 0;
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
      lastSelection = JSON.stringify(math.selection.ranges);
      if (math.isConnected) math.focus();
      return true;
    },
  });
  let lastSelection = JSON.stringify(math.selection.ranges);
  const reset = () => {
    history.length = 0;
    scopeIndex = 0;
  };
  const changed = () => {
    const selection = JSON.stringify(math.selection.ranges);
    if (!expanding && selection !== lastSelection) reset();
    lastSelection = selection;
    session.refresh();
  };
  const input = () => {
    reset();
    session.refresh();
  };
  const keydown = (event: KeyboardEvent) => {
    if (["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End"].includes(event.key))
      reset();
  };
  math.addEventListener("keydown", keydown);
  math.addEventListener("selection-change", changed);
  math.addEventListener("input", input);
  math.addEventListener("pointerdown", reset);
  return {
    refresh: session.refresh,
    dispose: () => {
      session.dispose();
      selectionStyle.remove();
      math.removeEventListener("keydown", keydown);
      math.removeEventListener("selection-change", changed);
      math.removeEventListener("input", input);
      math.removeEventListener("pointerdown", reset);
    },
  };
}
