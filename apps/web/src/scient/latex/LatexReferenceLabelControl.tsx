import { useId, type ComponentProps } from "react";
import { LatexReferenceLabelField } from "./LatexReferenceLabelField";
import { T } from "gt-react";

/** Reference keys stay visible; the field gains a border only while editing. */
export function LatexReferenceLabelControl({
  onEdit,
  ...props
}: ComponentProps<typeof LatexReferenceLabelField> & { onEdit?: () => void }) {
  const id = useId();
  return (
    <div
      className="scient-latex-reference-label-control"
      data-dock-command-scope="latex"
      data-keybinding-capture=""
      onFocus={onEdit}
    >
      <label htmlFor={id}>
        <T context="reference label field">Label</T>
      </label>
      <LatexReferenceLabelField {...props} id={id} />
    </div>
  );
}
