import { Extension } from "@tiptap/core";
import type { Node as DocumentNode } from "@tiptap/pm/model";
import { NodeSelection, Plugin, PluginKey, type EditorState } from "@tiptap/pm/state";
import { Decoration, DecorationSet, type EditorView } from "@tiptap/pm/view";
import { appendLatexProsePreview } from "./LatexProsePreview";
import { isLatexVisualLoading } from "./latexProgressiveLoading";
import { isOrdinaryTyping } from "./visualTyping";
import {
  latexBlockFootnotes,
  latexEquationReferencesKey,
  navigateToFootnote,
} from "./latexEquationReferences";

/** The notes of one top-level block, shown beneath it. */
interface FootnoteBand {
  /** Where the block ends: the band's position. */
  readonly end: number;
  /** Numbers and texts; an unchanged key keeps the band's DOM. */
  readonly key: string;
  readonly notes: readonly { readonly number: string | null; readonly body: string }[];
}

function bandsOf(state: EditorState): FootnoteBand[] {
  const footnotes = latexEquationReferencesKey.getState(state)?.footnotes;
  if (!footnotes?.size) return [];
  const { doc } = state;
  const blocks = new Map<number, { number: string | null; body: string }[]>();
  // The markers `latexBlockFootnotes` finds, grouped by top-level block.
  for (const position of [...footnotes.keys()].toSorted((a, b) => a - b)) {
    if (position < 0 || position >= doc.content.size) continue;
    const node = doc.nodeAt(position);
    if (node?.type.name !== "latexInlineCommand" || node.attrs.name !== "footnote") continue;
    const $position = doc.resolve(position);
    if ($position.depth < 1) continue;
    const end = $position.after(1);
    const { number, body } = footnotes.get(position)!;
    const notes = blocks.get(end) ?? [];
    notes.push({ number, body });
    blocks.set(end, notes);
  }
  return [...blocks].map(([end, notes]) => ({
    end,
    key: `footnotes:${JSON.stringify(notes)}`,
    notes,
  }));
}

function band(notes: FootnoteBand["notes"]) {
  return (view: EditorView, getPos: () => number | undefined) => {
    const element = document.createElement("div");
    element.className = "scient-latex-footnotes";
    element.contentEditable = "false";
    element.setAttribute("role", "group");
    element.setAttribute("aria-label", "Footnotes");
    Object.defineProperty(element, "scientFootnoteEnd", { get: getPos });
    // Returns to the marker of the note at `index` in this band's block.
    const returnTo = (index: number) => {
      const end = getPos();
      if (end === undefined) return;
      const block = view.state.doc.resolve(end).nodeBefore;
      if (!block) return;
      const position = latexBlockFootnotes(view.state, end - block.nodeSize, end)[index];
      if (position === undefined) return;
      view.dispatch(view.state.tr.setSelection(NodeSelection.create(view.state.doc, position)));
      navigateToFootnote(view, position, false);
    };
    for (const [index, note] of notes.entries()) {
      const row = document.createElement("div");
      row.className = "scient-latex-footnote";
      row.tabIndex = 0;
      row.setAttribute("role", "button");
      row.setAttribute("aria-label", `Return to footnote ${note.number ?? ""} marker`);
      const marker = document.createElement("sup");
      marker.textContent = note.number ?? "*";
      const text = document.createElement("span");
      appendLatexProsePreview(text, note.body);
      row.append(marker, text);
      row.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        returnTo(index);
      });
      row.addEventListener("keydown", (event) => {
        if (event.key !== "Enter" && event.key !== " ") return;
        event.preventDefault();
        returnTo(index);
      });
      element.append(row);
    }
    return element;
  };
}

function decorate(state: EditorState, bands: readonly FootnoteBand[]) {
  return DecorationSet.create(
    state.doc,
    // Before a page marker at the same place: the notes belong to the page
    // the block ends on.
    bands.map(({ end, key, notes }) =>
      Decoration.widget(end, band(notes), { side: -2, key, ignoreSelection: true }),
    ),
  );
}

/**
 * Visual is continuous paper, so a block's footnotes are shown directly beneath
 * it; the compiled PDF places them at the foot of their page. Typing elsewhere
 * only maps the bands; a band is redrawn when its notes change. The bands are
 * read from the finished state, whatever order the plugins apply in.
 */
export const LatexFootnotes = Extension.create({
  name: "latexFootnotes",
  addProseMirrorPlugins() {
    let decoratedDocument: DocumentNode | undefined;
    // The footnotes the bands show, by position. Typing maps positions and
    // keeps each note's value, so comparing them avoids regrouping.
    let decoratedNotes: { readonly position: number; readonly value: object }[] = [];
    let bands: readonly FootnoteBand[] = [];
    let decorations = DecorationSet.empty;
    // Blocks were added, split, joined or replaced: a band may now belong to another block.
    let regroup = false;
    return [
      new Plugin({
        key: new PluginKey("scientLatexFootnotes"),
        state: {
          init: () => null,
          apply(transaction) {
            if (!transaction.docChanged || decoratedDocument !== transaction.before) return null;
            decorations = decorations.map(transaction.mapping, transaction.doc);
            bands = bands.map((band) => ({ ...band, end: transaction.mapping.map(band.end, -1) }));
            decoratedNotes = decoratedNotes.map((note) => ({
              ...note,
              position: transaction.mapping.map(note.position),
            }));
            decoratedDocument = transaction.doc;
            // Anything but typing within a block may move notes between blocks.
            regroup ||= isLatexVisualLoading(transaction) || !isOrdinaryTyping(transaction);
            return null;
          },
        },
        props: {
          decorations(state) {
            const footnotes = latexEquationReferencesKey.getState(state)?.footnotes ?? new Map();
            if (
              decoratedDocument === state.doc &&
              !regroup &&
              footnotes.size === decoratedNotes.length
            ) {
              let index = 0;
              let same = true;
              for (const [position, value] of footnotes) {
                const note = decoratedNotes[index++]!;
                if (note.position !== position || note.value !== value) {
                  same = false;
                  break;
                }
              }
              if (same) return decorations;
            }
            const next = bandsOf(state);
            // Mapping deletes a band whose block was replaced; then it is drawn again.
            const same =
              decoratedDocument === state.doc &&
              decorations.find().length === next.length &&
              next.length === bands.length &&
              next.every(
                (band, index) => band.key === bands[index]!.key && band.end === bands[index]!.end,
              );
            if (!same) decorations = decorate(state, next);
            bands = next;
            decoratedDocument = state.doc;
            decoratedNotes = [...footnotes].map(([position, value]) => ({ position, value }));
            regroup = false;
            return decorations;
          },
        },
      }),
    ];
  },
});
