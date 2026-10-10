import type { Editor, NodeViewRenderer, NodeViewRendererProps } from "@tiptap/core";
import type { NodeView } from "@tiptap/pm/view";
import { NodeSelection, Selection, TextSelection } from "@tiptap/pm/state";
import type { MathfieldElement } from "mathlive";
import type { LatexCompletionContext } from "./latexCommandCompletion";
import {
  installMathReadingPreview,
  mathReadingPreview,
  mathReadingPreviewContextId,
  mathReadingPreviewReady,
} from "./mathReadingPreview";
import {
  mathReadingPriority,
  observeMathReadingPriority,
  scheduleMathFieldMount,
} from "./mathFieldMountQueue";
import { latexEquationReferencesKey, latexReferencePresentation } from "./latexEquationReferences";
import { positionEquationNumbers } from "./mathEquationNumbers";

export interface MathReadingNodeOptions {
  readingContext: (() => LatexCompletionContext) | null;
}

interface Reader {
  readonly dom: HTMLElement;
  refresh(): void;
  enter(event?: PointerEvent): void;
}

const owners = new WeakMap<Editor, ReturnType<typeof createOwner>>();
const noMacros = {};

/** Preamble changes can leave the document nodes identical. Refresh their reading views explicitly. */
export function refreshMathReadingContext(editor: Editor): void {
  owners.get(editor)?.refresh();
}

/** Passive atoms use DOM and the shared preview worker; interaction creates the existing editor. */
export function mathReadingNodeView(
  initial: NodeViewRendererProps,
  interactive: NodeViewRenderer,
  context: () => LatexCompletionContext,
  sourceFor: (node: NodeViewRendererProps["node"]) => string,
): NodeView {
  let props = initial;
  let full: NodeView | undefined;
  let disposed = false;
  let epoch = 0;
  let signature = "";
  let numberSignature = "";
  let cancelPreview: (() => void) | undefined;
  let cancelNumbers: (() => void) | undefined;
  let queued: ReturnType<typeof scheduleMathFieldMount> | undefined;
  let pointerFrame = 0;
  let previewFrame = 0;
  let cancelPointer: (() => void) | undefined;
  const display = props.node.type.name === "latexDisplayMath";
  const dom = document.createElement(display ? "div" : "span");
  dom.className = `react-renderer node-${props.node.type.name}`;
  dom.dataset.mathReadingView = "true";
  const wrapper = document.createElement(display ? "div" : "span");
  wrapper.className = display
    ? "scient-latex-visual-display-math"
    : "scient-latex-visual-inline-math";
  wrapper.setAttribute("data-node-view-wrapper", "");
  wrapper.contentEditable = "false";
  const field = document.createElement("span");
  field.className = "scient-latex-mathfield";
  field.contentEditable = "false";
  const preview = document.createElement("span");
  preview.className = "scient-latex-math-preview";
  const content = installMathReadingPreview(preview).querySelector<HTMLElement>(
    "[data-math-preview-content]",
  )!;
  field.append(preview);
  wrapper.append(field);
  dom.append(wrapper);
  const stopObserving = observeMathReadingPriority(field);
  const priority = () => mathReadingPriority(field);
  const owner = owners.get(props.editor) ?? createOwner(props.editor, props.view.dom);
  owners.set(props.editor, owner);
  const numbers = () => {
    if (!display) return;
    const position = props.getPos();
    const rows =
      typeof position === "number"
        ? (latexEquationReferencesKey.getState(props.editor.state)?.equations.get(position) ?? [])
        : [];
    const next = JSON.stringify(rows);
    if (next === numberSignature) return;
    numberSignature = next;
    cancelNumbers?.();
    wrapper.querySelector(".scient-latex-equation-numbers")?.remove();
    wrapper.toggleAttribute(
      "data-equation-numbered",
      rows.some((row) => row.display !== null),
    );
    if (!rows.some((row) => row.display !== null)) return;
    const band = document.createElement("span");
    band.className = "scient-latex-equation-numbers";
    band.contentEditable = "false";
    for (const [index, row] of rows.entries()) {
      const label = document.createElement("span");
      label.dataset.latexEquationRow = String(index);
      if (row.number) label.setAttribute("aria-label", `Equation ${row.number}`);
      label.textContent = row.display ?? "";
      band.append(label);
    }
    wrapper.append(band);
    cancelNumbers = positionEquationNumbers(wrapper, rows.length);
  };
  const refresh = () => {
    if (disposed || full) return;
    wrapper.toggleAttribute("data-empty", !String(props.node.attrs.tex ?? "").trim());
    wrapper.toggleAttribute(
      "data-document-selected",
      props.decorations.some((decoration) => decoration.spec.latexDocumentSelected === true),
    );
    numbers();
    const configuration = context();
    const value = sourceFor(props.node);
    const macros = configuration.macros ?? noMacros;
    const next = JSON.stringify([
      value,
      display,
      mathReadingPreviewContextId(macros, configuration.colors),
    ]);
    if (next === signature) return;
    signature = next;
    const version = ++epoch;
    cancelPreview?.();
    queued?.cancel();
    delete content.dataset.mathPreviewReady;
    preview.setAttribute("aria-label", value);
    const apply = (markup: string | null) => {
      queued = scheduleMathFieldMount(() => {
        if (disposed || full || version !== epoch) return;
        if (markup === null) content.textContent = value;
        else content.innerHTML = markup;
        content.dataset.mathPreviewReady = "true";
        field.dispatchEvent(new CustomEvent("scient-latex-math-preview", { bubbles: true }));
      }, priority);
    };
    try {
      cancelPreview = mathReadingPreview(
        value,
        display,
        macros,
        configuration.colors,
        apply,
        priority,
      );
    } catch {
      apply(null);
    }
  };
  const releaseReading = () => {
    epoch++;
    cancelPreview?.();
    queued?.cancel();
    cancelNumbers?.();
    stopObserving();
    owner.remove(reader);
    delete dom.dataset.mathReadingView;
  };
  const enter = (event?: PointerEvent) => {
    if (disposed || full || !props.editor.isEditable) return;
    const position = props.getPos();
    if (typeof position !== "number" || !props.editor.state.doc.nodeAt(position)) return;
    // The whitespace beside a display belongs to the surrounding text flow.
    // Keep its existing before/after click behavior without creating an editor.
    if (event && display && mathReadingPreviewReady(preview)) {
      const bounds = preview.getBoundingClientRect();
      const direction =
        event.clientX < bounds.left - 4 ? -1 : event.clientX > bounds.right + 4 ? 1 : 0;
      if (direction) {
        event.preventDefault();
        event.stopImmediatePropagation();
        const transaction = props.view.state.tr;
        const boundary = direction > 0 ? position + props.node.nodeSize : position;
        const resolved = transaction.doc.resolve(boundary);
        const adjacent = direction > 0 ? resolved.nodeAfter : resolved.nodeBefore;
        if (!adjacent?.isTextblock) {
          transaction.insert(boundary, props.editor.schema.nodes.paragraph!.create());
          transaction.setSelection(TextSelection.create(transaction.doc, boundary + 1));
        } else transaction.setSelection(Selection.near(resolved, direction));
        props.view.dispatch(transaction.scrollIntoView());
        props.view.focus();
        return;
      }
    }
    releaseReading();
    full = interactive(props);
    dom.replaceChildren(full.dom);
    if (mathReadingPreviewReady(preview)) {
      const snapshot = [...content.childNodes].map((node) => node.cloneNode(true));
      const started = performance.now();
      const transfer = () => {
        if (disposed || !full || props.editor.isDestroyed) return;
        const configuration = context();
        if (
          signature !==
          JSON.stringify([
            sourceFor(props.node),
            display,
            mathReadingPreviewContextId(configuration.macros ?? noMacros, configuration.colors),
          ])
        )
          return;
        const target = full.dom.querySelector<HTMLElement>(".scient-latex-math-preview");
        // React can defer its portal commit while ProseMirror changes selection.
        if (!target || !dom.isConnected) {
          if (performance.now() - started < 3000) previewFrame = requestAnimationFrame(transfer);
          return;
        }
        const nextContent = installMathReadingPreview(target).querySelector<HTMLElement>(
          "[data-math-preview-content]",
        )!;
        nextContent.replaceChildren(...snapshot);
        target.dataset.mathPreviewReady = "true";
      };
      previewFrame = requestAnimationFrame(transfer);
    }
    if (
      !(props.editor.state.selection instanceof NodeSelection) ||
      props.editor.state.selection.from !== position
    )
      props.view.dispatch(
        props.view.state.tr.setSelection(NodeSelection.create(props.view.state.doc, position)),
      );
    full.selectNode?.();
    if (!event) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    let released: PointerEvent | undefined;
    let movement: PointerEvent | undefined;
    const moved = (next: PointerEvent) => {
      if (next.pointerId === event.pointerId) movement = next;
    };
    const ended = (next: PointerEvent) => {
      if (next.pointerId === event.pointerId) released = next;
    };
    const document = dom.ownerDocument;
    document.addEventListener("pointermove", moved, true);
    document.addEventListener("pointerup", ended, true);
    document.addEventListener("pointercancel", ended, true);
    cancelPointer = () => {
      cancelAnimationFrame(pointerFrame);
      document.removeEventListener("pointermove", moved, true);
      document.removeEventListener("pointerup", ended, true);
      document.removeEventListener("pointercancel", ended, true);
    };
    const started = performance.now();
    const relay = () => {
      if (disposed || props.editor.isDestroyed) {
        cancelPointer?.();
        return;
      }
      const selection = props.editor.state.selection;
      if (
        !dom.isConnected ||
        released?.type === "pointercancel" ||
        !(selection instanceof NodeSelection) ||
        selection.from !== props.getPos()
      ) {
        cancelPointer?.();
        return;
      }
      const math = dom.querySelector<MathfieldElement>("math-field");
      if (!math?.hasFocus()) {
        if (performance.now() - started < 3000) pointerFrame = requestAnimationFrame(relay);
        else cancelPointer?.();
        return;
      }
      cancelPointer?.();
      const hit = math.shadowRoot?.elementFromPoint(event.clientX, event.clientY);
      // The user can scroll while React admits the editor. ShadowRoot hit
      // testing can then return another host at the original coordinates.
      // Complete the handoff inside its original math field only.
      const target =
        hit && (math.shadowRoot?.contains(hit) || math.contains(hit))
          ? hit
          : (math.shadowRoot?.querySelector(".ML__content") ?? math);
      target.dispatchEvent(
        new PointerEvent("pointerdown", { ...pointerInput(event), bubbles: true, composed: true }),
      );
      if (movement)
        math.dispatchEvent(
          new PointerEvent("pointermove", {
            ...pointerInput(movement),
            bubbles: true,
            composed: true,
          }),
        );
      if (released)
        math.dispatchEvent(
          new PointerEvent(released.type, {
            ...pointerInput(released),
            bubbles: true,
            composed: true,
          }),
        );
    };
    pointerFrame = requestAnimationFrame(relay);
  };
  const reader: Reader = { dom, refresh, enter };
  owner.add(reader);
  refresh();
  return {
    dom,
    contentDOM: null,
    update(node, decorations, innerDecorations) {
      if (node.type !== props.node.type) return false;
      props = { ...props, node, decorations, innerDecorations };
      if (full) return full.update?.(node, decorations, innerDecorations) ?? false;
      refresh();
      return true;
    },
    selectNode() {
      enter();
      full?.selectNode?.();
    },
    deselectNode() {
      full?.deselectNode?.();
    },
    stopEvent(event) {
      return full?.stopEvent?.(event) ?? false;
    },
    ignoreMutation(mutation) {
      return full?.ignoreMutation?.(mutation) ?? mutation.type !== "selection";
    },
    destroy() {
      disposed = true;
      cancelAnimationFrame(previewFrame);
      cancelPointer?.();
      if (full) full.destroy?.();
      else releaseReading();
    },
  };
}

function pointerInput(event: PointerEvent): PointerEventInit {
  return {
    pointerId: event.pointerId,
    pointerType: event.pointerType,
    isPrimary: event.isPrimary,
    clientX: event.clientX,
    clientY: event.clientY,
    button: event.button,
    buttons: event.buttons,
    shiftKey: event.shiftKey,
    ctrlKey: event.ctrlKey,
    altKey: event.altKey,
    metaKey: event.metaKey,
  };
}

function createOwner(editor: Editor, root: HTMLElement) {
  const members = new Set<Reader>();
  const nodes = new WeakMap<Element, Reader>();
  let presentation = latexReferencePresentation(editor.state);
  const refresh = () => {
    for (const member of members) member.refresh();
  };
  const transaction = () => {
    const next = latexReferencePresentation(editor.state);
    if (next === presentation) return;
    presentation = next;
    refresh();
  };
  const pointer = (event: PointerEvent) => {
    if (event.button !== 0 || event.shiftKey || event.ctrlKey || event.metaKey || event.altKey)
      return;
    for (const target of event.composedPath()) {
      if (!(target instanceof Element)) continue;
      const member = nodes.get(target);
      if (!member) continue;
      member.enter(event);
      return;
    }
  };
  root.addEventListener("pointerdown", pointer, true);
  editor.on("transaction", transaction);
  return {
    refresh,
    add(member: Reader) {
      members.add(member);
      nodes.set(member.dom, member);
    },
    remove(member: Reader) {
      members.delete(member);
      nodes.delete(member.dom);
      if (members.size) return;
      root.removeEventListener("pointerdown", pointer, true);
      editor.off("transaction", transaction);
      owners.delete(editor);
    },
  };
}
