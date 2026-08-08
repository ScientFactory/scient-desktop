import {
  resolveAggregateDirection,
  resolveProseBlockDirection,
  type ContentDirection,
  type FixedContentDirection,
} from "./contentDirection";

type BidiNode = {
  readonly type?: string;
  readonly tagName?: string;
  readonly children?: BidiNode[];
  readonly value?: string;
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
const LOCAL_DIRECTION_TAGS = new Set([...DIRECTIONAL_BLOCK_TAGS, "th", "td"]);

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

/** Adds only semantic direction attributes after untrusted HTML is sanitized. */
export function rehypeScientBidi(options: {
  readonly direction: FixedContentDirection;
  /** The user setting, so an explicit mode remains authoritative for lists. */
  readonly requestedDirection?: ContentDirection;
}) {
  return (tree: BidiNode) => {
    const visit = (
      node: BidiNode,
      inheritedDirection?: FixedContentDirection,
      tableDirection?: FixedContentDirection,
    ) => {
      if (node.type === "element" && node.tagName) {
        if (LIST_TAGS.has(node.tagName)) {
          const resolvedListDirection =
            tableDirection ??
            inheritedDirection ??
            (options.requestedDirection && options.requestedDirection !== "auto"
              ? options.requestedDirection
              : resolveAggregateDirection(plainText(node), options.direction));
          setDirection(node, resolvedListDirection);
          node.children?.forEach((child) => visit(child, resolvedListDirection, tableDirection));
          return;
        }

        if (node.tagName === "table") {
          const resolvedTableDirection =
            options.requestedDirection && options.requestedDirection !== "auto"
              ? options.requestedDirection
              : resolveAggregateDirection(plainText(node), options.direction);
          setDirection(node, resolvedTableDirection);
          node.children?.forEach((child) =>
            visit(child, resolvedTableDirection, resolvedTableDirection),
          );
          return;
        } else if (HEADING_TAGS.has(node.tagName)) {
          // A title belongs to the message, not to the language of its own
          // words. A table remains the stronger structural boundary.
          setDirection(node, tableDirection ?? options.direction);
        } else if (LOCAL_DIRECTION_TAGS.has(node.tagName)) {
          setDirection(
            node,
            tableDirection ??
              inheritedDirection ??
              resolveProseBlockDirection(plainText(node), options.direction),
          );
        }

        node.children?.forEach((child) => visit(child, inheritedDirection, tableDirection));
        return;
      }

      node.children?.forEach((child) => visit(child, inheritedDirection, tableDirection));
    };

    visit(tree);
  };
}
