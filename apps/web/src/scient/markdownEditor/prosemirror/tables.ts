import { DOMSerializer, type Node as ProseMirrorNode } from "prosemirror-model";
import { Plugin, type Command } from "prosemirror-state";
import { CellSelection, findTable, TableMap, TableView } from "prosemirror-tables";
import { Decoration, DecorationSet, type EditorView, type NodeView } from "prosemirror-view";

/** Reuse the normal cell selection so formatting, copying, and table commands agree. */
export const selectMarkdownTable: Command = (state, dispatch) => {
  const table = findTable(state.selection.$from);
  if (!table) return false;
  const map = TableMap.get(table.node);
  const first = map.map[0];
  const last = map.map.at(-1);
  if (first === undefined || last === undefined) return false;
  dispatch?.(
    state.tr.setSelection(CellSelection.create(state.doc, table.start + first, table.start + last)),
  );
  return true;
};

/** Add owned chrome around, not in place of, the upstream table view. */
function markdownTableView(node: ProseMirrorNode, view: EditorView): NodeView {
  const tableView = new TableView(node, 25);
  const dom = document.createElement("div");
  dom.className = "scient-markdown-table";
  const button = document.createElement("button");
  button.type = "button";
  button.contentEditable = "false";
  button.className = "scient-markdown-table-select";
  button.setAttribute("aria-label", "Select whole table");
  button.title = "Select whole table";
  button.append(
    DOMSerializer.renderSpec(document, [
      "http://www.w3.org/2000/svg svg",
      {
        viewBox: "0 0 24 24",
        fill: "none",
        stroke: "currentColor",
        "stroke-width": 1.5,
        "aria-hidden": "true",
      },
      ["rect", { x: 3, y: 3, width: 18, height: 18, rx: 2 }],
      ["path", { d: "M3 9h18M9 3v18" }],
    ]).dom,
  );
  button.addEventListener("mousedown", (event) => {
    if (event.button === 0) event.preventDefault();
  });
  button.addEventListener("click", () => {
    if (!view.editable || !dom.classList.contains("is-active-table")) return;
    selectMarkdownTable(view.state, view.dispatch);
    view.focus();
  });
  dom.append(button, tableView.dom);
  const syncDirection = (current: ProseMirrorNode) => {
    if (current.attrs.dir === "ltr" || current.attrs.dir === "rtl")
      tableView.table.dir = current.attrs.dir;
    else tableView.table.removeAttribute("dir");
  };
  syncDirection(node);
  return {
    dom,
    contentDOM: tableView.contentDOM,
    update(current) {
      if (!tableView.update(current)) return false;
      syncDirection(current);
      return true;
    },
    stopEvent: (event) =>
      event.type !== "contextmenu" &&
      event.target instanceof globalThis.Node &&
      button.contains(event.target),
    ignoreMutation: (record) => button.contains(record.target) || tableView.ignoreMutation(record),
  };
}

/** Keep the editable table model within the GFM representation we publish. */
export function markdownTablePlugin(): Plugin {
  return new Plugin({
    props: {
      nodeViews: { table: markdownTableView },
      decorations(state) {
        const table = findTable(state.selection.$from);
        return table
          ? DecorationSet.create(state.doc, [
              Decoration.node(table.pos, table.pos + table.node.nodeSize, {
                class: "is-active-table",
              }),
            ])
          : DecorationSet.empty;
      },
    },
    filterTransaction(transaction) {
      if (!transaction.docChanged) return true;
      let supported = true;
      transaction.doc.descendants((node) => {
        if (node.type.spec.tableRole === "cell" || node.type.spec.tableRole === "header_cell") {
          if (node.attrs.colspan !== 1 || node.attrs.rowspan !== 1 || node.attrs.colwidth !== null)
            supported = false;
        }
      });
      // This also covers pasted HTML and commands invoked outside the menus.
      // Reject the transaction rather than silently dropping covered cells.
      return supported;
    },
    appendTransaction(transactions, _oldState, state) {
      if (!transactions.some((transaction) => transaction.docChanged)) return null;
      const transaction = state.tr;
      state.doc.descendants((table, tablePos) => {
        if (table.type.spec.tableRole !== "table") return true;
        const alignments: unknown[] = [];
        table.forEach((row) =>
          row.forEach((cell, _offset, column) => {
            alignments[column] ??= cell.attrs.alignment;
          }),
        );
        table.forEach((row, rowOffset, rowIndex) =>
          row.forEach((cell, cellOffset, column) => {
            const type =
              rowIndex === 0 ? state.schema.nodes.table_header! : state.schema.nodes.table_cell!;
            const alignment = alignments[column] ?? null;
            if (cell.type !== type || cell.attrs.alignment !== alignment) {
              transaction.setNodeMarkup(tablePos + 2 + rowOffset + cellOffset, type, {
                ...cell.attrs,
                alignment,
              });
            }
          }),
        );
        return false;
      });
      return transaction.docChanged ? transaction.setMeta("addToHistory", false) : null;
    },
  });
}
