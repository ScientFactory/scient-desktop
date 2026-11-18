import {
  isResultTableOutput,
  parseResultTarget,
  RESULT_PROTOCOL,
  type ResultReferenceState,
  type ResultTarget,
} from "@t3tools/shared/computeResults";
import { Fragment, type Mark, type Node as ProseMirrorNode, Slice } from "prosemirror-model";
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
    /**
     * A table linked from the caption paragraph right after it. `position` is the table's;
     * `captionPosition` the caption paragraph's.
     */
    | {
        readonly kind: "table";
        readonly rows: ReadonlyArray<ReadonlyArray<string>>;
        readonly caption: string;
        readonly captionPosition: number;
        /** The caption's result atom, which is what a click lands on. */
        readonly atomPosition: number;
      }
  );

/** The one mark a result shows; current shows none. */
export type ResultMarkState = ResultReferenceState;

const resultLink = (marks: ReadonlyArray<Mark>) =>
  marks.find(
    (mark) =>
      mark.type === scientMarkdownSchema.marks.link &&
      String(mark.attrs.href).startsWith(RESULT_PROTOCOL),
  );

const isTableTarget = (href: string) => {
  const target = parseResultTarget(href);
  return target !== null && target.pointer === null && isResultTableOutput(target.output);
};

/**
 * The caption's link to a CSV table: a paragraph that is `Table: ` (or Pandoc's bare `: `) and one
 * result atom, which is how Markdown reads `Table: [Table 1](scient-result:…)`. A sentence that
 * merely cites a table's file is not its caption.
 */
function tableCaptionLink(paragraph: ProseMirrorNode) {
  let prefix = "";
  let found: { href: string; caption: string; offset: number } | null = null;
  let valid = true;
  paragraph.forEach((child, offset) => {
    if (!valid) return;
    if (found === null && child.isText) prefix += child.text ?? "";
    else if (found === null && child.type === scientMarkdownSchema.nodes.result_value) {
      const href = String(child.attrs.target);
      if (isTableTarget(href) && /^\s*(?:Table)?:\s*$/u.test(prefix))
        found = { href, caption: String(child.attrs.text), offset };
      else valid = false;
    } else if (!(child.isText && (child.text ?? "").trim() === "")) valid = false;
  });
  return valid ? (found as { href: string; caption: string; offset: number } | null) : null;
}

const tableRows = (table: ProseMirrorNode): ReadonlyArray<ReadonlyArray<string>> => {
  const rows: string[][] = [];
  table.forEach((row) => {
    const cells: string[] = [];
    row.forEach((cell) => cells.push(cell.textContent));
    rows.push(cells);
  });
  return rows;
};

export function editorResultReferences(doc: ProseMirrorNode): ReadonlyArray<EditorResultReference> {
  const references: EditorResultReference[] = [];
  doc.descendants((node, position, parent, index) => {
    if (node.type === scientMarkdownSchema.nodes.paragraph && parent !== null && index > 0) {
      const table = parent.child(index - 1);
      const link = table.type === scientMarkdownSchema.nodes.table ? tableCaptionLink(node) : null;
      const target = link === null ? null : parseResultTarget(link.href);
      if (link !== null && target !== null)
        references.push({
          ...target,
          href: link.href,
          position: position - table.nodeSize,
          kind: "table",
          rows: tableRows(table),
          caption: link.caption,
          captionPosition: position,
          atomPosition: position + 1 + link.offset,
        });
      // Values can sit in a caption too, so its children are still read.
    }
    if (node.type === scientMarkdownSchema.nodes.result_value) {
      const href = String(node.attrs.target);
      const target = parseResultTarget(href);
      // A table's caption atom stands for the table, found with its caption paragraph.
      if (target !== null && !isTableTarget(href))
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
  reference.kind === "value"
    ? `${reference.href}\u0000${reference.text}`
    : reference.kind === "table"
      ? `${reference.href}\u0000${JSON.stringify(reference.rows)}`
      : reference.href;

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
    }
  | {
      readonly kind: "table";
      readonly position: number;
      readonly captionPosition: number;
      readonly previousHref: string;
      readonly href: string;
      readonly rows: ReadonlyArray<ReadonlyArray<string>>;
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
    if (update.kind === "table") {
      // The caption comes after the table, so it is relinked first and the table's position holds.
      const caption = transaction.doc.nodeAt(update.captionPosition);
      const table = resultTableNode(update.rows);
      if (caption === null || node.type !== scientMarkdownSchema.nodes.table || table === null)
        continue;
      caption.forEach((child, offset) => {
        if (child.type !== valueType || child.attrs.target !== update.previousHref) return;
        const from = update.captionPosition + 1 + offset;
        transaction = transaction.replaceWith(
          from,
          from + child.nodeSize,
          valueType.create({ ...child.attrs, target: update.href }, null, child.marks),
        );
      });
      transaction = transaction.replaceWith(
        update.position,
        update.position + node.nodeSize,
        table,
      );
      continue;
    }
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

const NUMBER_CELL = /^\s*[+\-\u2212]?(?:\d[\d,]*(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?\s*%?\s*$/u;

/** A table of a CSV's cells as written, header first, numeric columns right-aligned. */
function resultTableNode(rows: ReadonlyArray<ReadonlyArray<string>>) {
  const {
    table,
    table_row: row,
    table_header: header,
    table_cell: cell,
  } = scientMarkdownSchema.nodes;
  if (!table || !row || !header || !cell || rows.length === 0) return null;
  const body = rows.slice(1);
  const alignments = rows[0]!.map((_, column) =>
    body.length > 0 &&
    body.every(
      (values) => (values[column] ?? "").trim() === "" || NUMBER_CELL.test(values[column]!),
    )
      ? "right"
      : null,
  );
  return table.create(
    null,
    rows.map((values, index) =>
      row.create(
        null,
        values.map((value, column) =>
          (index === 0 ? header : cell).create(
            { alignment: alignments[column] },
            value.trim() === "" ? null : scientMarkdownSchema.text(value.trim()),
          ),
        ),
      ),
    ),
  );
}

/** A table and its caption, `Table: <linked caption>`, as two blocks for one insertion. */
export function resultTableSlice(input: {
  readonly href: string;
  readonly caption: string;
  readonly rows: ReadonlyArray<ReadonlyArray<string>>;
}) {
  const table = resultTableNode(input.rows);
  const paragraph = scientMarkdownSchema.nodes.paragraph;
  const value = resultValueNode(input.href, input.caption || "Table");
  if (table === null || !paragraph || value === null) return null;
  const caption = paragraph.create(null, [scientMarkdownSchema.text("Table: "), value]);
  return new Slice(Fragment.from([table, caption]), 0, 0);
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
