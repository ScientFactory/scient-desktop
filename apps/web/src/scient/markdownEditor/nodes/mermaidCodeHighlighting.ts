import { StateEffect, type Extension } from "@codemirror/state";
import {
  Decoration,
  EditorView,
  ViewPlugin,
  type DecorationSet,
  type ViewUpdate,
} from "@codemirror/view";

import { resolveDiffThemeName } from "~/lib/diffRendering";
import { getSyntaxHighlighterPromise } from "~/lib/syntaxHighlighting";

const highlighterReady = StateEffect.define<void>();
// Shiki's Mermaid grammar enters diagram rules inside a Markdown fence.
// Supply that grammar context without adding it to the editable document.
const grammarPrefix = "```mermaid\n";

// CodeMirror has no bundled Mermaid parser. Reuse the preview's grammar and
// palette as decorations; the existing editor still owns text and selection.
export const mermaidCodeHighlighting: Extension = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet = Decoration.none;
    private highlighter: Awaited<ReturnType<typeof getSyntaxHighlighterPromise>> | null = null;
    private destroyed = false;

    constructor(private readonly view: EditorView) {
      void getSyntaxHighlighterPromise("mermaid")
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
