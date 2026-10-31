import {
  ASSISTANT_CITATION_MAX_TEXT_LENGTH,
  MessageId,
  type AssistantCitation,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import {
  use,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import { createPortal } from "react-dom";
import {
  captureAssistantTextSelection,
  assistantCitationSourceRects,
  type AssistantCitationSourceAnchor,
} from "~/lib/assistantTextSelection";
import {
  isSelectionRectVisible,
  observeSelectionActions,
  resolveSelectionActionPosition,
  type SelectionActionPoint,
} from "~/lib/selectionActions";
import { CitationActionBar } from "~/scient/chat/CitationActionBar";
import { SideChatCitationContext, type CitationDestination } from "~/scient/chat/sideChatCitation";
import { BackgroundThreadContext } from "./backgroundThread";

export function SelectionCitationToolbar<T extends { readonly text: string }>({
  viewport,
  capture,
  onCite,
  allowPreventedSelectionStart,
  subscribeSelection,
  selectionOwnerId,
  preserveSelection = false,
}: {
  viewport: HTMLElement | null;
  capture: () => { citation: T; sourceAnchor: AssistantCitationSourceAnchor } | null;
  onCite: (
    citation: T,
    sourceAnchor: AssistantCitationSourceAnchor,
    destination: CitationDestination,
  ) => boolean;
  allowPreventedSelectionStart?: (target: EventTarget | null) => boolean;
  subscribeSelection?: (changed: () => void) => () => void;
  selectionOwnerId?: string;
  preserveSelection?: boolean;
}) {
  const [selection, setSelection] = useState<{
    citation: T;
    position: SelectionActionPoint;
    sourceAnchor: AssistantCitationSourceAnchor;
  } | null>(null);
  const toolbarRef = useRef<HTMLDivElement>(null);
  const actionsRef = useRef<ReturnType<typeof observeSelectionActions> | null>(null);
  const backgroundThread = use(BackgroundThreadContext);
  const sideChatOffered = use(SideChatCitationContext) !== null;

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- measures the toolbar DOM node and clamps its position inside the window before paint
  useLayoutEffect(() => {
    const toolbar = toolbarRef.current;
    if (!toolbar || !selection) return;
    const rect = toolbar.getBoundingClientRect();
    toolbar.style.left = `${Math.max(8, Math.min(selection.position.x, window.innerWidth - rect.width - 8))}px`;
    toolbar.style.top = `${Math.max(8, Math.min(selection.position.y, window.innerHeight - rect.height - 8))}px`;
  }, [selection]);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- subscribes to document selectionchange and keydown to track text selections in the viewport
  useEffect(() => {
    if (!viewport) return;
    const clear = () => setSelection(null);
    const update = (pointer: SelectionActionPoint | null) => {
      const captured = capture();
      if (!captured) {
        clear();
        return;
      }
      const rects = assistantCitationSourceRects(captured.sourceAnchor);
      const rect = captured.sourceAnchor.resolveRects
        ? rects.at(-1)
        : captured.sourceAnchor.range.getBoundingClientRect();
      if (!rect) {
        clear();
        return;
      }
      const viewportRect = viewport.getBoundingClientRect();
      if (!isSelectionRectVisible(rect, [viewportRect])) {
        clear();
        return;
      }
      // A selection can cross blocks with different clipping ancestors.
      const common = captured.sourceAnchor.range.commonAncestorContainer;
      const walker = document.createTreeWalker(common, NodeFilter.SHOW_TEXT);
      let node = common.nodeType === Node.TEXT_NODE ? common : walker.nextNode();
      let visible =
        captured.sourceAnchor.resolveRects !== undefined &&
        rects.some((line) => isSelectionRectVisible(line, [viewportRect]));
      for (; node && !visible && !captured.sourceAnchor.resolveRects; node = walker.nextNode()) {
        if (!captured.sourceAnchor.range.intersectsNode(node)) continue;
        if (node.parentElement && getComputedStyle(node.parentElement).userSelect === "none")
          continue;
        const fragment = document.createRange();
        fragment.selectNodeContents(node);
        if (node === captured.sourceAnchor.range.startContainer) {
          fragment.setStart(node, captured.sourceAnchor.range.startOffset);
        }
        if (node === captured.sourceAnchor.range.endContainer) {
          fragment.setEnd(node, captured.sourceAnchor.range.endOffset);
        }
        if (!fragment.toString().trim()) continue;
        const lines = Array.from(fragment.getClientRects());
        if (!lines.some((line) => isSelectionRectVisible(line, [viewportRect]))) continue;
        const clips: Pick<DOMRect, "left" | "right" | "top" | "bottom">[] = [viewportRect];
        for (
          let element = node.parentElement;
          element && element !== viewport;
          element = element.parentElement
        ) {
          const style = getComputedStyle(element);
          const clipX = style.overflowX !== "visible";
          const clipY = style.overflowY !== "visible";
          if (!clipX && !clipY) continue;
          const bounds = element.getBoundingClientRect();
          const left = bounds.left + element.clientLeft;
          const top = bounds.top + element.clientTop;
          clips.push({
            left: clipX ? left : -Infinity,
            right: clipX ? left + element.clientWidth : Infinity,
            top: clipY ? top : -Infinity,
            bottom: clipY ? top + element.clientHeight : Infinity,
          });
        }
        visible = lines.some((line) => isSelectionRectVisible(line, clips));
      }
      if (!visible) {
        clear();
        return;
      }
      const pointerOnText =
        pointer !== null &&
        rects.some(
          (line) =>
            pointer.x >= line.left - 8 &&
            pointer.x <= line.right + 8 &&
            pointer.y >= line.top - 8 &&
            pointer.y <= line.bottom + 8,
        );
      setSelection({
        sourceAnchor: captured.sourceAnchor,
        citation: captured.citation,
        position: resolveSelectionActionPosition({
          bounds: viewportRect,
          selectionRect: rects.at(-1) ?? rect,
          pointer: pointerOnText ? pointer : null,
          viewport: { width: window.innerWidth, height: window.innerHeight },
        }),
      });
    };
    const actions = observeSelectionActions({
      element: viewport,
      getActionElement: () => toolbarRef.current,
      ...(allowPreventedSelectionStart ? { allowPreventedSelectionStart } : {}),
      restoreAfterScroll: true,
      onSelection: update,
      onDismiss: clear,
    });
    actionsRef.current = actions;
    const unsubscribe = subscribeSelection?.(actions.selectionChanged);
    const focusActions = (event: KeyboardEvent) => {
      const toolbar = toolbarRef.current;
      if (
        event.key !== "Tab" ||
        event.shiftKey ||
        event.altKey ||
        event.ctrlKey ||
        event.metaKey ||
        event.isComposing ||
        event.defaultPrevented ||
        !toolbar ||
        toolbar.contains(event.target as Node)
      ) {
        return;
      }
      const action = toolbar.querySelector("button");
      if (!action || action.disabled) return;
      event.preventDefault();
      event.stopPropagation();
      action.focus({ preventScroll: true });
    };
    // Tab belongs to the foreground chat; a background timeline only follows its selection.
    if (!backgroundThread) document.addEventListener("keydown", focusActions, true);
    document.addEventListener("selectionchange", actions.selectionChanged);
    return () => {
      document.removeEventListener("keydown", focusActions, true);
      document.removeEventListener("selectionchange", actions.selectionChanged);
      actions.dispose();
      unsubscribe?.();
      actionsRef.current = null;
    };
  }, [allowPreventedSelectionStart, backgroundThread, capture, viewport, subscribeSelection]);

  if (!selection) return null;
  const tooLong = selection.citation.text.length > ASSISTANT_CITATION_MAX_TEXT_LENGTH;
  const dismiss = () => {
    actionsRef.current?.cancel();
    setSelection(null);
  };
  const cite = (destination: CitationDestination) => {
    if (tooLong || !onCite(selection.citation, selection.sourceAnchor, destination)) return false;
    if (!preserveSelection) window.getSelection()?.removeAllRanges();
    dismiss();
    return true;
  };
  const dismissOnEscape = (event: ReactKeyboardEvent<HTMLElement>) => {
    event.stopPropagation();
    if (event.key === "Escape" && !event.nativeEvent.isComposing) {
      event.preventDefault();
      dismiss();
    }
  };
  return createPortal(
    <CitationActionBar
      ref={toolbarRef}
      style={{ left: selection.position.x, top: selection.position.y }}
      ownerId={selectionOwnerId}
      {...(tooLong
        ? {
            label: "Shorten selection",
            accessibleLabel: "Selection is too long to cite",
            disabled: true,
          }
        : {})}
      onAskInChat={() => cite("chat")}
      onAskInSideChat={sideChatOffered && !tooLong ? () => cite("side-chat") : undefined}
      onKeyDown={dismissOnEscape}
    />,
    document.body,
  );
}

export function AssistantSelectionToolbar({
  viewport,
  threadRef,
  onCite,
}: {
  viewport: HTMLElement | null;
  threadRef: ScopedThreadRef;
  onCite: (
    citation: AssistantCitation,
    sourceAnchor: AssistantCitationSourceAnchor,
    destination: CitationDestination,
  ) => boolean;
}) {
  const capture = () => {
    if (!viewport) return null;
    const captured = captureAssistantTextSelection(viewport, window.getSelection());
    const messageId = captured?.source.dataset.assistantCitationSource;
    if (!captured || !messageId) return null;
    return {
      citation: {
        version: 1 as const,
        ...threadRef,
        messageId: MessageId.make(messageId),
        ...captured.selector,
      },
      sourceAnchor: { source: captured.source, range: captured.range, viewport },
    };
  };
  return <SelectionCitationToolbar viewport={viewport} capture={capture} onCite={onCite} />;
}
