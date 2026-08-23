import { closeBrackets, closeBracketsKeymap } from "@codemirror/autocomplete";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { markdown } from "@codemirror/lang-markdown";
import { bracketMatching, defaultHighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { searchKeymap } from "@codemirror/search";
import { Annotation, Compartment, EditorState, Transaction } from "@codemirror/state";
import {
  crosshairCursor,
  drawSelection,
  dropCursor,
  EditorView,
  highlightActiveLine,
  highlightActiveLineGutter,
  highlightSpecialChars,
  keymap,
  lineNumbers,
  rectangularSelection,
} from "@codemirror/view";

const externalSourceAnnotation = Annotation.define<boolean>();

export interface ScientMarkdownSourceViewOptions {
  readonly source: string;
  readonly editable: boolean;
  readonly ariaLabel: string;
  readonly onUserSourceChange: (source: string) => void;
}

/** Persistent CodeMirror source view used by Source and Split modes. */
export class ScientMarkdownSourceView {
  private readonly editableCompartment = new Compartment();
  private readonly readOnlyCompartment = new Compartment();
  private editorView: EditorView | null = null;
  private editable: boolean;

  constructor(private readonly options: ScientMarkdownSourceViewOptions) {
    this.editable = options.editable;
  }

  get view(): EditorView | null {
    return this.editorView;
  }

  get source(): string {
    return this.editorView?.state.doc.toString() ?? this.options.source;
  }

  mount(element: HTMLElement): EditorView {
    if (this.editorView !== null) return this.editorView;
    this.editorView = new EditorView({
      parent: element,
      state: EditorState.create({
        doc: this.options.source,
        extensions: [
          lineNumbers(),
          highlightActiveLineGutter(),
          highlightSpecialChars(),
          history(),
          drawSelection(),
          dropCursor(),
          rectangularSelection(),
          crosshairCursor(),
          highlightActiveLine(),
          bracketMatching(),
          closeBrackets(),
          markdown(),
          syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
          EditorView.lineWrapping,
          EditorView.contentAttributes.of({
            "aria-label": this.options.ariaLabel,
            "aria-multiline": "true",
          }),
          keymap.of([
            ...closeBracketsKeymap,
            ...defaultKeymap,
            ...searchKeymap,
            ...historyKeymap,
            indentWithTab,
          ]),
          this.editableCompartment.of(EditorView.editable.of(this.editable)),
          this.readOnlyCompartment.of(EditorState.readOnly.of(!this.editable)),
          EditorView.updateListener.of((update) => {
            if (!update.docChanged) return;
            if (
              update.transactions.some(
                (transaction) => transaction.annotation(externalSourceAnnotation) === true,
              )
            ) {
              return;
            }
            this.options.onUserSourceChange(update.state.doc.toString());
          }),
        ],
      }),
    });
    return this.editorView;
  }

  setEditable(editable: boolean): void {
    if (this.editable === editable) return;
    this.editable = editable;
    this.editorView?.dispatch({
      effects: [
        this.editableCompartment.reconfigure(EditorView.editable.of(editable)),
        this.readOnlyCompartment.reconfigure(EditorState.readOnly.of(!editable)),
      ],
    });
  }

  replaceExternalSource(source: string): void {
    const view = this.editorView;
    if (!view || source === view.state.doc.toString()) return;
    const selectionHead = Math.min(view.state.selection.main.head, source.length);
    view.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert: source },
      selection: { anchor: selectionHead },
      annotations: [externalSourceAnnotation.of(true), Transaction.addToHistory.of(false)],
    });
  }

  revealLine(line: number): void {
    const view = this.editorView;
    if (!view) return;
    const clamped = Math.min(Math.max(1, line), view.state.doc.lines);
    const position = view.state.doc.line(clamped).from;
    view.dispatch({
      selection: { anchor: position },
      effects: EditorView.scrollIntoView(position, { y: "center" }),
    });
  }

  destroy(): void {
    this.editorView?.destroy();
    this.editorView = null;
  }
}
