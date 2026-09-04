import { Code2Icon } from "lucide-react";
import { useCallback, type MouseEvent as ReactMouseEvent } from "react";

import { MenuItem } from "~/components/ui/menu";

export type ScientRichFenceContextMenuAction = "copy-source" | "edit-source";

/** Optional authoring capability; ordinary previews intentionally omit it. */
export interface ScientRichFenceAuthoringActions {
  readonly onEditSource: () => void;
  readonly sourceEditorOpen?: boolean;
  readonly showContextMenu?: (position: {
    readonly x: number;
    readonly y: number;
  }) => Promise<ScientRichFenceContextMenuAction | null>;
}

export type ScientRichFenceContextMenuHandler = NonNullable<
  ScientRichFenceAuthoringActions["showContextMenu"]
>;

export function RichFenceSourceMenuItem(props: {
  readonly authoringActions?: ScientRichFenceAuthoringActions | undefined;
  readonly onToggleSource: () => void;
  readonly sourceVisible: boolean;
}) {
  const editSource = props.authoringActions?.onEditSource;
  return (
    <MenuItem onClick={editSource ?? props.onToggleSource}>
      <Code2Icon />
      {editSource ? "Edit source" : props.sourceVisible ? "Hide source" : "Show source"}
    </MenuItem>
  );
}

/** Visible source is also an edit entry point, without taking over visual gestures. */
export function RichFenceSourcePreview(props: {
  readonly authoringActions?: ScientRichFenceAuthoringActions | undefined;
  readonly source: string;
  readonly className: string;
  readonly label: string;
}) {
  if (props.authoringActions?.sourceEditorOpen) return null;
  const edit = props.authoringActions?.onEditSource;
  return (
    <pre
      className={props.className}
      role={edit ? "button" : undefined}
      tabIndex={edit ? 0 : undefined}
      aria-label={edit ? props.label : undefined}
      onClick={edit}
      onKeyDown={
        edit
          ? (event) => {
              if (event.key !== "Enter" && event.key !== " ") return;
              event.preventDefault();
              edit();
            }
          : undefined
      }
    >
      <code>{props.source}</code>
    </pre>
  );
}

function contextMenuPosition(event: ReactMouseEvent<HTMLElement>): {
  readonly x: number;
  readonly y: number;
} {
  if (event.clientX !== 0 || event.clientY !== 0) {
    return { x: event.clientX, y: event.clientY };
  }
  const target = event.target instanceof Element ? event.target : event.currentTarget;
  const rect = target.getBoundingClientRect();
  return {
    x: rect.left + Math.min(rect.width / 2, 24),
    y: rect.top + Math.min(rect.height / 2, 24),
  };
}

/**
 * Right-click/two-finger click is a secondary shortcut. The card keeps its
 * normal pointer behavior until an authoring surface supplies this capability.
 */
export function useRichFenceContextMenu(
  authoringActions: ScientRichFenceAuthoringActions | undefined,
  onCopySource: () => void,
) {
  return useCallback(
    (event: ReactMouseEvent<HTMLElement>) => {
      const show = authoringActions?.showContextMenu;
      if (!show) return;
      event.preventDefault();
      event.stopPropagation();
      void show(contextMenuPosition(event)).then(
        (action) => {
          if (action === "edit-source") authoringActions.onEditSource();
          else if (action === "copy-source") onCopySource();
        },
        () => undefined,
      );
    },
    [authoringActions, onCopySource],
  );
}
