import { Code2Icon } from "lucide-react";
import { useCallback, useLayoutEffect, useRef, type MouseEvent as ReactMouseEvent } from "react";

import { MenuItem } from "~/components/ui/menu";

export type ScientRichFenceContextMenuAction = "copy-source" | "edit-source";

/** Optional authoring capability; ordinary previews intentionally omit it. */
export interface ScientRichFenceAuthoringActions {
  readonly onEditSource: () => void;
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

/** The document owns one editor; the card supplies its stable visible source slot. */
export interface ScientRichFenceSourceEditor {
  readonly open: boolean;
  readonly mount: (host: HTMLElement) => () => void;
}

export function RichFenceSourcePreview(props: {
  readonly editor?: ScientRichFenceSourceEditor | undefined;
  readonly visible: boolean;
  readonly source: string;
  readonly className: string;
}) {
  const host = useRef<HTMLDivElement>(null);
  const mount = props.editor?.mount;
  useLayoutEffect(() => {
    if (!props.visible || !mount || !host.current) return;
    return mount(host.current);
  }, [mount, props.visible]);

  return (
    <div
      className={props.className}
      hidden={!props.visible}
      onContextMenu={props.editor ? (event) => event.stopPropagation() : undefined}
    >
      {props.editor ? (
        <div ref={host} />
      ) : (
        <pre className="scient-mermaid-source max-h-72 overflow-auto rounded-md bg-background/70 p-3 text-xs leading-relaxed">
          <code>{props.source}</code>
        </pre>
      )}
    </div>
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
