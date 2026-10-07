import { useRef } from "react";
import { LatexMathField, type LatexMathFieldHandle } from "./LatexMathField";
import { latexTableMathCell } from "./latexVisualDocument";

/** Math inside a source-owned object uses the same field, drafts and document history. */
export function LatexObjectMathField(props: {
  value: string;
  label: string;
  disabled: boolean;
  draftKey?: string | undefined;
  cell?: string;
  onChange: (value: string) => boolean;
  onFocus: () => void;
  onExit: (direction: -1 | 1) => void;
  onTab?: (direction: -1 | 1) => void;
  onUndo: (redo: boolean) => boolean;
}) {
  const math = latexTableMathCell(props.value);
  const field = useRef<LatexMathFieldHandle>(null);
  if (!math) return null;
  return (
    <span
      className="scient-latex-object-math"
      data-table-cell={props.cell}
      tabIndex={-1}
      aria-label={props.label}
      onFocus={(event) => {
        if (event.target === event.currentTarget) field.current?.focus();
      }}
      onKeyDownCapture={(event) => {
        if (event.key !== "Tab" || event.nativeEvent.isComposing) return;
        event.preventDefault();
        event.stopPropagation();
        if (field.current?.flush()) (props.onTab ?? props.onExit)(event.shiftKey ? -1 : 1);
      }}
    >
      <LatexMathField
        ref={field}
        value={math.tex}
        {...(props.draftKey ? { draftKey: props.draftKey } : {})}
        disabled={props.disabled}
        display={false}
        onChange={(tex) => ({
          accepted: props.onChange(tex ? math.opening + tex + math.closing : ""),
          value: tex,
        })}
        onFocus={props.onFocus}
        onExit={props.onExit}
        onUndo={props.onUndo}
        onRemoveEmpty={(direction) => {
          if (!props.onChange("")) return false;
          props.onExit(direction);
          return true;
        }}
        onExtendOutside={() => false}
        onShortcut={() => false}
        onShortcutHint={() => {}}
        formatCopiedMath={(tex) => math.opening + tex + math.closing}
        parsePastedMath={(source) => latexTableMathCell(source.trim())?.tex ?? null}
      />
    </span>
  );
}
