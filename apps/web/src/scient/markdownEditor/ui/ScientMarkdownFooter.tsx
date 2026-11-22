import { msg, useGT, useMessages } from "gt-react";
import { Table as TableIcon } from "lucide-react";
import type { EditorState } from "prosemirror-state";
import { useSyncExternalStore } from "react";

import type { MessageResolver } from "~/i18n/messages";

import { DocumentFooter } from "../../writing/DocumentFooter";
import { WRITING_COMMAND_LABELS } from "../../writing/commandNames";
import { countSelectedWords, tableCaretPosition } from "../../writing/caretStatus";
import { countWords } from "../../writing/documentCounts";
import { DockDivider, DockMenu } from "../../writing/dockChrome";
import type { ScientMarkdownEditorSnapshot, ScientMarkdownEditorView } from "../prosemirror/view";
import { TableActions, TableMenuItems } from "./ScientMarkdownControls";

/** Where the caret is, in the words the bar uses for the same things. */
function markdownCaretPosition(
  snapshot: ScientMarkdownEditorSnapshot,
  state: EditorState | null,
  resolve: MessageResolver,
): string {
  if (snapshot.inTable && state)
    return (
      tableCaretPosition(state, resolve) ??
      resolve(msg("Table", { $context: "caret is in a table" }))
    );
  if (snapshot.blockType === "heading")
    return snapshot.headingLevel === null
      ? resolve(msg("Heading"))
      : resolve(msg("Heading {level}", { level: snapshot.headingLevel }));
  if (snapshot.blockType === "code_block") return resolve(msg("Code block"));
  if (snapshot.listKind === "bullet") return resolve(WRITING_COMMAND_LABELS.bulletList);
  if (snapshot.listKind === "ordered") return resolve(WRITING_COMMAND_LABELS.numberedList);
  if (snapshot.listKind === "task") return resolve(msg("Task list"));
  if (snapshot.blockType === "blockquote") return resolve(WRITING_COMMAND_LABELS.quote);
  return resolve(WRITING_COMMAND_LABELS.text);
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
  const gt = useGT();
  const messages = useMessages();
  const snapshot = useSyncExternalStore(
    controller.subscribe,
    controller.getSnapshot,
    controller.getSnapshot,
  );
  const state = controller.view?.state ?? null;
  const document = state?.doc ?? null;
  const total = document ? countWords(document.textBetween(0, document.content.size, " ", " ")) : 0;
  const selected = state ? countSelectedWords(state) : null;
  return (
    <DocumentFooter
      label={gt("Document status")}
      position={markdownCaretPosition(snapshot, state, messages)}
      words={document ? { total, selected } : null}
    >
      {snapshot.editable && snapshot.inTable ? (
        <>
          <TableActions controller={controller} snapshot={snapshot} />
          <DockDivider />
          <DockMenu
            label={gt("More table actions")}
            icon={<TableIcon className="size-4" />}
            groupLabel={gt("Table", { $context: "table actions menu group" })}
            popupClassName="w-56"
          >
            <TableMenuItems controller={controller} />
          </DockMenu>
        </>
      ) : null}
    </DocumentFooter>
  );
}
