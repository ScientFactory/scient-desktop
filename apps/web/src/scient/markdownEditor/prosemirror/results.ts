import {
  parseResultTarget,
  RESULT_PROTOCOL,
  type ResultReferenceState,
  type ResultTarget,
} from "@t3tools/shared/computeResults";
import type { Mark, Node as ProseMirrorNode } from "prosemirror-model";
import { type EditorState, Plugin, PluginKey, type Transaction } from "prosemirror-state";
import { closeHistory } from "prosemirror-history";
import { Decoration, DecorationSet } from "prosemirror-view";

import { scientMarkdownSchema } from "./schema";

/** One linked result in the document, as the editor holds it now. */
export type EditorResultReference = ResultTarget & {
  readonly href: string;
  readonly position: number;
} & (
    | { readonly kind: "value"; readonly text: string }
    | { readonly kind: "figure"; readonly src: string; readonly alt: string }
  );

/** The one mark a result shows; current shows none. */
export type ResultMarkState = ResultReferenceState;

const resultLink = (marks: ReadonlyArray<Mark>) =>
  marks.find(
    (mark) =>
      mark.type === scientMarkdownSchema.marks.link &&
      String(mark.attrs.href).startsWith(RESULT_PROTOCOL),
  );

export function editorResultReferences(doc: ProseMirrorNode): ReadonlyArray<EditorResultReference> {
  const references: EditorResultReference[] = [];
  doc.descendants((node, position) => {
    if (node.type === scientMarkdownSchema.nodes.result_value) {
      const href = String(node.attrs.target);
      const target = parseResultTarget(href);
      if (target !== null)
        references.push({
          ...target,
          href,
          position,
          kind: "value",
          text: String(node.attrs.text),
        });
      return false;
    }
    if (node.type === scientMarkdownSchema.nodes.image) {
      const link = resultLink(node.marks);
      const href = link === undefined ? null : String(link.attrs.href);
      const target = href === null ? null : parseResultTarget(href);
      if (href !== null && target !== null)
        references.push({
          ...target,
          href,
          position,
          kind: "figure",
          src: String(node.attrs.src),
          alt: String(node.attrs.alt ?? ""),
        });
      return false;
    }
    return true;
  });
  return references;
}

const resultsKey = new PluginKey<ResultsPluginState>("scient-markdown-results");

interface ResultsPluginState {
  readonly states: ReadonlyMap<string, ResultMarkState>;
  readonly decorations: DecorationSet;
}

/** Keyed by the reference's href and, for a value, its shown text. */
export const resultMarkKey = (reference: EditorResultReference) =>
  reference.kind === "value" ? `${reference.href}\u0000${reference.text}` : reference.href;

function decorate(doc: ProseMirrorNode, states: ReadonlyMap<string, ResultMarkState>) {
  const decorations = editorResultReferences(doc).flatMap((reference) => {
    const node = doc.nodeAt(reference.position);
    if (node === null) return [];
    const state = states.get(resultMarkKey(reference));
    return [
      Decoration.node(reference.position, reference.position + node.nodeSize, {
        class: "scient-result",
        "data-result-href": reference.href,
        ...(state === undefined || state === "current" ? {} : { "data-result-state": state }),
      }),
    ];
  });
  return DecorationSet.create(doc, decorations);
}

export function scientMarkdownResultsPlugin(): Plugin<ResultsPluginState> {
  return new Plugin<ResultsPluginState>({
    key: resultsKey,
    state: {
      init: (_config, state) => ({
        states: new Map(),
        decorations: decorate(state.doc, new Map()),
      }),
      apply: (transaction, previous) => {
        const states: ReadonlyMap<string, ResultMarkState> | undefined =
          transaction.getMeta(resultsKey);
        if (states !== undefined) return { states, decorations: decorate(transaction.doc, states) };
        if (!transaction.docChanged) return previous;
        return { states: previous.states, decorations: decorate(transaction.doc, previous.states) };
      },
    },
    props: { decorations: (state) => resultsKey.getState(state)?.decorations ?? null },
  });
}

export function setResultMarks(
  state: EditorState,
  states: ReadonlyMap<string, ResultMarkState>,
): Transaction {
  return state.tr.setMeta(resultsKey, states).setMeta("addToHistory", false);
}

export type ResultUpdate =
  | {
      readonly kind: "value";
      readonly position: number;
      readonly href: string;
      readonly text: string;
    }
  | {
      readonly kind: "figure";
      readonly position: number;
      readonly href: string;
      readonly src: string;
    };

/** Moves results to new revisions in one transaction, so one undo reverts the whole update. */
export function updateResults(
  state: EditorState,
  updates: ReadonlyArray<ResultUpdate>,
): Transaction | null {
  const link = scientMarkdownSchema.marks.link;
  const valueType = scientMarkdownSchema.nodes.result_value;
  if (!link || !valueType) return null;
  let transaction = state.tr;
  for (const update of updates.toSorted((left, right) => right.position - left.position)) {
    const node = transaction.doc.nodeAt(update.position);
    if (node === null) continue;
    if (update.kind === "value" && node.type === valueType) {
      transaction = transaction.replaceWith(
        update.position,
        update.position + node.nodeSize,
        valueType.create({ target: update.href, text: update.text }, null, node.marks),
      );
    } else if (update.kind === "figure" && node.type === scientMarkdownSchema.nodes.image) {
      const previous = resultLink(node.marks);
      const marks = node.marks.map((mark) =>
        mark === previous ? link.create({ ...mark.attrs, href: update.href }) : mark,
      );
      transaction = transaction.replaceWith(
        update.position,
        update.position + node.nodeSize,
        node.type.create({ ...node.attrs, src: update.src }, null, marks),
      );
    }
  }
  // Its own undo step, never merged with the typing before it.
  return transaction.docChanged ? closeHistory(transaction) : null;
}

export function resultValueNode(href: string, text: string) {
  return scientMarkdownSchema.nodes.result_value?.create({ target: href, text }) ?? null;
}

export function resultFigureNode(input: {
  readonly href: string;
  readonly src: string;
  readonly alt: string;
}) {
  const image = scientMarkdownSchema.nodes.image;
  const link = scientMarkdownSchema.marks.link;
  if (!image || !link) return null;
  return image.create({ src: input.src, alt: input.alt, title: null }, null, [
    link.create({ href: input.href, title: null }),
  ]);
}
