import { Plugin } from "prosemirror-state";
import { TableView } from "prosemirror-tables";

/** Keep the editable table model within the GFM representation we publish. */
export function markdownTablePlugin(): Plugin {
  return new Plugin({
    props: { nodeViews: { table: (node) => new TableView(node, 25) } },
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
