import { useLayoutEffect, useRef, useState } from "react";
import type { Editor } from "@tiptap/core";
import { LatexTextField, restoredLatexFieldDraft } from "./LatexTextField";
import { LatexProsePreview } from "./LatexProsePreview";
import { latexProseCaretOffset } from "./latexProseCaret";

/** Optional object titles activate in the footer and edit at their printed location. */
export function LatexStatementTitle(props: {
  editor: Editor;
  value: string;
  source: string;
  editing: boolean;
  editable: boolean;
  draftKey: string | undefined;
  label?: string;
  onEditing: (editing: boolean) => void;
  onChange: (title: string) => void;
  onExit: () => void;
}) {
  const root = useRef<HTMLSpanElement>(null);
  const clickedOffset = useRef<number | null>(null);
  const [measuredTitle, setMeasuredTitle] = useState<string | null>(null);
  const editingText = props.editing
    ? (measuredTitle ?? restoredLatexFieldDraft(props.draftKey, props.value))
    : props.value;
  useLayoutEffect(() => {
    if (!props.editing) return;
    const field = root.current?.querySelector("textarea");
    if (!field) return;
    field.focus({ preventScroll: true });
    const offset = Math.min(clickedOffset.current ?? 0, field.value.length);
    field.setSelectionRange(offset, offset);
    clickedOffset.current = null;
  }, [props.editing]);
  return (
    <span
      ref={root}
      className="scient-latex-statement-title"
      data-empty={(props.editing && editingText.trim() === "") || undefined}
      onClick={(event) => {
        event.stopPropagation();
        if (!props.editable || props.editing) return;
        const preview = root.current?.querySelector<HTMLElement>(
          ".scient-latex-statement-title-text",
        );
        clickedOffset.current = preview
          ? latexProseCaretOffset(preview, event.clientX, event.clientY)
          : 0;
        props.onEditing(true);
      }}
    >
      <span className="scient-latex-statement-title-text" aria-hidden={props.editing || undefined}>
        {props.editing ? (
          editingText || "\u200b"
        ) : (
          <LatexProsePreview source={props.source} editor={props.editor} />
        )}
      </span>
      {props.editing && (
        <LatexTextField
          aria-label={props.label ?? "Scientific statement title"}
          rows={1}
          value={props.value}
          draftKey={props.draftKey}
          disabled={!props.editable}
          onValueChange={props.onChange}
          onInput={(event) => setMeasuredTitle(event.currentTarget.value)}
          onBlur={(event) => {
            // Returning to the app should resume the same field and caret.
            if (!event.relatedTarget && !event.currentTarget.ownerDocument.hasFocus()) return;
            setMeasuredTitle(null);
            props.onEditing(false);
          }}
          onRemoveEmpty={() => {
            props.onChange("");
            setMeasuredTitle(null);
            props.onEditing(false);
            props.onExit();
          }}
          onKeyDown={(event) => {
            if (
              !event.nativeEvent.isComposing &&
              (event.key === "Escape" || (event.key === "Enter" && !event.shiftKey))
            ) {
              event.preventDefault();
              event.stopPropagation();
              event.currentTarget.blur();
              props.onExit();
            }
          }}
        />
      )}
    </span>
  );
}
