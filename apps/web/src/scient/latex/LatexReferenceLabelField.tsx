import { useId, useState } from "react";
import { LatexTextField } from "./LatexTextField";

/** Invalid input remains a field draft; it is never silently reset on blur. */
export function LatexReferenceLabelField(props: {
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
        aria-label={props.label}
        aria-describedby={message ? messageId : undefined}
        aria-invalid={message !== null}
        rows={1}
        wrap="off"
        spellCheck={false}
        disabled={props.disabled}
        value={props.value}
        draftKey={props.draftKey}
        commitOn={props.commitOn ?? "idle"}
        onInput={(event) => setMessage(validate(event.currentTarget.value))}
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
