import {
  countStrongScripts,
  countTableStrongScripts,
  normalizeRtlFlowArrows,
  resolveAggregateDirection,
  resolveDominantDirectionFromCounts,
  resolveProseBlockDirection,
  resolveTableCellDirection,
  resolveTableColumnDirectionFromCounts,
  type ContentDirection,
  type FixedContentDirection,
  type StrongScriptCounts,
} from "./contentDirection";

type BidiNode = {
  readonly type?: string;
  readonly tagName?: string;
  readonly children?: BidiNode[];
  value?: string;
  properties?: Record<string, unknown>;
};

const DIRECTIONAL_BLOCK_TAGS = new Set([
  "p",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "blockquote",
  "details",
  "summary",
  "section",
]);
const HEADING_TAGS = new Set(["h1", "h2", "h3", "h4", "h5", "h6"]);
const LIST_TAGS = new Set(["ul", "ol"]);
const LOCAL_DIRECTION_TAGS = new Set(DIRECTIONAL_BLOCK_TAGS);
const TABLE_CELL_TAGS = new Set(["th", "td"]);
const NON_PROSE_TAGS = new Set(["a", "code", "math", "pre", "script", "style"]);
const ZERO_COUNTS: StrongScriptCounts = { ltr: 0, rtl: 0 };

interface TableCellPlacement {
  readonly column: number;
  readonly columnSpan: number;
  readonly node: BidiNode;
}

/**
 * Arrows that receive visual styling in RTL prose. The basic `←` (U+2190)
 * looks fine from its Arial fallback and is intentionally excluded. The
 * double `⇐`, long `⟵`, and long double `⟸` come from thinner fallback fonts
 * (Hiragino Sans, STIX Two Math) and need thickening. The long single `⟵`
 * additionally sits below the text baseline because STIX Two Math uses math
 * metrics, so it gets a small vertical lift.
 */
const STYLED_RTL_ARROWS = new Set(["⇐", "⟵", "⟸"]);
const LIFTED_RTL_ARROW = "⟵";

function setDirection(node: BidiNode, direction: FixedContentDirection): void {
  node.properties ??= {};
  node.properties.dir = direction;
}

function plainText(node: BidiNode): string {
  if (node.type === "element" && (node.tagName === "code" || node.tagName === "pre")) {
    return "";
  }
  if (node.type === "text") return node.value ?? "";
  return node.children?.map(plainText).join("") ?? "";
}

function tableProseText(node: BidiNode): string {
  if (
    node.type === "element" &&
    node.tagName &&
    (node.tagName === "code" ||
      node.tagName === "math" ||
      node.tagName === "pre" ||
      node.tagName === "script" ||
      node.tagName === "style")
  ) {
    return "";
  }
  if (node.type === "text") return node.value ?? "";
  return node.children?.map(tableProseText).join(" ") ?? "";
}

function addCounts(left: StrongScriptCounts, right: StrongScriptCounts): StrongScriptCounts {
  return { ltr: left.ltr + right.ltr, rtl: left.rtl + right.rtl };
}

function positiveSpan(value: unknown): number {
  const parsed = typeof value === "number" ? value : Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 1;
}

function tableRows(table: BidiNode): BidiNode[][] {
  const rows: BidiNode[][] = [];
  const directCells =
    table.children?.filter(
      (child) => child.type === "element" && child.tagName && TABLE_CELL_TAGS.has(child.tagName),
    ) ?? [];
  if (directCells.length > 0) rows.push(directCells);

  function collect(node: BidiNode): void {
    if (node !== table && node.type === "element" && node.tagName === "table") return;
    if (node.type === "element" && node.tagName === "tr") {
      rows.push(
        node.children?.filter(
          (child) =>
            child.type === "element" && child.tagName && TABLE_CELL_TAGS.has(child.tagName),
        ) ?? [],
      );
      return;
    }
    node.children?.forEach(collect);
  }

  table.children
    ?.filter((child) => !directCells.includes(child))
    .forEach((child) => collect(child));
  return rows;
}

function tableCellPlacements(table: BidiNode): TableCellPlacement[] {
  const placements: TableCellPlacement[] = [];
  const occupiedUntil: number[] = [];

  tableRows(table).forEach((row, rowIndex) => {
    let column = 0;
    for (const cell of row) {
      while ((occupiedUntil[column] ?? 0) > rowIndex) column += 1;
      const properties = cell.properties ?? {};
      const columnSpan = positiveSpan(properties.colSpan ?? properties.colspan);
      const rowSpan = positiveSpan(properties.rowSpan ?? properties.rowspan);
      placements.push({ column, columnSpan, node: cell });
      for (let offset = 0; offset < columnSpan; offset += 1) {
        occupiedUntil[column + offset] = Math.max(
          occupiedUntil[column + offset] ?? 0,
          rowIndex + rowSpan,
        );
      }
      column += columnSpan;
    }
  });
  return placements;
}

function resolveTableColumnDirections(
  table: BidiNode,
  tableDirection: FixedContentDirection,
  forcedDirection?: FixedContentDirection,
): Map<BidiNode, FixedContentDirection> {
  const placements = tableCellPlacements(table);
  const proseCounts: StrongScriptCounts[] = [];
  const rawCounts: StrongScriptCounts[] = [];

  for (const placement of placements) {
    const text = tableProseText(placement.node);
    const cellProseCounts = countTableStrongScripts(text);
    const cellRawCounts = countStrongScripts(text);
    for (let offset = 0; offset < placement.columnSpan; offset += 1) {
      const column = placement.column + offset;
      proseCounts[column] = addCounts(proseCounts[column] ?? ZERO_COUNTS, cellProseCounts);
      rawCounts[column] = addCounts(rawCounts[column] ?? ZERO_COUNTS, cellRawCounts);
    }
  }

  const width = Math.max(proseCounts.length, rawCounts.length);
  const columnDirections = Array.from({ length: width }, (_, column) =>
    forcedDirection
      ? forcedDirection
      : resolveTableColumnDirectionFromCounts(
          proseCounts[column] ?? ZERO_COUNTS,
          rawCounts[column] ?? ZERO_COUNTS,
          tableDirection,
        ),
  );
  const result = new Map<BidiNode, FixedContentDirection>();
  for (const placement of placements) {
    const directions = columnDirections.slice(
      placement.column,
      placement.column + placement.columnSpan,
    );
    result.set(
      placement.node,
      directions.every((direction) => direction === directions[0])
        ? (directions[0] ?? tableDirection)
        : tableDirection,
    );
  }
  return result;
}

function hasAuthoredCellAlignment(node: BidiNode): boolean {
  const align = node.properties?.align;
  if (align === "left" || align === "center" || align === "right") return true;
  const style = node.properties?.style;
  if (typeof style === "string") return /(?:^|;)\s*text-align\s*:/iu.test(style);
  return (
    typeof style === "object" &&
    style !== null &&
    "textAlign" in style &&
    typeof style.textAlign === "string"
  );
}

function hasStyledArrow(value: string): boolean {
  for (const char of value) {
    if (STYLED_RTL_ARROWS.has(char)) return true;
  }
  return false;
}

function splitTextWithArrowSpans(value: string): BidiNode[] {
  const segments: BidiNode[] = [];
  let lastIndex = 0;
  for (let i = 0; i < value.length; i++) {
    const char = value[i];
    if (char !== undefined && STYLED_RTL_ARROWS.has(char)) {
      if (i > lastIndex) {
        segments.push({ type: "text", value: value.slice(lastIndex, i) });
      }
      const className =
        char === LIFTED_RTL_ARROW
          ? ["scient-flow-arrow", "scient-flow-arrow-long"]
          : ["scient-flow-arrow"];
      segments.push({
        type: "element",
        tagName: "span",
        properties: { className },
        children: [{ type: "text", value: char }],
      });
      lastIndex = i + 1;
    }
  }
  if (lastIndex < value.length) {
    segments.push({ type: "text", value: value.slice(lastIndex) });
  }
  return segments;
}

/** Sets semantic `dir` after sanitize, and wraps a few RTL flow arrows for styling. */
export function rehypeScientBidi(options: {
  readonly direction: FixedContentDirection;
  /** The user setting, so an explicit mode remains authoritative for lists. */
  readonly requestedDirection?: ContentDirection;
}) {
  return (tree: BidiNode) => {
    const tableColumnDirections = new WeakMap<BidiNode, FixedContentDirection>();
    function processChildren(
      parent: BidiNode,
      inheritedDirection: FixedContentDirection | undefined,
      tableDirection: FixedContentDirection | undefined,
      flowDirection: FixedContentDirection,
      flowArrowEligible: boolean,
    ): void {
      if (!parent.children) return;
      const canWrapArrows =
        flowArrowEligible && options.direction === "rtl" && flowDirection === "rtl";
      if (!canWrapArrows) {
        parent.children.forEach((child) =>
          visit(child, inheritedDirection, tableDirection, flowDirection, flowArrowEligible),
        );
        return;
      }
      const newChildren: BidiNode[] = [];
      for (const child of parent.children) {
        visit(child, inheritedDirection, tableDirection, flowDirection, flowArrowEligible);
        if (child.type === "text" && child.value && hasStyledArrow(child.value)) {
          newChildren.push(...splitTextWithArrowSpans(child.value));
        } else {
          newChildren.push(child);
        }
      }
      parent.children.splice(0, parent.children.length, ...newChildren);
    }

    function visit(
      node: BidiNode,
      inheritedDirection?: FixedContentDirection,
      tableDirection?: FixedContentDirection,
      flowDirection: FixedContentDirection = options.direction,
      flowArrowEligible = true,
    ): void {
      if (node.type === "text") {
        if (
          flowArrowEligible &&
          options.direction === "rtl" &&
          flowDirection === "rtl" &&
          node.value
        ) {
          node.value = normalizeRtlFlowArrows(node.value);
        }
        return;
      }

      if (node.type === "element" && node.tagName) {
        const childFlowArrowEligible = flowArrowEligible && !NON_PROSE_TAGS.has(node.tagName);
        if (LIST_TAGS.has(node.tagName)) {
          const resolvedListDirection =
            inheritedDirection ??
            tableDirection ??
            (options.requestedDirection && options.requestedDirection !== "auto"
              ? options.requestedDirection
              : resolveAggregateDirection(plainText(node), options.direction));
          setDirection(node, resolvedListDirection);
          processChildren(
            node,
            resolvedListDirection,
            tableDirection,
            resolvedListDirection,
            childFlowArrowEligible,
          );
          return;
        }

        if (node.tagName === "table") {
          const resolvedTableDirection =
            options.requestedDirection && options.requestedDirection !== "auto"
              ? options.requestedDirection
              : resolveDominantDirectionFromCounts(
                  countTableStrongScripts(tableProseText(node)),
                  options.direction,
                );
          setDirection(node, resolvedTableDirection);
          const forcedColumnDirection =
            options.requestedDirection && options.requestedDirection !== "auto"
              ? options.requestedDirection
              : undefined;
          resolveTableColumnDirections(node, resolvedTableDirection, forcedColumnDirection).forEach(
            (direction, cell) => tableColumnDirections.set(cell, direction),
          );
          processChildren(
            node,
            resolvedTableDirection,
            resolvedTableDirection,
            resolvedTableDirection,
            childFlowArrowEligible,
          );
          return;
        } else if (TABLE_CELL_TAGS.has(node.tagName)) {
          const cellDirection =
            options.requestedDirection && options.requestedDirection !== "auto"
              ? options.requestedDirection
              : resolveTableCellDirection(
                  tableProseText(node),
                  inheritedDirection ?? tableDirection ?? options.direction,
                );
          setDirection(node, cellDirection);
          const columnDirection = tableColumnDirections.get(node);
          if (columnDirection && !hasAuthoredCellAlignment(node)) {
            node.properties!["data-scient-table-column-direction"] = columnDirection;
          }
          processChildren(
            node,
            cellDirection,
            tableDirection,
            cellDirection,
            childFlowArrowEligible,
          );
          return;
        } else if (HEADING_TAGS.has(node.tagName)) {
          // A title follows its enclosing message, list, or table-cell flow
          // rather than switching from a short heading label alone.
          const headingDirection = inheritedDirection ?? tableDirection ?? options.direction;
          setDirection(node, headingDirection);
          flowDirection = headingDirection;
        } else if (LOCAL_DIRECTION_TAGS.has(node.tagName)) {
          flowDirection =
            inheritedDirection ??
            tableDirection ??
            resolveProseBlockDirection(plainText(node), options.direction);
          setDirection(node, flowDirection);
        }

        processChildren(
          node,
          inheritedDirection,
          tableDirection,
          flowDirection,
          childFlowArrowEligible,
        );
        return;
      }

      processChildren(node, inheritedDirection, tableDirection, flowDirection, flowArrowEligible);
    }

    visit(tree);
  };
}
