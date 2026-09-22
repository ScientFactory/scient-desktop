import { closeHistory } from "prosemirror-history";
import { NodeSelection, TextSelection } from "prosemirror-state";
import type { EditorView } from "prosemirror-view";
import { MathInputController, type MathInputSnapshot } from "./controller";

/** Prose insertion uses schema nodes and the document's own history/serializer.
 * Existing equation fields register their own (inner) adapter. */
export function markdownMathController(getView: () => EditorView | null): MathInputController {
  const read = (): MathInputSnapshot | null => {
    const view = getView();
    if (!view?.editable || view.composing) return null;
    const selection = view.state.selection;
    if (
      !(selection instanceof TextSelection) ||
      selection.$from.parent !== selection.$to.parent ||
      selection.$from.parent.type.spec.code
    )
      return null;
    if (
      selection.$from.marks().some((mark) => mark.type.name === "code" || mark.type.name === "link")
    )
      return null;
    let safe = true;
    view.state.doc.nodesBetween(selection.from, selection.to, (node) => {
      if ((node.isLeaf && !node.isText) || node.marks.some((mark) => mark.type.name === "code"))
        safe = false;
    });
    if (!safe) return null;
    const text = view.state.doc.textBetween(selection.from, selection.to, "", "");
    return {
      source: text,
      selection: { from: 0, to: text.length },
      format: "markdown",
      editable: true,
      identity: view.state.doc,
      location: `${selection.from}:${selection.to}`,
    };
  };
  return new MathInputController({
    read,
    apply(expected, edit, display) {
      const view = getView();
      const current = read();
      if (
        !view ||
        !current ||
        current.source !== expected.source ||
        current.identity !== expected.identity ||
        current.location !== expected.location
      )
        return false;
      const opening = display ? "\n$$\n" : "\\(";
      const closing = display ? "\n$$\n" : "\\)";
      if (!edit.insert.startsWith(opening) || !edit.insert.endsWith(closing)) return false;
      const tex = edit.insert.slice(opening.length, -closing.length);
      const type = view.state.schema.nodes[display ? "display_math" : "inline_math"];
      if (!type) return false;
      const node = type.create({ tex, delimiter: display ? "$$" : "\\(", display });
      const tr = closeHistory(view.state.tr.replaceSelectionWith(node));
      const position =
        tr.selection.$from.nodeBefore === node
          ? tr.selection.from - node.nodeSize
          : tr.selection.from;
      // replaceSelectionWith may split a paragraph for display math. Locate the
      // inserted object through its identity, never by matching repeated TeX.
      let inserted: number | null = null;
      tr.doc.descendants((child, pos) => {
        if (child === node) inserted = pos;
      });
      if (inserted === null) return false;
      tr.setSelection(NodeSelection.create(tr.doc, inserted ?? position));
      view.dispatch(tr);
      const dom = view.nodeDOM(inserted) as HTMLElement | null;
      const field = dom?.querySelector<HTMLInputElement | HTMLTextAreaElement>(
        ".scient-markdown-math-source",
      );
      if (field) {
        field.hidden = false;
        field.focus();
        field.setSelectionRange(
          Math.max(0, edit.selection.from - opening.length),
          Math.max(0, edit.selection.to - opening.length),
        );
      }
      return true;
    },
    focus() {
      const view = getView();
      if (view?.dom.contains(document.activeElement)) return;
      if (view?.state.selection instanceof NodeSelection) {
        const dom = view.nodeDOM(view.state.selection.from) as HTMLElement | null;
        const field = dom?.querySelector<HTMLInputElement | HTMLTextAreaElement>(
          ".scient-markdown-math-source",
        );
        if (field) {
          field.hidden = false;
          field.focus();
          return;
        }
      }
      view?.focus();
    },
  });
}
