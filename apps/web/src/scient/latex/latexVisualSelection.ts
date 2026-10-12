import type { EditorView } from "@tiptap/pm/view";
import type { LatexVisualDocument } from "./latexVisualDocument";
import { latexVisualNodeSignature, latexVisualInlineSourceRange } from "./latexVisualDocument";
import { readLatexSelection } from "./latexSelectionSession";
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
      if (
        node?.isTextblock &&
        node.content.size > 0 &&
        clicked !== undefined &&
        clicked > position &&
        clicked < position + node.nodeSize
      ) {
        from = Math.min(clicked, position + node.nodeSize - 2);
        to = from + 1;
        pointerRange = true;
      }
    } else {
      from = documentRange ? content.from : view.posAtDOM(element, 0);
      to = documentRange ? content.to : from;
    }
  } catch {
    return null;
  }
  const blocks: { from: number; to: number }[] = [];
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
    const precise =
      (documentRange || pointerRange) && node.isTextblock
        ? latexVisualInlineSourceRange(
            block,
            Math.max(0, from - position - 1),
            Math.min(node.content.size, to - position - 1),
          )
        : null;
    blocks.push(precise ?? { from: block.from, to: block.to });
  });
  if (unmapped || !blocks.length) return null;
  const owner = resolveOwner(source, blocks[0]!.from, blocks.at(-1)!.to);
  if (!owner) return null;
  const model = view.state.doc;
  const snapshot = reading?.snapshot;
  return {
    element,
    content,
    sourceOwner: owner,
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
