import { useEffect, useLayoutEffect, useRef, useState } from "react";

import { Button } from "~/components/ui/button";
import {
  assistantCitationSourceRects,
  type AssistantCitationSourceAnchor,
} from "~/lib/assistantTextSelection";
import { isSelectionRectVisible, observeSelectionActions } from "~/lib/selectionActions";

interface CaretQuote<T> {
  readonly citation: T;
  readonly sourceAnchor: AssistantCitationSourceAnchor;
}

const EDGE_GAP = 4;

const allowEditorClick = () => true;

function visibleRows(anchor: AssistantCitationSourceAnchor, viewport: HTMLElement) {
  const bounds = viewport.getBoundingClientRect();
  return assistantCitationSourceRects(anchor).filter((row) =>
    isSelectionRectVisible(row, [bounds]),
  );
}

/**
 * Ask in chat for the block a clicked caret stands for, such as a `# %%` cell. Like a selection's
 * action it opens where the pointer is, but it leaves at the first key, which stays the editor's.
 */
export function SourceCaretAction<T>(props: {
  readonly viewport: HTMLElement | null;
  readonly capture: () => CaretQuote<T> | null;
  readonly onCite: (citation: T, anchor: AssistantCitationSourceAnchor) => boolean;
}) {
  const { viewport, capture } = props;
  const [offer, setOffer] = useState<
    (CaretQuote<T> & { readonly left: number; readonly top: number }) | null
  >(null);
  const place = useRef<HTMLDivElement>(null);
  const action = useRef<HTMLButtonElement>(null);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- follows clicks and keys in the editor, which report nothing to React.
  useEffect(() => {
    if (viewport === null) return;
    const clear = () => setOffer(null);
    const actions = observeSelectionActions({
      element: viewport,
      getActionElement: () => action.current,
      allowPreventedSelectionStart: allowEditorClick,
      onSelection: (pointer) => {
        const captured = pointer === null ? null : capture();
        if (pointer === null || captured === null) {
          clear();
          return;
        }
        const bounds = viewport.getBoundingClientRect();
        setOffer({
          citation: captured.citation,
          // The comment box opens at the last row, which in a tall block may be out of view.
          sourceAnchor: {
            ...captured.sourceAnchor,
            resolveRects: () => visibleRows(captured.sourceAnchor, viewport),
          },
          left: pointer.x - bounds.left,
          top: pointer.y - bounds.top,
        });
      },
      onDismiss: clear,
    });
    const leave = () => {
      actions.cancel();
      clear();
    };
    // The window sees a key first: the file surface stops Escape at the document.
    window.addEventListener("keydown", leave, true);
    return () => {
      window.removeEventListener("keydown", leave, true);
      actions.dispose();
    };
  }, [capture, viewport]);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- measures the action and keeps it inside the surface before paint.
  useLayoutEffect(() => {
    const element = place.current;
    if (element === null || viewport === null || offer === null) return;
    const room = (size: number, own: number) => size - own - EDGE_GAP;
    element.style.left = `${Math.min(offer.left, room(viewport.clientWidth, element.offsetWidth))}px`;
    element.style.top = `${Math.min(offer.top, room(viewport.clientHeight, element.offsetHeight))}px`;
  }, [offer, viewport]);
  if (offer === null) return null;
  return (
    // The delay keeps it out of a double-click. Only the action takes the pointer, and its rounded
    // corner sits at the pointer, so that double-click's second press still reaches the editor.
    <div
      ref={place}
      className="pointer-events-none absolute z-10 transition-opacity delay-200 duration-100 starting:opacity-0 *:pointer-events-auto"
      style={{ left: offer.left, top: offer.top }}
    >
      <Button
        ref={action}
        type="button"
        size="xs"
        variant="glass"
        onPointerDown={(event) => event.preventDefault()}
        onClick={() => {
          if (props.onCite(offer.citation, offer.sourceAnchor)) setOffer(null);
        }}
      >
        Ask in chat
      </Button>
    </div>
  );
}
