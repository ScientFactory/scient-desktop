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
        tag: [tags.function(tags.variableName), tags.macroName],
        color: semanticColor(theme, "function"),
      },
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

export interface ScientNestedCodeEditor {
  readonly focus: () => void;
  readonly focusAt: (coordinates: { readonly x: number; readonly y: number }) => void;
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
  const languageCompartment = new Compartment();
  const appearanceCompartment = new Compartment();
  const languageDescription = LanguageDescription.matchLanguageName(
    languages,
    input.language,
    true,
  );
  const documentRoot = input.parent.ownerDocument.documentElement;
  let destroyed = false;
  const view = new EditorView({
    parent: input.parent,
    state: EditorState.create({
      doc: input.code,
      extensions: [
        highlightSpecialChars(),
        history(),
        drawSelection(),
        bracketMatching(),
        syntaxHighlighting(lightHighlightStyle),
        syntaxHighlighting(darkHighlightStyle),
        appearanceCompartment.of(editorThemeFor(documentRoot)),
        languageCompartment.of([]),
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
  let isDark = documentRoot.classList.contains("dark");
  const MutationObserverConstructor = input.parent.ownerDocument.defaultView?.MutationObserver;
  const appearanceObserver = MutationObserverConstructor
    ? new MutationObserverConstructor(() => {
        const nextIsDark = documentRoot.classList.contains("dark");
        if (destroyed || nextIsDark === isDark) return;
        isDark = nextIsDark;
        view.dispatch({ effects: appearanceCompartment.reconfigure(editorThemeFor(documentRoot)) });
      })
    : null;
  appearanceObserver?.observe(documentRoot, { attributes: true, attributeFilter: ["class"] });
  if (languageDescription) {
    void languageDescription
      .load()
      .then((languageSupport) => {
        if (destroyed) return;
        view.dispatch({ effects: languageCompartment.reconfigure(languageSupport) });
      })
      .catch(() => undefined);
  }
  return {
    focus: () => view.focus(),
    focusAt: (coordinates) => {
      const position = view.posAtCoords(coordinates);
      if (position !== null) {
        view.dispatch({ selection: { anchor: position }, scrollIntoView: true });
      }
      view.focus();
    },
    replaceExternalCode: (code) => {
      if (code === view.state.doc.toString()) return;
      view.dispatch({
        changes: { from: 0, to: view.state.doc.length, insert: code },
        annotations: [externalCodeAnnotation.of(true), Transaction.addToHistory.of(false)],
      });
    },
    destroy: () => {
      destroyed = true;
      appearanceObserver?.disconnect();
      view.destroy();
    },
  };
}
