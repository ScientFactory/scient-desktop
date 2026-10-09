import type { Editor } from "@tiptap/core";
import { useEditorState } from "@tiptap/react";
import { LatexReferenceLabelPopover } from "./LatexReferenceLabelPopover";
import { useContext, useMemo } from "react";
import { LatexAuthoringContext } from "./latexObjectAuthoring";
import { latexLabelInventory } from "./latexLabelAuthoring";

export function LatexHeadingToolbar({
  editor,
  draftKey,
  onRename,
}: {
  editor: Editor;
  draftKey: string;
  onRename: (before: string, after: string, fieldId?: string) => boolean;
}) {
  const { source } = useContext(LatexAuthoringContext);
  const labels = useMemo(() => latexLabelInventory(source), [source]);
  const heading = useEditorState({
    editor,
    selector: ({ editor: current }) => {
      const { $from } = current.state.selection;
      const position = $from.depth > 0 ? $from.before() : $from.pos;
      const node = current.state.doc.nodeAt(position);
      return node?.type.name === "heading"
        ? {
            position,
            sourceId: String(node.attrs.sourceId ?? position),
            referenceLabel: String(node.attrs.referenceLabel ?? ""),
          }
        : null;
    },
  });
  if (!heading) return null;
  const updateHeading = (attributes: Record<string, unknown>) => {
    const node = editor.state.doc.nodeAt(heading.position);
    if (node?.type.name !== "heading") return;
    editor.view.dispatch(
      editor.state.tr.setNodeMarkup(heading.position, undefined, {
        ...node.attrs,
        ...attributes,
      }),
    );
  };
  return (
    <div
      role="toolbar"
      aria-label="Heading options"
      data-context-fallback=""
      data-context-presentation="inline"
      className="scient-latex-context-toolbar scient-latex-heading-bar"
    >
      <LatexReferenceLabelPopover
        key={heading.sourceId}
        label="Heading reference label"
        allowEmpty
        disabled={!editor.isEditable}
        draftKey={`${draftKey}:heading:${heading.sourceId}:label`}
        value={heading.referenceLabel}
        commitOn="blur"
        isAvailable={(value) =>
          !value ||
          value === heading.referenceLabel ||
          !labels.targets.some((target) => target.key === value)
        }
        onCommit={(referenceLabel, fieldId) => {
          if (referenceLabel === heading.referenceLabel) return;
          if (heading.referenceLabel && referenceLabel) {
            onRename(heading.referenceLabel, referenceLabel, fieldId);
          } else updateHeading({ referenceLabel: referenceLabel || null });
        }}
      />
    </div>
  );
}
