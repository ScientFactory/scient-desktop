import type { Editor } from "@tiptap/core";
import { useEditorState } from "@tiptap/react";
import { closeHistory } from "@tiptap/pm/history";
import { MenuRadioGroup } from "~/components/ui/menu";
import { DockCommandRadioItem, MenuRow } from "../writing/dockChrome";
import { WritingDirectionIcon } from "../writing/WritingDirectionIcon";
import { latexDocumentLanguage } from "./latexLanguage";
import { latexParagraphDirection, setLatexParagraphDirection } from "./latexParagraphDirection";

export function LatexDirectionMenuItems({
  editor,
  disabled,
  setup,
  getSource,
}: {
  editor: Editor | null;
  disabled: boolean;
  setup: string;
  getSource: () => string;
}) {
  const language = latexDocumentLanguage(setup);
  const selected = useEditorState({
    editor,
    selector: ({ editor: owner }) =>
      owner ? latexParagraphDirection(owner.state, language.direction) : null,
  });
  return (
    <MenuRadioGroup value={selected?.value ?? ""}>
      {(["ltr", "rtl"] as const).map((direction) => (
        <DockCommandRadioItem
          key={direction}
          value={direction}
          aria-label={direction === "ltr" ? "Left to right" : "Right to left"}
          disabled={disabled || !editor?.isEditable || !selected}
          onClick={() => {
            if (!editor || disabled || !editor.isEditable) return;
            if (
              setLatexParagraphDirection(
                editor.state,
                (tr) => editor.view.dispatch(tr),
                direction,
                getSource(),
                setup,
              )
            ) {
              editor.view.dispatch(closeHistory(editor.state.tr));
              editor.commands.focus();
            }
          }}
        >
          <MenuRow
            icon={<WritingDirectionIcon direction={direction} />}
            label={direction.toUpperCase()}
          />
        </DockCommandRadioItem>
      ))}
    </MenuRadioGroup>
  );
}
