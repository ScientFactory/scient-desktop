import { lift, setBlockType, toggleMark, wrapIn } from "prosemirror-commands";
import type { MarkType, Node as ProseMirrorNode, NodeType } from "prosemirror-model";
import { liftListItem, wrapInList } from "prosemirror-schema-list";
import { redo, undo } from "prosemirror-history";
import type { Command, EditorState, Transaction } from "prosemirror-state";
import {
  addColumnAfter,
  addColumnBefore,
  addRowAfter,
  addRowBefore,
  deleteColumn,
  deleteRow,
  deleteTable,
  mergeCells,
  isInTable,
  selectedRect,
  splitCell,
  toggleHeaderCell,
} from "prosemirror-tables";

import { scientMarkdownSchema } from "./schema";

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
    if (dispatch) dispatch(state.tr.replaceSelectionWith(node).scrollIntoView());
    return true;
  };
}

function createTable(): ProseMirrorNode {
  const rowType = requiredNodeType("table_row");
  const headerType = requiredNodeType("table_header");
  const cellType = requiredNodeType("table_cell");
  const rows = Array.from({ length: 3 }, (_row, rowIndex) =>
    rowType.create(
      null,
      Array.from({ length: 3 }, () => (rowIndex === 0 ? headerType : cellType).create(null)),
    ),
  );
  return requiredNodeType("table").create(null, rows);
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

/** The list kind containing the selection, or null when outside any list. */
export function listKindAt(state: EditorState): ScientMarkdownListKind | null {
  const { $from } = state.selection;
  for (let depth = $from.depth; depth > 0; depth -= 1) {
    const node = $from.node(depth);
    if (node.type.name === "bullet_list") {
      const firstItem = node.firstChild;
      return firstItem?.type.name === "list_item" && firstItem.attrs.taskChecked !== null
        ? "task"
        : "bullet";
    }
    if (node.type.name === "ordered_list") return "ordered";
  }
  return null;
}

function insideNodeOfType(state: EditorState, typeName: string): boolean {
  const { $from } = state.selection;
  for (let depth = $from.depth; depth > 0; depth -= 1) {
    if ($from.node(depth).type.name === typeName) return true;
  }
  return false;
}

/** Toggle a list type: applying it inside its own list lifts the items out. */
function toggleMarkdownList(kind: ScientMarkdownListKind): Command {
  return (state, dispatch) => {
    if (listKindAt(state) === kind) {
      return liftListItem(requiredNodeType("list_item"))(state, dispatch);
    }
    // Match the tight "-" convention of hand-written Markdown lists.
    const listAttrs = { tight: true, bullet: "-" };
    if (kind !== "task") {
      const listType = requiredNodeType(kind === "ordered" ? "ordered_list" : "bullet_list");
      return wrapInList(listType, listAttrs)(state, dispatch);
    }
    // Task list: wrap in a bullet list and mark the wrapped items checked in
    // one transaction, so Enter-continuation inherits the checkbox.
    let wrapped: Transaction | null = null;
    const ok = wrapInList(requiredNodeType("bullet_list"), listAttrs)(state, (transaction) => {
      wrapped = transaction;
    });
    if (!ok || wrapped === null) return false;
    if (dispatch && wrapped) {
      const transaction: Transaction = wrapped;
      const { from, to } = transaction.selection;
      transaction.doc.nodesBetween(from, to, (node, pos) => {
        if (node.type.name === "list_item" && node.attrs.taskChecked === null) {
          transaction.setNodeMarkup(pos, undefined, { ...node.attrs, taskChecked: true });
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

/** Toggle a blockquote: applying it inside a quote lifts the block out. */
function toggleMarkdownBlockquote(): Command {
  return (state, dispatch) => {
    if (insideNodeOfType(state, "blockquote")) {
      return lift(state, dispatch);
    }
    return wrapIn(requiredNodeType("blockquote"))(state, dispatch);
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

/** Set the text direction of every paragraph/heading in the selection (null = auto). */
function setMarkdownTextDirection(direction: "ltr" | "rtl" | null): Command {
  return (state, dispatch) => {
    const { from, to } = state.selection;
    let transaction: Transaction | null = null;
    state.doc.nodesBetween(from, to, (node, pos) => {
      if (
        (node.type.name === "paragraph" || node.type.name === "heading") &&
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
    case "paragraph":
      return setBlockType(requiredNodeType("paragraph"));
    case "heading-1":
    case "heading-2":
    case "heading-3":
    case "heading-4":
    case "heading-5":
    case "heading-6":
      return setBlockType(requiredNodeType("heading"), {
        level: Number(command.at(-1)),
      });
    case "clear-formatting":
      return clearMarkdownFormatting();
    case "hard-break":
      return insertNode(requiredNodeType("hard_break").create());
    case "direction-auto":
      return setMarkdownTextDirection(null);
    case "direction-ltr":
      return setMarkdownTextDirection("ltr");
    case "direction-rtl":
      return setMarkdownTextDirection("rtl");
    case "blockquote":
      return toggleMarkdownBlockquote();
    case "bullet-list":
      return toggleMarkdownList("bullet");
    case "task-list":
      return toggleMarkdownList("task");
    case "ordered-list":
      return toggleMarkdownList("ordered");
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
    case "wiki-link":
      return insertNode(requiredNodeType("wiki_link").create({ target: "Untitled", label: null }));
    case "table":
      return insertNode(createTable());
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
      return mergeCells;
    case "split-cell":
      return splitCell;
    case "toggle-header-cell":
      return toggleHeaderCell;
  }
}

function selectedListItem(
  state: EditorState,
): { readonly node: ProseMirrorNode; readonly pos: number } | null {
  const listItem = requiredNodeType("list_item");
  for (let depth = state.selection.$from.depth; depth > 0; depth -= 1) {
    const node = state.selection.$from.node(depth);
    if (node.type === listItem) return { node, pos: state.selection.$from.before(depth) };
  }
  return null;
}

export function setSelectedTaskState(
  state: EditorState,
  dispatch: ((transaction: Transaction) => void) | undefined,
  checked: boolean,
): boolean {
  const selected = selectedListItem(state);
  if (!selected) return false;
  if (dispatch) {
    dispatch(
      state.tr.setNodeMarkup(selected.pos, undefined, {
        ...selected.node.attrs,
        taskChecked: checked,
      }),
    );
  }
  return true;
}

export function runScientMarkdownCommand(
  command: ScientMarkdownCommand,
  state: EditorState,
  dispatch?: (transaction: Transaction) => void,
): boolean {
  return commandFor(command)(state, dispatch);
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
