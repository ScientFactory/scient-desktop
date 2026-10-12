import type { EditorState, Transaction } from "@tiptap/pm/state";
import { TextSelection } from "@tiptap/pm/state";
import { closeHistory } from "@tiptap/pm/history";
import { latexDirectionOpening, type LatexTextDirection } from "./latexLanguage";
import { projectLatexVisualDocument, serializeLatexVisualBlock } from "./latexVisualDocument";

function paragraphs(state: EditorState) {
  const selection = state.selection;
  if (!(selection instanceof TextSelection)) return [];
  const found: number[] = [];
  let unsupported = false;
  state.doc.nodesBetween(selection.from, selection.to, (node, position) => {
    if (node.type.name === "paragraph") found.push(position);
    else if (node.isTextblock || (node.isBlock && node.isAtom)) unsupported = true;
  });
  if (unsupported) return [];
  const supported = found.every((position) => {
    const at = state.doc.resolve(position);
    for (let depth = 1; depth <= at.depth; depth++) {
      const parent = at.node(depth);
      if (parent.type.name !== "latexScientific" || parent.attrs.layout?.kind !== "direction")
        return false;
    }
    return true;
  });
  return supported ? found : [];
}

/** Paragraph commands stay on prose in the document, rather than inline object fields. */
export function latexParagraphDirection(state: EditorState, inherited: LatexTextDirection) {
  const selected = paragraphs(state);
  if (
    !selected.length ||
    state.selection.$from.parent.type.name !== "paragraph" ||
    state.selection.$to.parent.type.name !== "paragraph"
  )
    return null;
  const directions = selected.map((position) => {
    const at = state.doc.resolve(position);
    for (let depth = at.depth; depth > 0; depth--)
      if (at.node(depth).attrs.layout?.kind === "direction")
        return at.node(depth).attrs.layout.direction as LatexTextDirection;
    return inherited;
  });
  return { value: directions.every((value) => value === directions[0]) ? directions[0] : "mixed" };
}

function retainedParagraph(
  state: EditorState,
  position: number,
  source: string,
  setup: string,
  projections: Map<string, ReturnType<typeof projectLatexVisualDocument>>,
) {
  const at = state.doc.resolve(position);
  let body = source;
  for (let depth = 0; depth <= at.depth; depth++) {
    let projection = projections.get(body);
    if (!projection) {
      projection = projectLatexVisualDocument(body, 0, setup);
      projections.set(body, projection);
    }
    const block = projection.blocks[at.index(depth)];
    if (!block) return null;
    if (depth === at.depth)
      return state.schema.nodeFromJSON(block.node).eq(state.doc.nodeAt(position)!)
        ? block.source
        : null;
    const opening = latexDirectionOpening(block.source);
    if (!opening) return null;
    body = block.source.slice(opening.from, -`\\end{${opening.environment}}`.length);
  }
  return null;
}

/** Reuse the existing editable direction structure and normal document undo/persistence. */
export function setLatexParagraphDirection(
  state: EditorState,
  dispatch: (transaction: Transaction) => void,
  direction: LatexTextDirection,
  source: string,
  setup: string,
): boolean {
  if (!latexParagraphDirection(state, direction)) return false;
  const type = state.schema.nodes.latexScientific;
  if (!type) return false;
  const environment = direction === "rtl" ? "RTL" : "LTR";
  const eol = source.includes("\r\n") ? "\r\n" : "\n";
  const tr = closeHistory(state.tr);
  const projections = new Map<string, ReturnType<typeof projectLatexVisualDocument>>();
  for (const position of paragraphs(state).toReversed()) {
    const paragraph = state.doc.nodeAt(position)!;
    const body =
      retainedParagraph(state, position, source, setup, projections) ??
      serializeLatexVisualBlock(paragraph.toJSON());
    if (body === null) return false;
    const raw = `\\begin{${environment}}${eol}${body}${eol}\\end{${environment}}`;
    const attrs = {
      environment,
      title: "",
      raw,
      layout: { kind: "direction", direction, language: null },
    };
    const at = tr.doc.resolve(tr.mapping.map(position));
    const parent = at.parent;
    if (
      parent.type === type &&
      ["LTR", "RTL"].includes(parent.attrs.environment) &&
      parent.childCount === 1
    ) {
      if (parent.attrs.layout.direction !== direction)
        tr.setNodeMarkup(at.before(), undefined, { ...parent.attrs, ...attrs });
    } else {
      const range = at.blockRange(tr.doc.resolve(at.pos + paragraph.nodeSize));
      if (!range || !range.parent.canReplaceWith(range.startIndex, range.endIndex, type))
        return false;
      tr.wrap(range, [{ type, attrs: { ...attrs, sourceId: paragraph.attrs.sourceId } }]);
    }
  }
  if (!tr.docChanged) return true;
  dispatch(tr.scrollIntoView());
  return true;
}
