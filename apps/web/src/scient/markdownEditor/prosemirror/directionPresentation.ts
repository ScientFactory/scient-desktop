import type { Node as ProseMirrorNode } from "prosemirror-model";
import { Plugin, PluginKey, type Transaction } from "prosemirror-state";
import { Decoration, DecorationSet } from "prosemirror-view";

import {
  countStrongScripts,
  findRtlFlowArrowSpans,
  resolveAggregateDirectionFromCounts,
  resolveDominantDirectionFromCounts,
  resolveProseBlockDirectionFromCounts,
  resolveStrongScriptDirection,
  resolveTableCellDirectionFromCounts,
  type FixedContentDirection,
  type StrongScriptCounts,
} from "../../bidi/contentDirection";

interface DirectionPresentationState {
  readonly counts: StrongScriptCounts;
  readonly direction: FixedContentDirection;
  readonly decorations: DecorationSet;
  readonly topLevelNodes: ReadonlySet<ProseMirrorNode>;
}

interface DirectionContext {
  readonly domDirection: FixedContentDirection;
  readonly inheritedDirection?: FixedContentDirection;
  readonly tableContentDirection?: FixedContentDirection;
}

const directionPresentationKey = new PluginKey<DirectionPresentationState>(
  "scientMarkdownDirectionPresentation",
);

const TECHNICAL_NODE_NAMES = new Set([
  "citation",
  "code_block",
  "display_math",
  "footnote_definition",
  "footnote_reference",
  "inline_math",
  "raw_block",
]);

const ZERO_COUNTS: StrongScriptCounts = { ltr: 0, rtl: 0 };
const proseCountCache = new WeakMap<ProseMirrorNode, StrongScriptCounts>();

function addRtlFlowArrowDecorations(
  node: ProseMirrorNode,
  position: number,
  decorations: Decoration[],
): void {
  node.forEach((child, offset) => {
    if (
      !child.isText ||
      child.marks.some((mark) => mark.type.name === "code" || mark.type.name === "link")
    ) {
      return;
    }
    for (const span of findRtlFlowArrowSpans(child.text ?? "")) {
      const classes = ["scient-markdown-rtl-flow-arrow"];
      if (span.replacement !== "←") classes.push("is-weighted");
      if (span.replacement === "⟵") classes.push("is-long");
      decorations.push(
        Decoration.inline(
          position + 1 + offset + span.start,
          position + 1 + offset + span.end,
          {
            class: classes.join(" "),
          },
          { inclusiveEnd: false, inclusiveStart: false },
        ),
      );
    }
  });
}

function explicitDirection(node: ProseMirrorNode): FixedContentDirection | null {
  return node.attrs.dir === "rtl" ? "rtl" : node.attrs.dir === "ltr" ? "ltr" : null;
}

function addCounts(left: StrongScriptCounts, right: StrongScriptCounts): StrongScriptCounts {
  return { ltr: left.ltr + right.ltr, rtl: left.rtl + right.rtl };
}

function subtractCounts(left: StrongScriptCounts, right: StrongScriptCounts): StrongScriptCounts {
  return { ltr: left.ltr - right.ltr, rtl: left.rtl - right.rtl };
}

/** Visible prose only: code, equations, exact source, and reference syntax do not steer layout. */
function proseCounts(node: ProseMirrorNode): StrongScriptCounts {
  const cached = proseCountCache.get(node);
  if (cached) return cached;

  let counts = ZERO_COUNTS;
  if (!TECHNICAL_NODE_NAMES.has(node.type.name)) {
    if (node.isText) {
      counts = node.marks.some((mark) => mark.type.name === "code")
        ? ZERO_COUNTS
        : countStrongScripts(node.text ?? "");
    } else if (node.type.name === "image") {
      counts = countStrongScripts(String(node.attrs.alt ?? ""));
    } else if (node.type.name === "wiki_link") {
      counts = countStrongScripts(String(node.attrs.label ?? node.attrs.target ?? ""));
    } else if (!node.isLeaf) {
      node.forEach((child) => {
        counts = addCounts(counts, proseCounts(child));
      });
    }
  }
  proseCountCache.set(node, counts);
  return counts;
}

export function resolveScientMarkdownDocumentDirection(
  document: ProseMirrorNode,
): FixedContentDirection {
  return resolveStrongScriptDirection(proseCounts(document)) ?? "ltr";
}

function addNodeDecorations(
  node: ProseMirrorNode,
  position: number,
  context: DirectionContext,
  direction: FixedContentDirection,
  decorations: Decoration[],
): void {
  const nodeName = node.type.name;
  const tableRole = node.type.spec.tableRole;
  const authoredDirection = explicitDirection(node);
  let resolved: FixedContentDirection | null = null;
  let childContext = context;

  if (nodeName === "table") {
    const tableContentDirection = resolveDominantDirectionFromCounts(proseCounts(node), direction);
    resolved = authoredDirection ?? tableContentDirection;
    childContext = {
      domDirection: resolved,
      tableContentDirection,
    };
  } else if (nodeName === "bullet_list" || nodeName === "ordered_list") {
    resolved =
      context.inheritedDirection ??
      context.tableContentDirection ??
      resolveAggregateDirectionFromCounts(proseCounts(node), direction);
    childContext = { ...context, domDirection: resolved, inheritedDirection: resolved };
  } else if (tableRole === "cell" || tableRole === "header_cell") {
    resolved = resolveTableCellDirectionFromCounts(
      proseCounts(node),
      context.tableContentDirection ?? context.inheritedDirection ?? direction,
    );
    childContext = { ...context, domDirection: resolved, inheritedDirection: resolved };
  } else if (nodeName === "heading") {
    resolved =
      authoredDirection ?? context.inheritedDirection ?? context.tableContentDirection ?? direction;
  } else if (nodeName === "paragraph") {
    resolved =
      authoredDirection ??
      context.inheritedDirection ??
      context.tableContentDirection ??
      resolveProseBlockDirectionFromCounts(proseCounts(node), direction);
  } else if (nodeName === "blockquote") {
    resolved =
      context.inheritedDirection ??
      context.tableContentDirection ??
      resolveProseBlockDirectionFromCounts(proseCounts(node), direction);
  }

  if (authoredDirection === null && resolved !== null && resolved !== context.domDirection) {
    decorations.push(
      Decoration.node(position, position + node.nodeSize, {
        dir: resolved,
      }),
    );
  }

  if (node.inlineContent && resolved === "rtl") {
    addRtlFlowArrowDecorations(node, position, decorations);
  }

  if (node.isLeaf || node.inlineContent) return;
  if (resolved !== null && nodeName === "blockquote") {
    childContext = { ...childContext, domDirection: resolved };
  }
  node.forEach((child, offset) => {
    addNodeDecorations(child, position + 1 + offset, childContext, direction, decorations);
  });
}

function buildDirectionPresentation(document: ProseMirrorNode): DirectionPresentationState {
  const counts = proseCounts(document);
  const direction = resolveStrongScriptDirection(counts) ?? "ltr";
  const decorations: Decoration[] = [];
  const topLevelNodes = new Set<ProseMirrorNode>();

  document.forEach((child, offset) => {
    topLevelNodes.add(child);
    addNodeDecorations(child, offset, { domDirection: direction }, direction, decorations);
  });
  return {
    counts,
    direction,
    decorations: DecorationSet.create(document, decorations),
    topLevelNodes,
  };
}

function updateDirectionPresentation(
  transaction: Transaction,
  current: DirectionPresentationState,
  document: ProseMirrorNode,
): DirectionPresentationState {
  if (!transaction.docChanged) return current;
  const changed: Array<{ readonly node: ProseMirrorNode; readonly position: number }> = [];
  const topLevelNodes = new Set<ProseMirrorNode>();
  let counts = current.counts;
  document.forEach((node, position) => {
    topLevelNodes.add(node);
    if (!current.topLevelNodes.has(node)) {
      changed.push({ node, position });
      counts = addCounts(counts, proseCounts(node));
    }
  });
  current.topLevelNodes.forEach((node) => {
    if (!topLevelNodes.has(node)) counts = subtractCounts(counts, proseCounts(node));
  });
  const direction = resolveStrongScriptDirection(counts) ?? "ltr";
  if (direction !== current.direction) return buildDirectionPresentation(document);

  let decorations = current.decorations.map(transaction.mapping, document);
  for (const block of changed) {
    decorations = decorations.remove(
      decorations.find(block.position, block.position + block.node.nodeSize),
    );
    const replacements: Decoration[] = [];
    addNodeDecorations(
      block.node,
      block.position,
      { domDirection: direction },
      direction,
      replacements,
    );
    decorations = decorations.add(document, replacements);
  }
  return { counts, decorations, direction, topLevelNodes };
}

/** Semantic `dir` is presentation state: it never enters transactions or Markdown source. */
export function scientMarkdownDirectionPresentationPlugin(): Plugin<DirectionPresentationState> {
  return new Plugin<DirectionPresentationState>({
    key: directionPresentationKey,
    state: {
      init: (_config, state) => buildDirectionPresentation(state.doc),
      apply: (transaction, current, _oldState, newState) =>
        updateDirectionPresentation(transaction, current, newState.doc),
    },
    props: {
      attributes: (state) => ({
        dir: directionPresentationKey.getState(state)?.direction ?? "ltr",
      }),
      decorations: (state) =>
        directionPresentationKey.getState(state)?.decorations ?? DecorationSet.empty,
    },
  });
}
