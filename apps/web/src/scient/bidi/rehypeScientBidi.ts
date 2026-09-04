import {
  normalizeRtlFlowArrows,
  resolveAggregateDirection,
  resolveDominantDirection,
  resolveProseBlockDirection,
  resolveTableCellDirection,
  type ContentDirection,
  type FixedContentDirection,
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
              : resolveDominantDirection(plainText(node), options.direction);
          setDirection(node, resolvedTableDirection);
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
                  plainText(node),
                  inheritedDirection ?? tableDirection ?? options.direction,
                );
          setDirection(node, cellDirection);
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
