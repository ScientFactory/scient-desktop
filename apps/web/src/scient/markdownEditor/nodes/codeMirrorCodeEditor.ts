import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { bracketMatching, defaultHighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { Annotation, EditorState, Transaction } from "@codemirror/state";
import {
  drawSelection,
  EditorView,
  highlightActiveLine,
  highlightSpecialChars,
  keymap,
} from "@codemirror/view";

const externalCodeAnnotation = Annotation.define<boolean>();

export interface ScientNestedCodeEditor {
  readonly focus: () => void;
  readonly replaceExternalCode: (code: string) => void;
  readonly destroy: () => void;
}

export function createScientNestedCodeEditor(input: {
  readonly parent: HTMLElement;
  readonly code: string;
  readonly language: string;
  readonly onUserCodeChange: (code: string) => void;
  readonly onEscape: () => void;
}): ScientNestedCodeEditor {
  const view = new EditorView({
    parent: input.parent,
    state: EditorState.create({
      doc: input.code,
      extensions: [
        highlightSpecialChars(),
        history(),
        drawSelection(),
        highlightActiveLine(),
        bracketMatching(),
        syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
        EditorView.lineWrapping,
        EditorView.contentAttributes.of({
          "aria-label": `${input.language || "Plain text"} code block`,
          "aria-multiline": "true",
        }),
        keymap.of([
          {
            key: "Escape",
            run: () => {
              input.onEscape();
              return true;
            },
          },
          ...defaultKeymap,
          ...historyKeymap,
          indentWithTab,
        ]),
        EditorView.updateListener.of((update) => {
          if (!update.docChanged) return;
          if (
            update.transactions.some(
              (transaction) => transaction.annotation(externalCodeAnnotation) === true,
            )
          ) {
            return;
          }
          input.onUserCodeChange(update.state.doc.toString());
        }),
      ],
    }),
  });
  return {
    focus: () => view.focus(),
    replaceExternalCode: (code) => {
      if (code === view.state.doc.toString()) return;
      view.dispatch({
        changes: { from: 0, to: view.state.doc.length, insert: code },
        annotations: [externalCodeAnnotation.of(true), Transaction.addToHistory.of(false)],
      });
    },
    destroy: () => view.destroy(),
  };
}
