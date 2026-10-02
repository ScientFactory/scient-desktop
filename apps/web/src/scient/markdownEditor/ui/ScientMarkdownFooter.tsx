import { Table as TableIcon } from "lucide-react";
import type { EditorState } from "prosemirror-state";
import { useMemo, useSyncExternalStore } from "react";

import { DocumentFooter } from "../../writing/DocumentFooter";
import { WRITING_COMMAND_LABELS } from "../../writing/commandNames";
import { countWords } from "../../writing/documentCounts";
import { DockDivider, DockMenu } from "../../writing/dockChrome";
import type { ScientMarkdownEditorSnapshot, ScientMarkdownEditorView } from "../prosemirror/view";
import { TableActions, TableMenuItems } from "./ScientMarkdownControls";

/** Where the caret is, in the words the bar uses for the same things. */
export function markdownCaretPosition(
  snapshot: ScientMarkdownEditorSnapshot,
  state: EditorState | null,
): string {
  if (snapshot.inTable && state) {
    const { $from } = state.selection;
    for (let depth = $from.depth; depth > 0; depth -= 1) {
      if ($from.node(depth).type.spec.tableRole === "row")
        return `Table · row ${$from.index(depth - 1) + 1}, column ${$from.index(depth) + 1}`;
    }
    return "Table";
  }
  if (snapshot.blockType === "heading")
    return snapshot.headingLevel === null ? "Heading" : `Heading ${snapshot.headingLevel}`;
  if (snapshot.blockType === "code_block") return "Code block";
  if (snapshot.listKind === "bullet") return WRITING_COMMAND_LABELS.bulletList;
  if (snapshot.listKind === "ordered") return WRITING_COMMAND_LABELS.numberedList;
  if (snapshot.listKind === "task") return "Task list";
  if (snapshot.blockType === "blockquote") return WRITING_COMMAND_LABELS.quote;
  return WRITING_COMMAND_LABELS.text;
}

/**
 * The Markdown editor's footer. It follows the shared footer's rules: the
 * selected object's options on the left (today: a table's), where the caret is
 * and the word count on the right.
 */
export function ScientMarkdownFooter({
  controller,
}: {
  readonly controller: ScientMarkdownEditorView;
}) {
  const snapshot = useSyncExternalStore(
    controller.subscribe,
    controller.getSnapshot,
    controller.getSnapshot,
  );
  const state = controller.view?.state ?? null;
  const document = state?.doc ?? null;
  const total = useMemo(
    () => (document ? countWords(document.textBetween(0, document.content.size, " ", " ")) : 0),
    [document],
  );
  const selected =
    state && !state.selection.empty
      ? countWords(state.doc.textBetween(state.selection.from, state.selection.to, " ", " "))
      : null;
  return (
    <DocumentFooter
      label="Document status"
      position={markdownCaretPosition(snapshot, state)}
      words={document ? { total, selected } : null}
    >
      {snapshot.editable && snapshot.inTable ? (
        <>
          <TableActions controller={controller} snapshot={snapshot} />
          <DockDivider />
          <DockMenu
            label="More table actions"
            icon={<TableIcon className="size-4" />}
            groupLabel="Table"
            popupClassName="w-56"
          >
            <TableMenuItems controller={controller} />
          </DockMenu>
        </>
      ) : null}
    </DocumentFooter>
  );
}
