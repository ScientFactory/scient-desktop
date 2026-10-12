import type { EditorView } from "@tiptap/pm/view";
import type { LatexVisualDocument } from "./latexVisualDocument";
import {
  latexVisualNodeSignature,
  latexVisualInlineSourceRange,
  latexVisualNodeSourceRange,
} from "./latexVisualDocument";
import { readLatexSelection } from "./latexSelectionSession";
import type { MathfieldElement } from "mathlive";
import { mathSelectionPoint, mathSelectionAtOffset } from "./mathLiveSelection";
import { mathRowSourceRange } from "./latexMathNumbering";
import { latexVisualObjectSourceRange } from "./latexVisualObjectSourceRange";
import { latexMathSourceRange } from "./latexMathSourceRange";
import { sha256 } from "@noble/hashes/sha2";
import { bytesToHex } from "@noble/hashes/utils";
import type { FileCitation } from "@t3tools/contracts";

const revisions = new Map<string, string>();
export function latexCitationRevision(source: string) {
  const cached = revisions.get(source);
  if (cached) return cached;
  const revision = `sha256:${bytesToHex(sha256(new TextEncoder().encode(source)))}`;
  if (revisions.size >= 4) revisions.delete(revisions.keys().next().value!);
  revisions.set(source, revision);
  return revision;
}

export interface LatexSourceOwner {
  readonly path: string;
  readonly rootRelativePath: string;
  readonly source: string;
  readonly baselineSource: string;
  readonly from: number;
  readonly to: number;
  readonly precise?: boolean;
}
export type ResolveLatexSourceOwner = (
  source: string,
  from: number,
  to: number,
) => LatexSourceOwner | null;

/** Existing selection owners supply content and geometry; projection supplies source ownership. */
export function captureLatexVisualSelection(
  root: HTMLElement,
  view: EditorView,
  projection: LatexVisualDocument,
  source: string,
  resolveOwner: ResolveLatexSourceOwner,
  target?: HTMLElement,
  point?: { left: number; top: number },
) {
  if (view.isDestroyed || view.composing || projection.source !== source) return null;
  const reading = readLatexSelection(root);
  if (!reading && !target) return null;
  const element = target ?? reading!.element;
  const content = reading?.snapshot.content;
  let from: number, to: number;
  let pointerRange = false;
  const documentRange = !target && reading?.element === view.dom && content;
  try {
    if (target) {
      // Rendered math and virtualized prose can be outside a node's editable
      // contentDOM. Its actual node-view DOM still identifies the owning block.
      let position: number | null = null;
      view.state.doc.forEach((_node, at) => {
        const dom = view.nodeDOM(at);
        if (dom instanceof Element && dom.contains(target)) position = at;
      });
      if (position === null) return null;
      from = position;
      to = from;
      const node = view.state.doc.nodeAt(position);
      const clicked = point ? view.posAtCoords(point)?.pos : undefined;
      if (node && !node.isAtom) {
        if (clicked !== undefined && clicked > position && clicked < position + node.nodeSize) {
          from = Math.min(clicked, position + node.nodeSize - 2);
          to = from + 1;
          pointerRange = true;
        }
        // Native word selection can precede ProseMirror's selectionchange.
        // Resolve its actual DOM endpoints without changing either selection.
        const native = view.dom.ownerDocument.getSelection();
        let nativeRange = false;
        if (native?.rangeCount && !native.isCollapsed) {
          const range = native.getRangeAt(0);
          if (
            view.nodeDOM(position)?.contains(range.commonAncestorContainer) &&
            range.intersectsNode(target)
          ) {
            const start = view.posAtDOM(range.startContainer, range.startOffset);
            const end = view.posAtDOM(range.endContainer, range.endOffset);
            const resolved = view.state.doc.resolve(start);
            if (
              start > position &&
              end < position + node.nodeSize &&
              resolved.sameParent(view.state.doc.resolve(end)) &&
              resolved.parent.isTextblock &&
              view.state.doc.textBetween(start, end) === native.toString()
            ) {
              from = start;
              to = end;
              nativeRange = true;
              pointerRange = true;
            }
          }
        }
        const selection = view.state.selection;
        if (
          !nativeRange &&
          pointerRange &&
          !selection.empty &&
          selection.$from.sameParent(selection.$to) &&
          selection.$from.parent.isTextblock &&
          from >= selection.from &&
          from <= selection.to
        ) {
          from = selection.from;
          to = selection.to;
        }
      }
    } else {
      from = documentRange ? content.from : view.posAtDOM(element, 0);
      to = documentRange ? content.to : from;
    }
  } catch {
    return null;
  }
  const blocks: { from: number; to: number; precise: boolean }[] = [];
  if (view.state.doc.childCount !== projection.blocks.length) return null;
  let unmapped = false;
  view.state.doc.forEach((node, position, index) => {
    const end = position + node.nodeSize;
    if (from === to ? from < position || from >= end : to <= position || from >= end) return;
    // Live typing preserves model nodes while source IDs/offsets move. Match the
    // current projection's structural position and content, never repeated text.
    const block = projection.blocks[index];
    if (
      !block ||
      latexVisualNodeSignature(block.node) !== latexVisualNodeSignature(node.toJSON())
    ) {
      unmapped = true;
      return;
    }
    let precise: { from: number; to: number; precise?: boolean } | null =
      pointerRange && projection.setup
        ? latexVisualNodeSourceRange(block, from - position, to - position, projection.setup)
        : documentRange && node.isTextblock
          ? latexVisualInlineSourceRange(
              block,
              Math.max(0, from - position - 1),
              Math.min(node.content.size, to - position - 1),
            )
          : null;
    if (target?.closest("textarea,input,[data-table-cell]") && projection.setup) {
      view.state.doc.descendants((candidate, at) => {
        if (at < position || at >= end) return false;
        const dom = view.nodeDOM(at);
        if (!(dom instanceof Element) || !dom.contains(target)) return;
        const owned =
          at === position
            ? block
            : latexVisualNodeSourceRange(
                block,
                at - position,
                at - position + candidate.nodeSize,
                projection.setup!,
              );
        if (!owned) return;
        const raw = source.slice(owned.from, owned.to);
        // Source-owned node views preserve raw TeX; reject stale field ownership.
        if (String(candidate.attrs.raw ?? "") !== raw) return;
        const fieldRange = latexVisualObjectSourceRange(
          candidate.toJSON(),
          raw,
          owned.from,
          target,
          reading,
          source,
          point,
        );
        if (fieldRange) precise = fieldRange;
      });
    }
    if (target && point && block.node.type === "latexDisplayMath") {
      const math =
        target.closest<MathfieldElement>("math-field") ??
        (reading?.element.matches("math-field") ? (reading.element as MathfieldElement) : null);
      if (math && view.nodeDOM(position)?.contains(math)) {
        const path = mathSelectionPoint(math, point.left, point.top).path;
        const cell = path.length === 1 ? path[0] : null;
        const row =
          cell &&
          mathRowSourceRange(
            block.source,
            cell.row,
            cell.array.rowCount ?? 0,
            cell.array.environmentName ?? "",
            { column: cell.column, columns: cell.array.colCount ?? 0 },
          );
        if (row && row.from < row.to)
          precise = { from: block.from + row.from, to: block.from + row.to };
      }
    }
    const math = target?.closest<MathfieldElement>("math-field");
    if (math && point && projection.setup && view.nodeDOM(position)?.contains(math)) {
      view.state.doc.descendants((candidate, at) => {
        if (at < position || at >= end) return false;
        if (
          !["latexInlineMath", "latexDisplayMath"].includes(candidate.type.name) ||
          !view.nodeDOM(at)?.contains(math)
        )
          return;
        const owned =
          at === position
            ? block
            : latexVisualNodeSourceRange(
                block,
                at - position,
                at - position + candidate.nodeSize,
                projection.setup!,
              );
        if (!owned) return;
        const mathContent = reading?.element === math ? reading.snapshot.content : null;
        const path = (
          mathContent?.selected
            ? mathSelectionAtOffset(math, mathContent.to).path
            : mathSelectionPoint(math, point.left, point.top).path
        ).map((cell) => ({
          environment: cell.array.environmentName ?? "",
          row: cell.row,
          rows: cell.array.rowCount ?? 0,
          column: cell.column,
          columns: cell.array.colCount ?? 0,
        }));
        const selected = reading?.element === math ? (reading.snapshot.content?.text ?? "") : "";
        const range = latexMathSourceRange(source.slice(owned.from, owned.to), path, selected);
        if (range) precise = { from: owned.from + range.from, to: owned.from + range.to };
      });
    }
    blocks.push({
      ...(precise ?? { from: block.from, to: block.to }),
      precise: precise !== null && precise.precise !== false,
    });
  });
  if (unmapped || !blocks.length) return null;
  const owner = resolveOwner(source, blocks[0]!.from, blocks.at(-1)!.to);
  if (!owner) return null;
  const model = view.state.doc;
  const snapshot = reading?.snapshot;
  return {
    element,
    content,
    sourceOwner: { ...owner, precise: blocks.every((block) => block.precise) },
    revision: latexCitationRevision(owner.source),
    geometry: () =>
      snapshot?.contentRects?.() ?? snapshot?.selection() ?? [element.getBoundingClientRect()],
    isCurrent: () =>
      element.isConnected && view.state.doc === model && snapshot?.isCurrent?.() !== false,
  } as const;
}
export type LatexVisualSelectionSnapshot = NonNullable<
  ReturnType<typeof captureLatexVisualSelection>
>;

/** A moved quote is accepted only when its enclosing source and context identify one location. */
export function resolveLatexCitationSource(source: string, citation: FileCitation) {
  if (!citation.latex) return null;
  const length = citation.sourceEnd - citation.sourceStart;
  const matches = (from: number) =>
    from >= 0 &&
    from + length <= source.length &&
    latexCitationRevision(source.slice(from, from + length)) === citation.latex!.sourceHash;
  if (latexCitationRevision(source) === citation.revision)
    return matches(citation.sourceStart)
      ? { from: citation.sourceStart, to: citation.sourceEnd }
      : null;
  const candidates: number[] = [];
  if (!citation.prefix) {
    if (matches(0)) candidates.push(0);
  } else {
    for (
      let at = source.indexOf(citation.prefix);
      at >= 0;
      at = source.indexOf(citation.prefix, at + 1)
    ) {
      const from = at + citation.prefix.length;
      if (
        source.slice(from + length, from + length + citation.suffix.length) === citation.suffix &&
        matches(from)
      )
        candidates.push(from);
      if (candidates.length > 1) return null;
    }
  }
  return candidates.length === 1 ? { from: candidates[0]!, to: candidates[0]! + length } : null;
}
