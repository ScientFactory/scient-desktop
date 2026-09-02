import {
  chainCommands,
  exitCode,
  lift,
  setBlockType,
  toggleMark,
  wrapIn,
} from "prosemirror-commands";
import type { Attrs, MarkType, Node as ProseMirrorNode, NodeType } from "prosemirror-model";
import { liftListItem, wrapInList } from "prosemirror-schema-list";
import { closeHistory, redo, undo } from "prosemirror-history";
import {
  NodeSelection,
  Selection,
  TextSelection,
  type Command,
  type EditorState,
  type Transaction,
} from "prosemirror-state";
import {
  addColumnAfter,
  addColumnBefore,
  addRowAfter,
  addRowBefore,
  deleteColumn,
  deleteRow,
  deleteTable,
  isInTable,
  selectedRect,
} from "prosemirror-tables";

import { scientMarkdownSchema } from "./schema";
import { selectMarkdownTable } from "./tables";
import { nextScientMarkdownFootnoteLabel } from "../footnotes";

export type ScientMarkdownCommand =
  | "add-column-after"
  | "add-column-before"
  | "add-row-after"
  | "add-row-before"
  | "align-column-center"
  | "align-column-default"
  | "align-column-left"
  | "align-column-right"
  | "blockquote"
  | "bold"
  | "bullet-list"
  | "code-block"
  | "delete-column"
  | "delete-row"
  | "delete-table"
  | "direction-auto"
  | "direction-ltr"
  | "direction-rtl"
  | "display-math"
  | "footnote"
  | "clear-formatting"
  | "hard-break"
  | "heading-1"
  | "heading-2"
  | "heading-3"
  | "heading-4"
  | "heading-5"
  | "heading-6"
  | "horizontal-rule"
  | "image"
  | "inline-code"
  | "italic"
  | "list-none"
  | "merge-cells"
  | "ordered-list"
  | "paragraph"
  | "redo"
  | "select-table"
  | "split-cell"
  | "strike"
  | "table"
  | "task-list"
  | "toggle-header-cell"
  | "undo"
  | "wiki-link";

export interface ScientSlashCommandItem {
  readonly command: ScientMarkdownCommand;
  readonly keywords: string;
  readonly label: string;
}

export interface ScientMarkdownTableDimensions {
  readonly columns: number;
  readonly rows: number;
}

export const DEFAULT_SCIENT_MARKDOWN_TABLE_DIMENSIONS = {
  columns: 3,
  rows: 3,
} as const satisfies ScientMarkdownTableDimensions;

export const MAX_SCIENT_MARKDOWN_TABLE_INSERT_DIMENSION = 15;

export const SCIENT_MARKDOWN_SLASH_COMMANDS: ReadonlyArray<ScientSlashCommandItem> = [
  { command: "paragraph", label: "Text", keywords: "paragraph body" },
  { command: "heading-1", label: "Heading 1", keywords: "title h1" },
  { command: "heading-2", label: "Heading 2", keywords: "section h2" },
  { command: "heading-3", label: "Heading 3", keywords: "subsection h3" },
  { command: "bullet-list", label: "Bulleted list", keywords: "unordered bullets" },
  { command: "ordered-list", label: "Numbered list", keywords: "ordered numbers" },
  { command: "task-list", label: "Task list", keywords: "todo checkbox check" },
  { command: "blockquote", label: "Quote", keywords: "blockquote citation" },
  { command: "code-block", label: "Code block", keywords: "fence programming" },
  { command: "display-math", label: "Equation", keywords: "math tex latex formula" },
  { command: "footnote", label: "Footnote", keywords: "note reference source" },
  { command: "table", label: "Table", keywords: "grid cells data" },
  { command: "image", label: "Image", keywords: "figure photo asset media" },
  { command: "wiki-link", label: "Wiki link", keywords: "note internal link" },
  { command: "horizontal-rule", label: "Divider", keywords: "rule separator" },
];

function requiredNodeType(name: string): NodeType {
  const type = scientMarkdownSchema.nodes[name];
  if (!type) throw new Error(`Scient Markdown schema is missing '${name}'.`);
  return type;
}

function requiredMarkType(name: string): MarkType {
  const type = scientMarkdownSchema.marks[name];
  if (!type) throw new Error(`Scient Markdown schema is missing '${name}'.`);
  return type;
}

function insertNode(node: ProseMirrorNode): Command {
  return (state, dispatch) => {
    // A block cannot be represented inside an inline-only GFM table cell.
    // Refuse the command instead of letting replaceSelectionWith split the
    // table and move the block outside it.
    if (node.isBlock && isInTable(state)) return false;
    if (dispatch) dispatch(state.tr.replaceSelectionWith(node).scrollIntoView());
    return true;
  };
}

function insertFootnote(): Command {
  return (state, dispatch) => {
    const { selection } = state;
    if (!selection.$to.parent.inlineContent) return false;

    const label = nextScientMarkdownFootnoteLabel(state.doc);
    const reference = requiredNodeType("footnote_reference").create({ label });
    const definition = requiredNodeType("footnote_definition").create({
      label,
      source: `[^${label}]: `,
    });
    if (!reference || !definition) return false;

    if (dispatch) {
      let transaction = state.tr.setSelection(TextSelection.create(state.doc, selection.to));
      transaction = transaction.replaceSelectionWith(reference);
      const definitionPosition = transaction.doc.content.size;
      transaction = transaction
        .insert(definitionPosition, definition)
        .setSelection(NodeSelection.create(transaction.doc, definitionPosition))
        .scrollIntoView();
      dispatch(transaction);
    }
    return true;
  };
}

const insertMarkdownHardBreak = chainCommands(
  exitCode,
  insertNode(requiredNodeType("hard_break").create()),
);

function validTableInsertDimension(value: number): boolean {
  return (
    Number.isInteger(value) && value >= 1 && value <= MAX_SCIENT_MARKDOWN_TABLE_INSERT_DIMENSION
  );
}

function createTable(dimensions: ScientMarkdownTableDimensions): ProseMirrorNode | null {
  if (
    !validTableInsertDimension(dimensions.rows) ||
    !validTableInsertDimension(dimensions.columns)
  ) {
    return null;
  }
  const rowType = requiredNodeType("table_row");
  const headerType = requiredNodeType("table_header");
  const cellType = requiredNodeType("table_cell");
  const rows = Array.from({ length: dimensions.rows }, (_row, rowIndex) =>
    rowType.create(
      null,
      Array.from({ length: dimensions.columns }, () =>
        (rowIndex === 0 ? headerType : cellType).create(null),
      ),
    ),
  );
  return requiredNodeType("table").create(null, rows);
}

function insertTable(dimensions: ScientMarkdownTableDimensions): Command {
  return (state, dispatch) => {
    const table = createTable(dimensions);
    return table ? insertNode(table)(state, dispatch) : false;
  };
}

function setSelectedTableColumnAlignment(alignment: string | null): Command {
  return (state, dispatch) => {
    if (!isInTable(state)) return false;
    if (!dispatch) return true;

    const rect = selectedRect(state);
    const cellOffsets = new Set<number>();
    for (let row = 0; row < rect.map.height; row += 1) {
      for (let column = rect.left; column < rect.right; column += 1) {
        const offset = rect.map.map[row * rect.map.width + column];
        if (offset !== undefined) cellOffsets.add(offset);
      }
    }

    let transaction = state.tr;
    for (const offset of cellOffsets) {
      const cell = rect.table.nodeAt(offset);
      if (!cell || cell.attrs.alignment === alignment) continue;
      transaction = transaction.setNodeMarkup(rect.tableStart + offset, undefined, {
        ...cell.attrs,
        alignment,
      });
    }
    if (transaction.docChanged) dispatch(transaction);
    return true;
  };
}

export type ScientMarkdownListKind = "bullet" | "ordered" | "task";

interface SelectedList {
  readonly kind: ScientMarkdownListKind;
  readonly node: ProseMirrorNode;
  readonly position: number;
}

function selectedList(state: EditorState): SelectedList | null {
  const { $from, $to } = state.selection;
  for (let depth = $from.depth; depth > 0; depth -= 1) {
    const node = $from.node(depth);
    if (node.type.name !== "bullet_list" && node.type.name !== "ordered_list") continue;
    if ($to.depth < depth || $to.node(depth) !== node) return null;
    const firstItem = node.firstChild;
    return {
      kind:
        node.type.name === "ordered_list"
          ? "ordered"
          : firstItem?.type.name === "list_item" && firstItem.attrs.taskChecked !== null
            ? "task"
            : "bullet",
      node,
      position: $from.before(depth),
    };
  }
  return null;
}

/** The list kind containing the selection, or null when outside any list. */
export function listKindAt(state: EditorState): ScientMarkdownListKind | null {
  return selectedList(state)?.kind ?? null;
}

function insideNodeOfType(state: EditorState, typeName: string): boolean {
  const { $from } = state.selection;
  for (let depth = $from.depth; depth > 0; depth -= 1) {
    if ($from.node(depth).type.name === typeName) return true;
  }
  return false;
}

function listAttrs(type: NodeType, source: ProseMirrorNode): Attrs {
  const attrs: Record<string, unknown> = {};
  for (const name of Object.keys(type.spec.attrs ?? {})) {
    if (Object.hasOwn(source.attrs, name)) attrs[name] = source.attrs[name];
  }
  if (type.name === "ordered_list") attrs.order = 1;
  else attrs.bullet = "-";
  attrs.tight = true;
  return attrs;
}

function normalizeDirectListItems(
  transaction: Transaction,
  listPosition: number,
  list: ProseMirrorNode,
  kind: ScientMarkdownListKind,
): void {
  let position = listPosition + 1;
  list.forEach((item) => {
    const current = item.attrs.taskChecked;
    const taskChecked = kind === "task" ? (typeof current === "boolean" ? current : false) : null;
    if (item.type.name === "list_item" && current !== taskChecked) {
      transaction.setNodeMarkup(position, undefined, { ...item.attrs, taskChecked });
    }
    position += item.nodeSize;
  });
}

/** Set the selected list kind; `list-none` is the explicit way to remove it. */
function setMarkdownList(kind: ScientMarkdownListKind): Command {
  return (state, dispatch) => {
    const current = selectedList(state);
    if (current) {
      const type = requiredNodeType(kind === "ordered" ? "ordered_list" : "bullet_list");
      let transaction = state.tr;
      if (current.node.type !== type) {
        transaction = transaction.setNodeMarkup(
          current.position,
          type,
          listAttrs(type, current.node),
        );
      }
      normalizeDirectListItems(transaction, current.position, current.node, kind);
      if (dispatch && transaction.docChanged) dispatch(transaction.scrollIntoView());
      return true;
    }
    // Match the tight "-" convention of hand-written Markdown lists.
    const wrapAttrs = { tight: true, bullet: "-" };
    if (kind !== "task") {
      const listType = requiredNodeType(kind === "ordered" ? "ordered_list" : "bullet_list");
      return wrapInList(listType, wrapAttrs)(state, dispatch);
    }
    // Task list: wrap in a bullet list and mark the wrapped items incomplete in
    // one transaction, so Enter-continuation inherits the checkbox.
    let wrapped: Transaction | null = null;
    const ok = wrapInList(requiredNodeType("bullet_list"), wrapAttrs)(state, (transaction) => {
      wrapped = transaction;
    });
    if (!ok || wrapped === null) return false;
    if (dispatch && wrapped) {
      const transaction: Transaction = wrapped;
      const { from, to } = transaction.selection;
      transaction.doc.nodesBetween(from, to, (node, pos) => {
        if (node.type.name === "list_item" && node.attrs.taskChecked === null) {
          transaction.setNodeMarkup(pos, undefined, { ...node.attrs, taskChecked: false });
        }
        return true;
      });
      dispatch(transaction);
    }
    return true;
  };
}

/** Remove the list around the selection when one is present. */
function removeMarkdownList(): Command {
  return (state, dispatch) => {
    if (listKindAt(state) === null) return false;
    return liftListItem(requiredNodeType("list_item"))(state, dispatch);
  };
}

/**
 * Run structural commands as one editor transaction. Each command sees the
 * document and mapped selection produced by the previous command, while the
 * user still gets one undo step and one selection update.
 */
function sequenceMarkdownCommands(commands: readonly Command[]): Command {
  return (state, dispatch) => {
    let currentState = state;
    const transactions: Transaction[] = [];
    let handled = false;

    for (const command of commands) {
      let nextTransaction: Transaction | null = null;
      const commandHandled = command(currentState, (transaction) => {
        nextTransaction = transaction;
      });
      if (!commandHandled) continue;
      handled = true;
      if (nextTransaction === null) continue;
      transactions.push(nextTransaction);
      currentState = currentState.apply(nextTransaction);
    }

    if (!handled) return false;
    if (dispatch && transactions.length > 0) {
      const combined = state.tr;
      for (const transaction of transactions) {
        for (const step of transaction.steps) combined.step(step);
      }
      combined.setSelection(Selection.fromJSON(combined.doc, currentState.selection.toJSON()));
      combined.setStoredMarks(currentState.storedMarks);
      dispatch(combined.scrollIntoView());
    }
    return true;
  };
}

/** Set all selected text blocks while retaining attributes shared by the new type. */
function setMarkdownTextBlock(type: NodeType, attrs: Attrs = {}): Command {
  return (state, dispatch) => {
    const { from, to } = state.selection;
    const transaction = state.tr.setBlockType(from, to, type, (node) => {
      const retained: Record<string, unknown> = {};
      for (const name of Object.keys(type.spec.attrs ?? {})) {
        if (Object.hasOwn(node.attrs, name)) retained[name] = node.attrs[name];
      }
      return { ...retained, ...attrs };
    });
    if (dispatch && transaction.docChanged) dispatch(transaction);
    if (!transaction.docChanged) {
      const parent = state.selection.$from.parent;
      if (
        parent.type !== type ||
        Object.entries(attrs).some(([name, value]) => parent.attrs[name] !== value)
      ) {
        return false;
      }
    }
    // A style setter is still handled when the selected blocks already have
    // that style; callers should restore focus and let the user keep typing.
    return true;
  };
}

/**
 * Apply one explicit block style. The Style menu is a radio group, so these
 * commands set a style rather than toggling it. Paragraphs and headings leave
 * a surrounding quote before changing type; Quote normalizes the selected
 * text blocks to paragraphs and wraps them only when needed.
 */
function setMarkdownBlockStyle(
  style: "paragraph" | "blockquote" | { readonly headingLevel: number },
): Command {
  return (state, dispatch) => {
    const inBlockquote = insideNodeOfType(state, "blockquote");
    const commands: Command[] = [];

    if (style !== "blockquote" && inBlockquote) commands.push(lift);

    if (typeof style === "object") {
      commands.push(
        setMarkdownTextBlock(requiredNodeType("heading"), { level: style.headingLevel }),
      );
    } else {
      commands.push(setMarkdownTextBlock(requiredNodeType("paragraph")));
    }

    if (style === "blockquote" && !inBlockquote) {
      commands.push(wrapIn(requiredNodeType("blockquote")));
    }

    return sequenceMarkdownCommands(commands)(state, dispatch);
  };
}

/** Strip every character mark in the selection (or stored marks at the caret). */
function clearMarkdownFormatting(): Command {
  return (state, dispatch) => {
    if (!dispatch) return true;
    const { from, to, empty } = state.selection;
    if (empty) {
      dispatch(state.tr.setStoredMarks([]));
      return true;
    }
    let transaction = state.tr;
    for (const markType of Object.values(state.schema.marks)) {
      transaction = transaction.removeMark(from, to, markType);
    }
    if (transaction.docChanged || transaction.storedMarks !== state.storedMarks) {
      dispatch(transaction);
    }
    return true;
  };
}

/** Set block direction across the selection; a table is one directional block. */
function setMarkdownTextDirection(direction: "ltr" | "rtl" | null): Command {
  return (state, dispatch) => {
    const { from, to } = state.selection;
    let transaction: Transaction | null = null;
    state.doc.nodesBetween(from, to, (node, pos) => {
      if (
        (node.type.name === "paragraph" ||
          node.type.name === "heading" ||
          node.type.name === "table") &&
        node.attrs.dir !== direction
      ) {
        transaction = (transaction ?? state.tr).setNodeMarkup(pos, undefined, {
          ...node.attrs,
          dir: direction,
        });
        return false;
      }
      return true;
    });
    if (transaction && dispatch) dispatch(transaction);
    return true;
  };
}

function commandFor(command: ScientMarkdownCommand): Command {
  switch (command) {
    case "bold":
      return toggleMark(requiredMarkType("strong"));
    case "italic":
      return toggleMark(requiredMarkType("em"));
    case "strike":
      return toggleMark(requiredMarkType("strike"));
    case "inline-code":
      return toggleMark(requiredMarkType("code"));
    case "undo":
      return undo;
    case "redo":
      return redo;
    case "select-table":
      return selectMarkdownTable;
    case "paragraph":
      return setMarkdownBlockStyle("paragraph");
    case "heading-1":
    case "heading-2":
    case "heading-3":
    case "heading-4":
    case "heading-5":
    case "heading-6":
      return setMarkdownBlockStyle({ headingLevel: Number(command.at(-1)) });
    case "clear-formatting":
      return clearMarkdownFormatting();
    case "hard-break":
      return insertMarkdownHardBreak;
    case "direction-auto":
      return setMarkdownTextDirection(null);
    case "direction-ltr":
      return setMarkdownTextDirection("ltr");
    case "direction-rtl":
      return setMarkdownTextDirection("rtl");
    case "blockquote":
      return setMarkdownBlockStyle("blockquote");
    case "bullet-list":
      return setMarkdownList("bullet");
    case "task-list":
      return setMarkdownList("task");
    case "ordered-list":
      return setMarkdownList("ordered");
    case "list-none":
      return removeMarkdownList();
    case "code-block":
      return setBlockType(requiredNodeType("code_block"), { params: "" });
    case "horizontal-rule":
      return insertNode(requiredNodeType("horizontal_rule").create());
    case "image":
      return insertNode(requiredNodeType("image").create({ alt: "", src: "", title: null }));
    case "display-math":
      return insertNode(requiredNodeType("display_math").create({ tex: "", delimiter: "$$" }));
    case "footnote":
      return insertFootnote();
    case "wiki-link":
      return insertNode(requiredNodeType("wiki_link").create({ target: "Untitled", label: null }));
    case "table":
      return insertTable(DEFAULT_SCIENT_MARKDOWN_TABLE_DIMENSIONS);
    case "align-column-default":
      return setSelectedTableColumnAlignment(null);
    case "align-column-left":
      return setSelectedTableColumnAlignment("left");
    case "align-column-center":
      return setSelectedTableColumnAlignment("center");
    case "align-column-right":
      return setSelectedTableColumnAlignment("right");
    case "add-column-after":
      return addColumnAfter;
    case "add-column-before":
      return addColumnBefore;
    case "add-row-after":
      return addRowAfter;
    case "add-row-before":
      return addRowBefore;
    case "delete-column":
      return deleteColumn;
    case "delete-row":
      return deleteRow;
    case "delete-table":
      return deleteTable;
    case "merge-cells":
    case "split-cell":
    case "toggle-header-cell":
      // GFM cannot encode spans or arbitrary header cells. Keep the command
      // boundary honest as well as the menu, including keyboard/API callers.
      return () => false;
  }
}

function runExplicitScientMarkdownCommand(
  command: Command,
  state: EditorState,
  dispatch?: (transaction: Transaction) => void,
  separateHistory = true,
): boolean {
  return command(
    state,
    dispatch &&
      ((transaction) => {
        dispatch(
          transaction.docChanged && separateHistory ? closeHistory(transaction) : transaction,
        );
      }),
  );
}

export function runScientMarkdownCommand(
  command: ScientMarkdownCommand,
  state: EditorState,
  dispatch?: (transaction: Transaction) => void,
): boolean {
  return runExplicitScientMarkdownCommand(
    commandFor(command),
    state,
    dispatch,
    command !== "undo" && command !== "redo",
  );
}

/** Insert one bounded GFM table through the same transaction/history path as dock commands. */
export function runScientMarkdownTableInsert(
  dimensions: ScientMarkdownTableDimensions,
  state: EditorState,
  dispatch?: (transaction: Transaction) => void,
): boolean {
  return runExplicitScientMarkdownCommand(insertTable(dimensions), state, dispatch);
}

export function filterScientMarkdownSlashCommands(
  query: string,
): ReadonlyArray<ScientSlashCommandItem> {
  const normalized = query.trim().toLocaleLowerCase();
  if (normalized.length === 0) return SCIENT_MARKDOWN_SLASH_COMMANDS;
  return SCIENT_MARKDOWN_SLASH_COMMANDS.filter((item) =>
    `${item.label} ${item.keywords}`.toLocaleLowerCase().includes(normalized),
  );
}
