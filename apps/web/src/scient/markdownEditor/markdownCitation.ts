import { EditorView as CodeMirrorView } from "@codemirror/view";
import { sha256 } from "@noble/hashes/sha2";
import { bytesToHex } from "@noble/hashes/utils";
import { FileCitation, type ScopedThreadRef } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import type { Node as ProseMirrorNode } from "prosemirror-model";
import type { AssistantCitationSourceAnchor } from "~/lib/assistantTextSelection";
import type { ScientMarkdownEditorView } from "./prosemirror/view";
import type { ScientProseMirrorSession } from "./prosemirror/session";

export type MarkdownCitationSource = ScopedThreadRef & {
  readonly cwd: string;
  readonly path: string;
};
export type MarkdownCiteHandler = (
  citation: FileCitation,
  anchor: AssistantCitationSourceAnchor,
) => boolean;
const validCitation = Schema.is(FileCitation);
const revisions = new WeakMap<ProseMirrorNode, { source: string; revision: string }>();
const leafText = (node: ProseMirrorNode) => (node.type.name === "hard_break" ? "\n" : "\uFFFC");

export function markdownCitationRevision(session: ScientProseMirrorSession): string {
  const source = session.session.draftSource;
  const cached = revisions.get(session.state.doc);
  if (cached?.source === source) return cached.revision;
  const revision = `sha256:${bytesToHex(sha256(new TextEncoder().encode(source)))}`;
  revisions.set(session.state.doc, { source, revision });
  return revision;
}

/** Positions refer to the editor's current document, not stale parser token IDs. */
export function createMarkdownCitation(
  session: ScientProseMirrorSession,
  source: MarkdownCitationSource,
  from: number,
  to: number,
): FileCitation | null {
  const range = session.sourceRangeForDocumentRange(from, to);
  if (!range) return null;
  const doc = session.state.doc;
  const text = doc.textBetween(from, to, "\n", leafText);
  // Rendered atoms (images, math, charts) need a separate explicit capture policy.
  if (
    text.includes("\uFFFC") ||
    /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(text)
  )
    return null;
  const draft = session.session.draftSource;
  const before = doc.textBetween(Math.max(0, from - 40), from, "\n", leafText);
  const after = doc.textBetween(to, Math.min(doc.content.size, to + 40), "\n", leafText);
  const citation: FileCitation = {
    kind: "file",
    version: 1,
    ...source,
    from,
    to,
    text,
    revision: markdownCitationRevision(session),
    origin: draft === session.session.baselineSource ? "saved" : "draft",
    sourceStart: range.from,
    sourceEnd: range.to,
    startLine: draft.slice(0, range.from).split("\n").length,
    endLine: draft.slice(0, Math.max(range.from, range.to - 1)).split("\n").length,
    prefix: [...before].slice(-16).join(""),
    suffix: [...after].slice(0, 16).join(""),
  };
  return validCitation(citation) ? citation : null;
}

/** The nested code editor owns code selection; ProseMirror only selects its entire node. */
export function captureMarkdownCitation(
  controller: ScientMarkdownEditorView,
  source: MarkdownCitationSource,
  selection: Selection | null,
) {
  const view = controller.view;
  if (!view || !selection || selection.rangeCount !== 1 || selection.isCollapsed || view.composing)
    return null;
  const range = selection.getRangeAt(0).cloneRange();
  if (!view.dom.contains(range.startContainer) || !view.dom.contains(range.endContainer))
    return null;
  const startElement =
    range.startContainer.nodeType === 1
      ? (range.startContainer as Element)
      : range.startContainer.parentElement;
  const endElement =
    range.endContainer.nodeType === 1
      ? (range.endContainer as Element)
      : range.endContainer.parentElement;
  if (
    startElement?.closest("button,input,textarea,select,svg") ||
    endElement?.closest("button,input,textarea,select,svg")
  )
    return null;
  let from: number;
  let to: number;
  const codeDom = startElement?.closest<HTMLElement>(".cm-editor");
  if (codeDom) {
    if (!codeDom.contains(range.endContainer)) return null;
    const code = CodeMirrorView.findFromDOM(codeDom);
    if (
      !code ||
      code.composing ||
      code.state.selection.ranges.length !== 1 ||
      code.state.selection.main.empty
    )
      return null;
    let position: number | null = null;
    view.state.doc.descendants((node, pos) => {
      if (node.type.name !== "code_block") return;
      if (view.nodeDOM(pos)?.contains(codeDom)) position = pos;
      return false;
    });
    if (
      position === null ||
      view.state.doc.nodeAt(position)?.textContent !== code.state.doc.toString()
    )
      return null;
    from = position + 1 + code.state.selection.main.from;
    to = position + 1 + code.state.selection.main.to;
  } else {
    // Native endpoints also cover backwards drags and selections across table cells.
    try {
      from = view.posAtDOM(range.startContainer, range.startOffset, 1);
      to = view.posAtDOM(range.endContainer, range.endOffset, -1);
    } catch {
      return null;
    }
  }
  if (!isMarkdownCitationTextRange(controller, { from, to })) return null;
  const citation = createMarkdownCitation(controller.session, source, from, to);
  return citation
    ? {
        citation,
        sourceAnchor: {
          source: view.dom,
          range,
          viewport: view.dom.closest<HTMLElement>(".scient-markdown-document-shell") ?? view.dom,
          resolveRange: () => {
            // Do not move a comment to a different version while the user is typing.
            if (markdownCitationRevision(controller.session) !== citation.revision) return null;
            return markdownCitationDomRange(controller, citation);
          },
        },
      }
    : null;
}

/** A chart's hidden source is not the text the user selected in its rendered view. */
export function isMarkdownCitationTextRange(
  controller: ScientMarkdownEditorView,
  range: { from: number; to: number },
): boolean {
  const view = controller.view;
  if (!view || range.from < 0 || range.to > view.state.doc.content.size || range.to <= range.from)
    return false;
  let supported = true;
  view.state.doc.nodesBetween(range.from, range.to, (node, position) => {
    if (node.type.name !== "code_block") return;
    const element = view.nodeDOM(position);
    if (element instanceof HTMLElement && element.hasAttribute("data-scient-markdown-rich-fence"))
      supported = false;
    return false;
  });
  return supported;
}

export function markdownCitationDomRange(
  controller: ScientMarkdownEditorView,
  match: { from: number; to: number },
): Range | null {
  const view = controller.view;
  if (!view || !isMarkdownCitationTextRange(controller, match)) return null;
  const start = view.state.doc.resolve(match.from);
  const blockPosition = start.parent.type.name === "code_block" ? start.before() : null;
  const block = blockPosition === null ? null : view.nodeDOM(blockPosition);
  const codeDom =
    block instanceof HTMLElement ? block.querySelector<HTMLElement>(".cm-editor") : null;
  const code = codeDom ? CodeMirrorView.findFromDOM(codeDom) : null;
  try {
    const first =
      code && blockPosition !== null
        ? code.domAtPos(match.from - blockPosition - 1)
        : view.domAtPos(match.from);
    const last =
      code && blockPosition !== null
        ? code.domAtPos(match.to - blockPosition - 1)
        : view.domAtPos(match.to);
    const range = view.dom.ownerDocument.createRange();
    range.setStart(first.node, first.offset);
    range.setEnd(last.node, last.offset);
    return range.collapsed ? null : range;
  } catch {
    return null;
  }
}

/** Exact positions are trusted only for the captured revision. Changed files require a unique match. */
export function resolveMarkdownCitation(
  session: ScientProseMirrorSession,
  citation: FileCitation,
): { from: number; to: number } | null {
  const doc = session.state.doc;
  if (markdownCitationRevision(session) === citation.revision) {
    return citation.to <= doc.content.size &&
      doc.textBetween(citation.from, citation.to, "\n", leafText) === citation.text
      ? { from: citation.from, to: citation.to }
      : null;
  }
  // Keep model positions while constructing one visible-text stream. Node boundaries
  // separate paragraphs/cells; inline formatting doesn't split a quote.
  const chunks: { start: number; end: number; position: number }[] = [];
  let text = "";
  doc.descendants((node, position) => {
    if (node.isBlock && text && !text.endsWith("\n")) text += "\n";
    const value = node.isText ? node.text! : node.isLeaf ? leafText(node) : "";
    if (!value) return;
    chunks.push({ start: text.length, end: text.length + value.length, position });
    text += value;
  });
  const matches: { from: number; to: number }[] = [];
  const contextual: { from: number; to: number }[] = [];
  for (
    let start = text.indexOf(citation.text);
    start >= 0;
    start = text.indexOf(citation.text, start + 1)
  ) {
    const end = start + citation.text.length;
    const first = chunks.find((chunk) => chunk.end > start);
    const last = chunks.findLast((chunk) => chunk.start < end);
    if (!first || !last) continue;
    const match = {
      from: first.position + start - first.start,
      to: last.position + end - last.start,
    };
    if (doc.textBetween(match.from, match.to, "\n", leafText) !== citation.text) continue;
    matches.push(match);
    if (
      text.slice(Math.max(0, start - citation.prefix.length), start) === citation.prefix &&
      text.slice(end, end + citation.suffix.length) === citation.suffix
    )
      contextual.push(match);
    if (contextual.length > 1) return null;
  }
  return contextual.length === 1
    ? contextual[0]!
    : contextual.length === 0 && matches.length === 1
      ? matches[0]!
      : null;
}
