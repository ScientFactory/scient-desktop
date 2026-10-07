import { useContext, useMemo, type RefObject } from "react";
import { createPortal } from "react-dom";
import type { Editor } from "@tiptap/core";
import { dockButtonClass } from "../writing/dockChrome";
import { LatexReferenceLabelField } from "./LatexReferenceLabelField";
import { LatexStatementTypeControl } from "./LatexStatementTypeControl";
import { LatexAuthoringContext } from "./latexObjectAuthoring";
import { latexLabelInventory } from "./latexLabelAuthoring";
import { useLatexObjectContext } from "./useLatexObjectContext";

/** Statement content stays on paper; its type and reference keys belong in the footer. */
export function LatexStatementToolbar(props: {
  editor: Editor;
  root: RefObject<HTMLElement | null>;
  selected: boolean;
  editable: boolean;
  environment: string;
  proof: boolean;
  hasTitle: boolean;
  labels: readonly { id: string; value: string; draftKey: string | undefined }[];
  onType: (environment: string) => void;
  onTitle: () => void;
  onLabel: (id: string, value: string) => void;
}) {
  const { active, bar } = useLatexObjectContext(props.editor, props.root, props.selected);
  const { source, renameLabel } = useContext(LatexAuthoringContext);
  const inventory = useMemo(() => latexLabelInventory(source), [source]);
  const host = props.editor.view.dom
    .closest(".scient-latex-visual-workspace")
    ?.querySelector(".scient-latex-context-tools-slot");
  if (!active || !host || !props.editor.isEditable) return null;
  return createPortal(
    <div
      ref={bar}
      role="toolbar"
      aria-label={props.proof ? "Proof tools" : "Statement tools"}
      data-context-presentation="inline"
      data-context-position={props.environment}
      className="scient-latex-context-toolbar"
      onPointerDown={(event) => event.stopPropagation()}
      onFocusCapture={(event) => event.stopPropagation()}
      onClick={(event) => event.stopPropagation()}
    >
      {!props.proof && (
        <LatexStatementTypeControl
          editor={props.editor}
          environment={props.environment}
          disabled={!props.editable}
          onChange={props.onType}
        />
      )}
      <button
        className={dockButtonClass()}
        type="button"
        disabled={!props.editable}
        aria-label={props.hasTitle ? "Edit statement title" : "Add statement title"}
        onClick={props.onTitle}
      >
        Title
      </button>
      {!props.proof &&
        props.labels.map((label) => (
          <label key={label.id} className="scient-latex-statement-reference">
            Label
            <LatexReferenceLabelField
              label="Statement reference label"
              allowEmpty
              value={label.value}
              draftKey={label.draftKey}
              commitOn="blur"
              disabled={!props.editable}
              isAvailable={(value) =>
                !value ||
                value === label.value ||
                !inventory.targets.some((target) => target.key === value)
              }
              onCommit={(value, fieldId) => {
                if (value === label.value) return;
                if (value && label.value && renameLabel) renameLabel(label.value, value, fieldId);
                else props.onLabel(label.id, value);
              }}
            />
          </label>
        ))}
    </div>,
    host,
  );
}
