import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import {
  bracketMatching,
  HighlightStyle,
  LanguageDescription,
  syntaxHighlighting,
} from "@codemirror/language";
import { languages } from "@codemirror/language-data";
import { Annotation, Compartment, EditorState, Transaction } from "@codemirror/state";
import { drawSelection, EditorView, highlightSpecialChars, keymap } from "@codemirror/view";
import { tags } from "@lezer/highlight";
import pierreDark from "@pierre/theme/pierre-dark";
import pierreLight from "@pierre/theme/pierre-light";

const externalCodeAnnotation = Annotation.define<boolean>();

type PierreSemanticToken =
  | "class"
  | "comment"
  | "decorator"
  | "enumMember"
  | "function"
  | "keyword"
  | "namespace"
  | "number"
  | "parameter"
  | "property"
  | "regexp"
  | "string"
  | "type"
  | "variable"
  | "variable.constant"
  | "variable.defaultLibrary";

function semanticColor(
  theme: typeof pierreLight | typeof pierreDark,
  token: PierreSemanticToken,
): string {
  const color = theme.semanticTokenColors[token];
  return typeof color === "string" ? color : theme.colors["editor.foreground"]!;
}

// These syntactic categories have no semantic-token equivalent. Use the same
// TextMate palette that Shiki reads for the shared Markdown preview.
function syntaxColor(theme: typeof pierreLight | typeof pierreDark, scope: string): string {
  const token = theme.tokenColors.findLast((entry) =>
    typeof entry.scope === "string" ? entry.scope === scope : entry.scope?.includes(scope) === true,
  );
  return token?.settings.foreground ?? theme.colors["editor.foreground"]!;
}

function pierreHighlightStyle(
  theme: typeof pierreLight | typeof pierreDark,
  themeType: "light" | "dark",
): HighlightStyle {
  return HighlightStyle.define(
    [
      { tag: tags.comment, color: semanticColor(theme, "comment"), fontStyle: "italic" },
      { tag: [tags.string, tags.docString, tags.character], color: semanticColor(theme, "string") },
      { tag: tags.regexp, color: semanticColor(theme, "regexp") },
      { tag: [tags.number, tags.bool], color: semanticColor(theme, "number") },
      {
        tag: [tags.keyword, tags.atom, tags.self, tags.null, tags.modifier],
        color: semanticColor(theme, "keyword"),
      },
      { tag: tags.definition(tags.variableName), color: semanticColor(theme, "variable") },
      { tag: tags.local(tags.variableName), color: semanticColor(theme, "parameter") },
      { tag: tags.variableName, color: semanticColor(theme, "variable") },
      { tag: tags.propertyName, color: semanticColor(theme, "property") },
      {
        tag: [tags.function(tags.variableName), tags.function(tags.propertyName), tags.macroName],
        color: semanticColor(theme, "function"),
      },
      { tag: tags.operator, color: syntaxColor(theme, "keyword.operator") },
      { tag: tags.punctuation, color: syntaxColor(theme, "punctuation") },
      { tag: tags.tagName, color: syntaxColor(theme, "entity.name.tag") },
      { tag: tags.attributeName, color: syntaxColor(theme, "entity.other.attribute-name") },
      { tag: tags.attributeValue, color: semanticColor(theme, "string") },
      { tag: tags.typeName, color: semanticColor(theme, "type") },
      { tag: tags.className, color: semanticColor(theme, "class") },
      { tag: tags.namespace, color: semanticColor(theme, "namespace") },
      { tag: tags.labelName, color: semanticColor(theme, "enumMember") },
      {
        tag: [tags.constant(tags.variableName), tags.special(tags.variableName)],
        color: semanticColor(theme, "variable.constant"),
      },
      { tag: tags.annotation, color: semanticColor(theme, "decorator") },
      {
        tag: [tags.link, tags.url],
        color: semanticColor(theme, "decorator"),
        textDecoration: "underline",
      },
      { tag: tags.heading, color: semanticColor(theme, "function"), fontWeight: "bold" },
      { tag: tags.strong, fontWeight: "bold" },
      { tag: tags.emphasis, fontStyle: "italic" },
      { tag: tags.strikethrough, textDecoration: "line-through" },
      {
        tag: tags.invalid,
        color: semanticColor(theme, "keyword"),
        textDecoration: "underline wavy",
      },
    ],
    { themeType },
  );
}

const lightHighlightStyle = pierreHighlightStyle(pierreLight, "light");
const darkHighlightStyle = pierreHighlightStyle(pierreDark, "dark");
const lightEditorTheme = EditorView.theme({});
const darkEditorTheme = EditorView.theme({}, { dark: true });

function editorThemeFor(root: HTMLElement) {
  return root.classList.contains("dark") ? darkEditorTheme : lightEditorTheme;
}

export interface ScientCodeChange {
  readonly from: number;
  readonly to: number;
  readonly insert: string;
}

export interface ScientNestedCodeEditor {
  readonly focus: () => void;
  readonly refreshAppearance: () => void;
  readonly replaceExternalCode: (code: string, language?: string) => void;
  readonly setEditable: (editable: boolean) => void;
  readonly setWordWrap: (wrapped: boolean) => void;
  readonly destroy: () => void;
}

export type ScientNestedCodeEditorRegistrar = (editor: ScientNestedCodeEditor) => () => void;

export function createScientNestedCodeEditor(input: {
  readonly ariaLabel?: string;
  readonly parent: HTMLElement;
  readonly code: string;
  readonly editable: boolean;
  readonly language: string;
  readonly wordWrap?: boolean;
  readonly historyCommands?: { readonly undo: () => boolean; readonly redo: () => boolean };
  readonly onUserCodeChange: (code: string, changes: readonly ScientCodeChange[]) => void;
  readonly onEscape: () => void;
}): ScientNestedCodeEditor {
  const languageCompartment = new Compartment();
  const appearanceCompartment = new Compartment();
  const editableCompartment = new Compartment();
  const accessibilityCompartment = new Compartment();
  const wrappingCompartment = new Compartment();
  const documentRoot = input.parent.ownerDocument.documentElement;
  let destroyed = false;
  let isDark = documentRoot.classList.contains("dark");
  let editable = input.editable;
  let wrapped = input.wordWrap ?? true;
  let language = "";
  let languageVersion = 0;
  const accessibilityLabel = (nextLanguage: string): string =>
    input.ariaLabel ?? `${nextLanguage || "Plain text"} code block`;
  const view = new EditorView({
    parent: input.parent,
    state: EditorState.create({
      doc: input.code,
      extensions: [
        highlightSpecialChars(),
        input.historyCommands ? [] : history(),
        drawSelection(),
        bracketMatching(),
        syntaxHighlighting(lightHighlightStyle),
        syntaxHighlighting(darkHighlightStyle),
        appearanceCompartment.of(editorThemeFor(documentRoot)),
        languageCompartment.of([]),
        editableCompartment.of([
          EditorState.readOnly.of(!editable),
          EditorView.editable.of(editable),
        ]),
        wrappingCompartment.of(wrapped ? EditorView.lineWrapping : []),
        accessibilityCompartment.of(
          EditorView.contentAttributes.of({
            "aria-label": accessibilityLabel(input.language),
            "aria-multiline": "true",
          }),
        ),
        keymap.of([
          {
            key: "Escape",
            run: () => {
              input.onEscape();
              return true;
            },
          },
          ...defaultKeymap,
          ...(input.historyCommands
            ? [
                { key: "Mod-z", run: input.historyCommands.undo },
                { key: "Mod-Shift-z", run: input.historyCommands.redo },
                { key: "Mod-y", run: input.historyCommands.redo },
              ]
            : historyKeymap),
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
          const changes: ScientCodeChange[] = [];
          update.changes.iterChanges((from, to, _fromB, _toB, inserted) => {
            changes.push({ from, to, insert: inserted.toString() });
          });
          input.onUserCodeChange(update.state.doc.toString(), changes);
        }),
      ],
    }),
  });
  const configureLanguage = (nextLanguage: string): void => {
    if (destroyed || nextLanguage === language) return;
    language = nextLanguage;
    const version = ++languageVersion;
    view.dispatch({
      effects: accessibilityCompartment.reconfigure(
        EditorView.contentAttributes.of({
          "aria-label": accessibilityLabel(language),
          "aria-multiline": "true",
        }),
      ),
    });
    const syntaxLanguage = /^(?:plotly(?:\.js|-json|js)?|vega(?:-lite)?|vegalite|vl)$/i.test(
      language.trim(),
    )
      ? "json"
      : language;
    if (syntaxLanguage.toLowerCase() === "mermaid") {
      view.dispatch({ effects: languageCompartment.reconfigure([]) });
      void import("./mermaidCodeHighlighting")
        .then(({ mermaidCodeHighlighting }) => {
          if (!destroyed && version === languageVersion) {
            view.dispatch({ effects: languageCompartment.reconfigure(mermaidCodeHighlighting) });
          }
        })
        .catch(() => {
          /* Keep the source editable if highlighting cannot load. */
        });
      return;
    }
    const description = LanguageDescription.matchLanguageName(languages, syntaxLanguage, true);
    if (!description) {
      view.dispatch({ effects: languageCompartment.reconfigure([]) });
      return;
    }
    void description
      .load()
      .then((languageSupport) => {
        if (destroyed || version !== languageVersion) return;
        view.dispatch({ effects: languageCompartment.reconfigure(languageSupport) });
      })
      .catch(() => {
        if (!destroyed && version === languageVersion) {
          view.dispatch({ effects: languageCompartment.reconfigure([]) });
        }
      });
  };

  // The first language starts as an empty compartment so the editor can mount
  // synchronously; its parser loads without delaying or replacing the surface.
  configureLanguage(input.language);

  return {
    focus: () => view.focus(),
    refreshAppearance: () => {
      const nextIsDark = documentRoot.classList.contains("dark");
      if (destroyed || nextIsDark === isDark) return;
      isDark = nextIsDark;
      view.dispatch({ effects: appearanceCompartment.reconfigure(editorThemeFor(documentRoot)) });
    },
    replaceExternalCode: (code, nextLanguage = language) => {
      configureLanguage(nextLanguage);
      const before = view.state.doc.toString();
      if (code === before) return;
      // Preserve the nested selection outside the changed range on outer undo,
      // redo and external updates instead of replacing its entire document.
      let from = 0;
      while (from < before.length && from < code.length && before[from] === code[from]) from++;
      let to = before.length;
      let end = code.length;
      while (to > from && end > from && before[to - 1] === code[end - 1]) {
        to--;
        end--;
      }
      view.dispatch({
        changes: { from, to, insert: code.slice(from, end) },
        annotations: [externalCodeAnnotation.of(true), Transaction.addToHistory.of(false)],
      });
    },
    setEditable: (nextEditable) => {
      if (destroyed || nextEditable === editable) return;
      editable = nextEditable;
      view.dispatch({
        effects: editableCompartment.reconfigure([
          EditorState.readOnly.of(!editable),
          EditorView.editable.of(editable),
        ]),
      });
    },
    setWordWrap: (nextWrapped) => {
      if (destroyed || nextWrapped === wrapped) return;
      wrapped = nextWrapped;
      view.dispatch({
        effects: wrappingCompartment.reconfigure(wrapped ? EditorView.lineWrapping : []),
      });
    },
    destroy: () => {
      destroyed = true;
      languageVersion += 1;
      view.destroy();
    },
  };
}
