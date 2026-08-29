import { StateEffect, StateField, type EditorState, type Text } from "@codemirror/state";
import { Decoration, type DecorationSet, EditorView } from "@codemirror/view";

import { markdownTextMatches, type ScientMarkdownTextMatch } from "../searchText";

export interface ScientCm6FindConfig {
  readonly query: string;
  readonly caseSensitive: boolean;
  readonly wholeWord: boolean;
}

export interface ScientCm6FindState extends ScientCm6FindConfig {
  readonly activeIndex: number;
  readonly matches: ReadonlyArray<ScientMarkdownTextMatch>;
  readonly decorations: DecorationSet;
}

export const configureCm6Find = StateEffect.define<ScientCm6FindConfig>();
export const navigateCm6Find = StateEffect.define<-1 | 1>();
export const clearCm6Find = StateEffect.define<null>();

const EMPTY_FIND_STATE: ScientCm6FindState = {
  activeIndex: 0,
  caseSensitive: false,
  decorations: Decoration.none,
  matches: [],
  query: "",
  wholeWord: false,
};

function decorationsFor(
  matches: ReadonlyArray<ScientMarkdownTextMatch>,
  activeIndex: number,
): DecorationSet {
  if (matches.length === 0) return Decoration.none;
  return Decoration.set(
    matches.map((match, index) =>
      Decoration.mark({
        class:
          index === activeIndex
            ? "scient-markdown-search-match is-active"
            : "scient-markdown-search-match",
        attributes: {
          "data-scient-markdown-search-match": index === activeIndex ? "active" : "match",
        },
      }).range(match.from, match.to),
    ),
  );
}

function configuredState(
  doc: Text,
  input: ScientCm6FindConfig & { readonly activeIndex: number },
): ScientCm6FindState {
  const matches = markdownTextMatches(
    doc.toString(),
    input.query,
    input.caseSensitive,
    input.wholeWord,
  );
  const activeIndex =
    matches.length === 0 ? 0 : Math.min(Math.max(0, input.activeIndex), matches.length - 1);
  return {
    ...input,
    activeIndex,
    matches,
    decorations: decorationsFor(matches, activeIndex),
  };
}

/** Find/replace state mirroring the ProseMirror surface's search plugin. */
export const scientCm6FindField = StateField.define<ScientCm6FindState>({
  create: () => EMPTY_FIND_STATE,
  update(value, transaction) {
    let next = value;
    for (const effect of transaction.effects) {
      if (effect.is(configureCm6Find)) {
        next = configuredState(transaction.state.doc, { ...effect.value, activeIndex: 0 });
      } else if (effect.is(navigateCm6Find)) {
        const activeIndex =
          next.matches.length === 0
            ? 0
            : (next.activeIndex + effect.value + next.matches.length) % next.matches.length;
        next = { ...next, activeIndex, decorations: decorationsFor(next.matches, activeIndex) };
      } else if (effect.is(clearCm6Find)) {
        next = {
          ...EMPTY_FIND_STATE,
          caseSensitive: next.caseSensitive,
          wholeWord: next.wholeWord,
        };
      }
    }
    if (transaction.docChanged && next.query.length > 0) {
      next = configuredState(transaction.state.doc, next);
    }
    return next;
  },
  provide: (field) => EditorView.decorations.from(field, (state) => state.decorations),
});

export function scientCm6FindState(state: EditorState): ScientCm6FindState {
  return state.field(scientCm6FindField, false) ?? EMPTY_FIND_STATE;
}
