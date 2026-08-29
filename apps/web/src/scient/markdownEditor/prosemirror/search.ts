import type { Node as ProseMirrorNode } from "prosemirror-model";
import { Plugin, PluginKey, type EditorState, type Transaction } from "prosemirror-state";
import { Decoration, DecorationSet } from "prosemirror-view";

import { markdownTextMatches } from "../searchText";

export interface ScientMarkdownSearchMatch {
  readonly from: number;
  readonly to: number;
}

export interface ScientMarkdownSearchState {
  readonly activeIndex: number;
  readonly caseSensitive: boolean;
  readonly decorations: DecorationSet;
  readonly matches: ReadonlyArray<ScientMarkdownSearchMatch>;
  readonly query: string;
  readonly wholeWord: boolean;
}

type SearchMeta =
  | {
      readonly action: "configure";
      readonly query: string;
      readonly caseSensitive: boolean;
      readonly wholeWord: boolean;
    }
  | { readonly action: "navigate"; readonly direction: -1 | 1 }
  | { readonly action: "clear" };

export const scientMarkdownSearchPluginKey = new PluginKey<ScientMarkdownSearchState>(
  "scientMarkdownSearch",
);

function documentMatches(
  doc: ProseMirrorNode,
  query: string,
  caseSensitive: boolean,
  wholeWord: boolean,
): ReadonlyArray<ScientMarkdownSearchMatch> {
  const matches: ScientMarkdownSearchMatch[] = [];
  doc.descendants((node, position) => {
    if (!node.inlineContent) return;
    const text = node.textBetween(0, node.content.size, "\uFFFC", "\uFFFC");
    for (const match of markdownTextMatches(text, query, caseSensitive, wholeWord)) {
      matches.push({ from: position + 1 + match.from, to: position + 1 + match.to });
    }
    return false;
  });
  return matches;
}

function decorationsFor(
  doc: ProseMirrorNode,
  matches: ReadonlyArray<ScientMarkdownSearchMatch>,
  activeIndex: number,
): DecorationSet {
  return DecorationSet.create(
    doc,
    matches.map((match, index) =>
      Decoration.inline(match.from, match.to, {
        class:
          index === activeIndex
            ? "scient-markdown-search-match is-active"
            : "scient-markdown-search-match",
        "data-scient-markdown-search-match": index === activeIndex ? "active" : "match",
      }),
    ),
  );
}

function configuredState(
  doc: ProseMirrorNode,
  input: {
    readonly activeIndex: number;
    readonly caseSensitive: boolean;
    readonly query: string;
    readonly wholeWord: boolean;
  },
): ScientMarkdownSearchState {
  const matches = documentMatches(doc, input.query, input.caseSensitive, input.wholeWord);
  const activeIndex =
    matches.length === 0 ? 0 : Math.min(Math.max(0, input.activeIndex), matches.length - 1);
  return {
    ...input,
    activeIndex,
    matches,
    decorations: decorationsFor(doc, matches, activeIndex),
  };
}

export function scientMarkdownSearchPlugin(): Plugin<ScientMarkdownSearchState> {
  return new Plugin<ScientMarkdownSearchState>({
    key: scientMarkdownSearchPluginKey,
    state: {
      init: (_config, state) =>
        configuredState(state.doc, {
          activeIndex: 0,
          caseSensitive: false,
          query: "",
          wholeWord: false,
        }),
      apply: (transaction, previous) => {
        const meta: SearchMeta | undefined = transaction.getMeta(scientMarkdownSearchPluginKey);
        if (meta?.action === "clear") {
          return configuredState(transaction.doc, {
            activeIndex: 0,
            caseSensitive: previous.caseSensitive,
            query: "",
            wholeWord: previous.wholeWord,
          });
        }
        if (meta?.action === "configure") {
          return configuredState(transaction.doc, {
            activeIndex: 0,
            caseSensitive: meta.caseSensitive,
            query: meta.query,
            wholeWord: meta.wholeWord,
          });
        }
        if (meta?.action === "navigate") {
          const activeIndex =
            previous.matches.length === 0
              ? 0
              : (previous.activeIndex + meta.direction + previous.matches.length) %
                previous.matches.length;
          return {
            ...previous,
            activeIndex,
            decorations: decorationsFor(transaction.doc, previous.matches, activeIndex),
          };
        }
        if (!transaction.docChanged) return previous;
        return configuredState(transaction.doc, previous);
      },
    },
    props: {
      decorations: (state) => scientMarkdownSearchPluginKey.getState(state)?.decorations ?? null,
    },
  });
}

export function configureScientMarkdownSearch(
  transaction: Transaction,
  input: { readonly query: string; readonly caseSensitive: boolean; readonly wholeWord: boolean },
): Transaction {
  return transaction.setMeta(scientMarkdownSearchPluginKey, {
    action: "configure",
    ...input,
  } satisfies SearchMeta);
}

export function navigateScientMarkdownSearch(
  transaction: Transaction,
  direction: -1 | 1,
): Transaction {
  return transaction.setMeta(scientMarkdownSearchPluginKey, {
    action: "navigate",
    direction,
  } satisfies SearchMeta);
}

export function clearScientMarkdownSearch(transaction: Transaction): Transaction {
  return transaction.setMeta(scientMarkdownSearchPluginKey, {
    action: "clear",
  } satisfies SearchMeta);
}

export function scientMarkdownSearchState(state: EditorState): ScientMarkdownSearchState {
  return (
    scientMarkdownSearchPluginKey.getState(state) ?? {
      activeIndex: 0,
      caseSensitive: false,
      decorations: DecorationSet.empty,
      matches: [],
      query: "",
      wholeWord: false,
    }
  );
}
