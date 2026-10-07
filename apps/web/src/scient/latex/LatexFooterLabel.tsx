import { useContext, useMemo } from "react";
import { LatexReferenceLabelField } from "./LatexReferenceLabelField";
import { LatexAuthoringContext } from "./latexObjectAuthoring";
import { latexLabelInventory } from "./latexLabelAuthoring";

export function LatexFooterLabel(props: {
  value: string;
  disabled?: boolean;
  draftKey?: string | undefined;
  label?: string;
  rename?: boolean;
  allowEmpty?: boolean;
  onCommit: (value: string) => void;
}) {
  const { source, renameLabel } = useContext(LatexAuthoringContext);
  const inventory = useMemo(() => latexLabelInventory(source), [source]);
  return (
    <label className="scient-latex-statement-reference">
      Label
      <LatexReferenceLabelField
        label={props.label ?? "Reference label"}
        allowEmpty={props.allowEmpty ?? true}
        value={props.value}
        draftKey={props.draftKey}
        disabled={props.disabled ?? false}
        commitOn="blur"
        isAvailable={(value) =>
          !value ||
          value === props.value ||
          !inventory.targets.some((target) => target.key === value)
        }
        onCommit={(value, fieldId) => {
          if (value === props.value) return;
          if (value && props.value && props.rename !== false && renameLabel)
            renameLabel(props.value, value, fieldId);
          else props.onCommit(value);
        }}
      />
    </label>
  );
}
