import { useId, useState } from "react";
import { LatexTextField, replaceLatexFieldDraft } from "./LatexTextField";

/** Invalid input remains a field draft; it is never silently reset on blur. */
export function LatexReferenceLabelField(props: {
  id?: string;
  label: string;
  value: string;
  disabled?: boolean;
  allowEmpty?: boolean;
  draftKey?: string | undefined;
  commitOn?: "idle" | "blur";
  isAvailable?: (value: string) => boolean;
  onCommit: (value: string, fieldId?: string) => void;
}) {
  const messageId = useId();
  const [message, setMessage] = useState<string | null>(null);
  const validate = (value: string) =>
    !((props.allowEmpty && value === "") || /^[^{}\\%\s#$&~^]+$/u.test(value))
      ? "Use a label without spaces or LaTeX special characters."
      : !(props.isAvailable?.(value) ?? true)
        ? "This label is already used. Choose another label."
        : null;
  return (
    <div className="scient-latex-reference-label-field">
      <LatexTextField
        id={props.id}
        aria-label={props.label}
        aria-describedby={message ? messageId : undefined}
        aria-invalid={message !== null}
        rows={1}
        placeholder="Add label"
        spellCheck={false}
        disabled={props.disabled}
        value={props.value}
        draftKey={props.draftKey}
        commitOn={props.commitOn ?? "idle"}
        onInput={(event) => setMessage(validate(event.currentTarget.value))}
        onKeyDown={(event) => {
          if (event.key !== "Escape" || event.nativeEvent.isComposing) return;
          event.preventDefault();
          event.stopPropagation();
          replaceLatexFieldDraft(event.currentTarget, props.value);
          setMessage(null);
          event.currentTarget.blur();
        }}
        onValueChange={(value, fieldId) => {
          const error = validate(value);
          setMessage(error);
          if (!error) props.onCommit(value, fieldId);
        }}
      />
      {message && (
        <p id={messageId} role="status">
          {message}
        </p>
      )}
    </div>
  );
}
