import { StateEffect, type Extension } from "@codemirror/state";
import {
  Decoration,
  EditorView,
  ViewPlugin,
  type DecorationSet,
  type ViewUpdate,
} from "@codemirror/view";

import { createHighlighterCore, type HighlighterCore, type ThemeRegistrationAny } from "shiki/core";
import { createOnigurumaEngine } from "shiki/engine/oniguruma";

import { resolveDiffThemeName } from "~/lib/diffRendering";

const highlighterReady = StateEffect.define<void>();

// The app's shared highlighter has no Mermaid lexer, so Mermaid sources get a
// small Shiki instance of their own, loaded only when one is edited.
let mermaidHighlighter: Promise<HighlighterCore> | undefined;
export function getMermaidHighlighter(): Promise<HighlighterCore> {
  mermaidHighlighter ??= createHighlighterCore({
    // Pierre's themes are TextMate themes typed as deeply readonly.
    themes: [
      import("@pierre/theme/pierre-light").then((theme) => theme.default as ThemeRegistrationAny),
      import("@pierre/theme/pierre-dark").then((theme) => theme.default as ThemeRegistrationAny),
    ],
    langs: [import("shiki/langs/mermaid.mjs")],
    engine: createOnigurumaEngine(import("shiki/wasm")),
  });
  return mermaidHighlighter;
}
// Shiki's Mermaid grammar enters diagram rules inside a Markdown fence.
// Supply that grammar context without adding it to the editable document.
const grammarPrefix = "```mermaid\n";

// CodeMirror has no bundled Mermaid parser. Paint Shiki's tokens in the
// preview's palette as decorations; the editor still owns text and selection.
export const mermaidCodeHighlighting: Extension = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet = Decoration.none;
    private highlighter: HighlighterCore | null = null;
    private destroyed = false;

    constructor(private readonly view: EditorView) {
      void getMermaidHighlighter()
        .then((highlighter) => {
          if (this.destroyed) return;
          this.highlighter = highlighter;
          this.view.dispatch({ effects: highlighterReady.of(undefined) });
        })
        .catch(() => {
          // A failed grammar load must leave the source editable.
        });
    }

    update(update: ViewUpdate): void {
      if (
        !update.docChanged &&
        update.startState.facet(EditorView.darkTheme) ===
          update.state.facet(EditorView.darkTheme) &&
        !update.transactions.some((transaction) =>
          transaction.effects.some((effect) => effect.is(highlighterReady)),
        )
      )
        return;
      if (!this.highlighter) return;
      try {
        const { tokens } = this.highlighter.codeToTokens(
          grammarPrefix + update.state.doc.toString() + "\n```",
          {
            lang: "mermaid",
            theme: resolveDiffThemeName(
              update.state.facet(EditorView.darkTheme) ? "dark" : "light",
            ),
          },
        );
        this.decorations = Decoration.set(
          tokens
            .slice(1, -1)
            .flatMap((line) =>
              line.flatMap((token) =>
                token.content.length > 0 && token.color
                  ? [
                      Decoration.mark({ attributes: { style: `color: ${token.color}` } }).range(
                        token.offset - grammarPrefix.length,
                        token.offset - grammarPrefix.length + token.content.length,
                      ),
                    ]
                  : [],
              ),
            ),
          true,
        );
      } catch {
        this.decorations = Decoration.none;
      }
    }

    destroy(): void {
      this.destroyed = true;
    }
  },
  { decorations: (plugin) => plugin.decorations },
);
