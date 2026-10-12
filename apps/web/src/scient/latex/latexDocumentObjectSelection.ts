import { Plugin, NodeSelection, type Selection } from "@tiptap/pm/state";
import type { Node as DocumentNode } from "@tiptap/pm/model";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import {
  captureLatexObjectDrag,
  isLatexSelectionObject,
  latexObjectOwnsPointerSelection,
  latexDocumentSelectionAtPointer,
  latexSelectionObjectAtElement,
  pointerInsideLatexObject,
} from "./latexObjectSelection";

/** Prose drags crossing embedded editors remain one document selection. */
export function latexDocumentObjectSelection() {
  let pointerSelection: { selection: Selection; doc: DocumentNode } | null = null;
  return new Plugin({
    props: {
      createSelectionBetween(view) {
        return pointerSelection?.doc === view.state.doc ? pointerSelection.selection : null;
      },
      decorations(state) {
        const { selection, doc } = state;
        if (selection.empty || selection instanceof NodeSelection) return null;
        const decorations: Decoration[] = [];
        doc.nodesBetween(selection.from, selection.to, (node, position) => {
          if (!isLatexSelectionObject(node)) return;
          if (selection.from <= position && selection.to >= position + node.nodeSize)
            decorations.push(
              Decoration.node(
                position,
                position + node.nodeSize,
                {
                  "data-latex-document-selection": "",
                },
                { latexDocumentSelected: true },
              ),
            );
          return false;
        });
        return DecorationSet.create(doc, decorations);
      },
    },
    view(view) {
      let drag: {
        anchor: number;
        locked: boolean;
        managed: boolean;
        origin: ReturnType<typeof latexSelectionObjectAtElement>;
      } | null = null;
      let suppressClick = false;
      let release: (() => void) | null = null;
      let finishing: { selection: Selection; doc: typeof view.state.doc } | null = null;
      const apply = (selection: Selection) => {
        if (view.isDestroyed) return;
        if (!view.state.selection.eq(selection))
          view.dispatch(view.state.tr.setSelection(selection).setMeta("pointer", true));
        // Force DOM synchronization even while Chrome's native drag is active.
        // Focus belongs to the document, not a textarea crossed by the pointer.
        view.focus();
      };
      const stop = () => {
        release?.();
        release = null;
        drag = null;
        pointerSelection = null;
      };
      const move = (event: PointerEvent) => {
        if (!drag || view.isDestroyed) return;
        if (drag.origin && !drag.managed) {
          const bounds = drag.origin.element.getBoundingClientRect();
          if (pointerInsideLatexObject(event, bounds)) return;
          const before =
            event.clientY < bounds.top ||
            (event.clientY <= bounds.bottom && event.clientX < bounds.left);
          drag.anchor = drag.origin.position + (before ? drag.origin.node.nodeSize : 0);
          drag.locked = true;
        }
        if (!drag.locked) {
          const native = view.dom.ownerDocument.getSelection();
          if (native?.anchorNode && view.dom.contains(native.anchorNode)) {
            const owner =
              native.anchorNode.nodeType === 1
                ? (native.anchorNode as Element)
                : native.anchorNode.parentElement;
            if (!owner?.closest('[contenteditable="false"]')) {
              drag.anchor = view.posAtDOM(native.anchorNode, native.anchorOffset);
              drag.locked = true;
            }
          }
        }
        const anchor = Math.min(drag.anchor, view.state.doc.content.size);
        const selection = latexDocumentSelectionAtPointer(view, anchor, event);
        if (!selection) return;
        let includesObject = false;
        view.state.doc.nodesBetween(selection.from, selection.to, (node) => {
          if (!isLatexSelectionObject(node)) return;
          includesObject = true;
          return false;
        });
        if (!drag.managed && !includesObject) return;
        drag.managed = true;
        drag.locked = true;
        pointerSelection = { selection, doc: view.state.doc };
        event.preventDefault();
        event.stopImmediatePropagation();
        apply(selection);
      };
      const finish = (event: PointerEvent) => {
        if (drag?.managed && event.type === "pointerup") {
          suppressClick = true;
          const selection = latexDocumentSelectionAtPointer(
            view,
            Math.min(drag.anchor, view.state.doc.content.size),
            event,
          );
          if (selection) {
            apply(selection);
            finishing = { selection, doc: view.state.doc };
          }
        }
        stop();
      };
      const start = (event: PointerEvent) => {
        if (!view.editable || event.button !== 0 || event.pointerType === "touch") return;
        stop();
        finishing = null;
        suppressClick = false;
        if (!(event.target instanceof Element) || event.target.closest("button,select")) return;
        const origin = latexSelectionObjectAtElement(view, event.target);
        if (origin && latexObjectOwnsPointerSelection(origin.node)) return;
        if (!origin && event.target.closest('input,textarea,[contenteditable="false"]')) return;
        const hit = view.posAtCoords({ left: event.clientX, top: event.clientY });
        if (!hit) return;
        drag = {
          anchor: event.shiftKey ? view.state.selection.anchor : hit.pos,
          locked: event.shiftKey || Boolean(origin),
          managed: false,
          origin: event.shiftKey ? null : origin,
        };
        if (origin && event.shiftKey) {
          const selection = latexDocumentSelectionAtPointer(view, drag.anchor, event);
          if (selection) {
            drag.managed = true;
            pointerSelection = { selection, doc: view.state.doc };
            suppressClick = true;
            event.preventDefault();
            apply(selection);
          }
        }
        release = captureLatexObjectDrag(event.pointerId, move, finish);
      };
      const click = (event: MouseEvent) => {
        if (!suppressClick) return;
        suppressClick = false;
        event.preventDefault();
        event.stopImmediatePropagation();
      };
      const dragStart = (event: DragEvent) => {
        if (drag?.origin) event.preventDefault();
      };
      const nativeMove = (event: MouseEvent) => {
        if (drag?.managed && event.buttons & 1) event.preventDefault();
      };
      const nativeFinish = (event: MouseEvent) => {
        const pending = finishing;
        finishing = null;
        if (!pending) return;
        event.preventDefault();
        // ProseMirror may finish its own mouse tracker in this same event.
        queueMicrotask(() => {
          if (!view.isDestroyed && view.state.doc === pending.doc) apply(pending.selection);
        });
      };
      const blurred = () => {
        stop();
        finishing = null;
      };
      view.dom.addEventListener("pointerdown", start, true);
      view.dom.addEventListener("click", click, true);
      view.dom.addEventListener("dragstart", dragStart, true);
      window.addEventListener("mousemove", nativeMove, true);
      window.addEventListener("mouseup", nativeFinish, true);
      window.addEventListener("blur", blurred);
      return {
        destroy() {
          stop();
          finishing = null;
          view.dom.removeEventListener("pointerdown", start, true);
          view.dom.removeEventListener("click", click, true);
          view.dom.removeEventListener("dragstart", dragStart, true);
          window.removeEventListener("mousemove", nativeMove, true);
          window.removeEventListener("mouseup", nativeFinish, true);
          window.removeEventListener("blur", blurred);
        },
      };
    },
  });
}
