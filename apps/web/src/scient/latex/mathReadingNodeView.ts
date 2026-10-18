import "./mathReadingAdmission.css";
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
  retainMathReadingPreview,
  rememberMathReadingFallback,
} from "./mathReadingPreview";
import {
  mathReadingPriority,
  observeMathReadingPriority,
  scheduleMathFieldMount,
} from "./mathFieldMountQueue";
import { latexEquationReferencesKey, latexReferencePresentation } from "./latexEquationReferences";
import { positionEquationNumbers } from "./mathEquationNumbers";
import { focusAdmittedMathField } from "./mathFieldAdmissionFocus";

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
const terminalFallbacks = new WeakMap<NodeViewRendererProps["node"], number>();

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
  let retryPreview: ReturnType<typeof setTimeout> | undefined;
  let retryable = false;
  let retries = 0;
  let renderedMarkup: string | null = null;
  let numberSignature = "";
  let cancelPreview: (() => void) | undefined;
  let cancelNumbers: (() => void) | undefined;
  let queued: ReturnType<typeof scheduleMathFieldMount> | undefined;
  let pointerFrame = 0;
  let previewFrame = 0;
  let staged = false;
  let cancelAdmission: (() => void) | undefined;
  let cancelFocus: (() => void) | undefined;
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
  const stopObserving = observeMathReadingPriority(field, () => {
    if (renderedMarkup === null || disposed || full) return;
    const configuration = context();
    retainMathReadingPreview(
      sourceFor(props.node),
      display,
      configuration.macros ?? noMacros,
      configuration.colors,
      renderedMarkup,
    );
  });
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
    if (disposed) return;
    if (staged) cancelAdmission?.();
    if (full) return;
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
    if (next === signature && !retryable) return;
    if (next !== signature) retries = 0;
    retryable = false;
    clearTimeout(retryPreview);
    signature = next;
    renderedMarkup = null;
    const version = ++epoch;
    cancelPreview?.();
    queued?.cancel();
    delete content.dataset.mathPreviewReady;
    delete preview.dataset.mathPreviewFallback;
    field.dispatchEvent(
      new CustomEvent("scient-latex-math-preview", { bubbles: true, detail: { pending: true } }),
    );
    preview.setAttribute("aria-label", value);
    const apply = (markup: string | null, cached = false, transient = false) => {
      const present = () => {
        if (disposed || full || version !== epoch) return;
        if (markup === null) content.textContent = value;
        else content.innerHTML = markup;
        preview.toggleAttribute("data-math-preview-fallback", markup === null);
        if (markup === null && !transient) {
          terminalFallbacks.set(
            props.node,
            mathReadingPreviewContextId(macros, configuration.colors),
          );
          rememberMathReadingFallback(value, display, macros, configuration.colors);
        }
        if (markup === null && transient && retries < 1) {
          retries++;
          retryPreview = setTimeout(() => {
            if (disposed || full || version !== epoch) return;
            retryable = true;
            refresh();
          }, 500);
        }
        renderedMarkup = markup;
        content.dataset.mathPreviewReady = "true";
        field.dispatchEvent(
          new CustomEvent("scient-latex-math-preview", { bubbles: true, detail: { cached } }),
        );
      };
      // Admission already bounds node-view construction. Ready markup can be
      // published synchronously; a cache hit must not paint an empty formula.
      if (cached) present();
      else queued = scheduleMathFieldMount(present, priority);
    };
    if (
      terminalFallbacks.get(props.node) ===
      mathReadingPreviewContextId(macros, configuration.colors)
    ) {
      apply(null, true);
      return;
    }
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
      apply(null, false, true);
    }
  };
  const releaseReading = () => {
    epoch++;
    clearTimeout(retryPreview);
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
    // Keep the real reading wrapper in normal flow until the input's ink is
    // painted. The staged React node owns no layout or pointer surface; focus
    // stays on the noneditable reading wrapper until explicit publication.
    staged = true;
    wrapper.querySelector(".scient-latex-math-admission-hint")?.remove();
    const admissionSignature = signature;
    const admittedNode = props.node;
    const admissionStarted = performance.now();
    const hint = dom.ownerDocument.createElement("span");
    hint.className = "scient-latex-math-admission-hint";
    hint.setAttribute("role", "status");
    hint.textContent = "Preparing equation editor…";
    wrapper.append(hint);
    dom.dataset.mathEditorAdmission = "pending";
    const admissionDocument = dom.ownerDocument;
    const superseded = (event: Event) => {
      if (!(event.target instanceof Node) || dom.contains(event.target)) return;
      if (event.type === "focusin" && event.target === props.view.dom) return;
      cancelAdmission?.();
    };
    const waitingKey = (event: KeyboardEvent) => {
      if (event.key === "Tab" || event.key === "Escape") {
        cancelAdmission?.();
        return;
      }
      if (
        !event.ctrlKey &&
        !event.metaKey &&
        (event.key.length === 1 || ["Backspace", "Delete", "Enter"].includes(event.key))
      ) {
        event.preventDefault();
        event.stopImmediatePropagation();
      }
    };
    const waitingInput = (event: Event) => {
      if (!(event.target instanceof Node) || !props.view.dom.contains(event.target)) return;
      event.preventDefault();
      event.stopImmediatePropagation();
    };
    const inputEvents = [
      "beforeinput",
      "paste",
      "drop",
      "compositionstart",
      "compositionupdate",
      "compositionend",
    ];
    for (const type of inputEvents) admissionDocument.addEventListener(type, waitingInput, true);
    admissionDocument.addEventListener("pointerdown", superseded, true);
    admissionDocument.addEventListener("focusin", superseded, true);
    admissionDocument.addEventListener("keydown", waitingKey, true);
    const stopIntent = () => {
      for (const type of inputEvents)
        admissionDocument.removeEventListener(type, waitingInput, true);
      admissionDocument.removeEventListener("pointerdown", superseded, true);
      admissionDocument.removeEventListener("focusin", superseded, true);
      admissionDocument.removeEventListener("keydown", waitingKey, true);
    };
    const rollback = (failed = false) => {
      stopIntent();
      cancelAnimationFrame(previewFrame);
      cancelPointer?.();
      full?.destroy?.();
      full?.dom.remove();
      full = undefined;
      staged = false;
      cancelAdmission = undefined;
      delete dom.dataset.mathEditorAdmission;
      hint.remove();
      if (failed && !disposed) {
        hint.textContent = "Equation editor unavailable. ";
        const retry = dom.ownerDocument.createElement("button");
        retry.type = "button";
        retry.textContent = "Retry";
        retry.addEventListener("pointerdown", (event) => event.stopPropagation());
        retry.addEventListener("click", (event) => {
          event.stopPropagation();
          hint.remove();
          enter();
        });
        hint.append(retry);
        wrapper.append(hint);
      }
    };
    cancelAdmission = () => rollback();
    try {
      full = interactive(props);
      full.dom.dataset.mathEditorStaging = "true";
      full.dom.setAttribute("aria-hidden", "true");
      dom.dataset.mathEditorDisplay = String(display);
      dom.append(full.dom);
    } catch {
      rollback(true);
      return;
    }
    const publish = () => {
      if (disposed || !staged || !full || props.editor.isDestroyed) return;
      const configuration = context();
      const selection = props.editor.state.selection;
      if (
        !dom.isConnected ||
        !props.editor.isEditable ||
        props.node !== admittedNode ||
        !(selection instanceof NodeSelection) ||
        selection.from !== props.getPos() ||
        admissionSignature !==
          JSON.stringify([
            sourceFor(props.node),
            display,
            mathReadingPreviewContextId(configuration.macros ?? noMacros, configuration.colors),
          ])
      ) {
        rollback();
        refresh();
        return;
      }
      const math = full.dom.querySelector<MathfieldElement>("math-field");
      if (math?.dataset.scientMathReady === "true") {
        stopIntent();
        releaseReading();
        staged = false;
        cancelAdmission = undefined;
        hint.remove();
        delete dom.dataset.mathEditorAdmission;
        delete full.dom.dataset.mathEditorStaging;
        full.dom.removeAttribute("aria-hidden");
        const target = full.dom.querySelector<HTMLElement>(".scient-latex-math-preview");
        if (target && mathReadingPreviewReady(preview)) {
          installMathReadingPreview(target)
            .querySelector("[data-math-preview-content]")!
            .replaceChildren(...[...content.childNodes].map((node) => node.cloneNode(true)));
          target.dataset.mathPreviewReady = "true";
        }
        // The staged custom element is already connected. Moving it through
        // replaceChildren would disconnect MathLive and destroy its input model.
        wrapper.remove();
        full.selectNode?.();
        cancelFocus = focusAdmittedMathField(math, props.view.dom);
        dom.dispatchEvent(new CustomEvent("scient-latex-math-ready", { bubbles: true }));
        return;
      }
      if (
        math?.dataset.scientMathReady === "failed" ||
        performance.now() - admissionStarted >= 3500
      ) {
        rollback(true);
        return;
      }
      previewFrame = requestAnimationFrame(publish);
    };
    previewFrame = requestAnimationFrame(publish);
    if (
      !(props.editor.state.selection instanceof NodeSelection) ||
      props.editor.state.selection.from !== position
    )
      props.view.dispatch(
        props.view.state.tr.setSelection(NodeSelection.create(props.view.state.doc, position)),
      );
    full.selectNode?.();
    wrapper.tabIndex = -1;
    // A noneditable focus target prevents native, noncancelable IME input
    // from using the document's selected atom as an editing host.
    wrapper.focus({ preventScroll: true });
    if (!event) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    let released: PointerEvent | undefined;
    let movement: PointerEvent | undefined;
    const moved = (next: PointerEvent) => {
      if (next.pointerId === event.pointerId) movement = next;
    };
    const ended = (next: PointerEvent) => {
      if (next.pointerId === event.pointerId) {
        released = next;
        if (next.type === "pointercancel") cancelAdmission?.();
      }
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
      if (staged || !math?.hasFocus()) {
        if (performance.now() - started < 3500) pointerFrame = requestAnimationFrame(relay);
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
      if (staged && node !== props.node) cancelAdmission?.();
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
      // The outer atom owns admission/removal of its passive wrapper. The
      // delegated React view owns only its nested DOM, so it cannot classify
      // these mutations or native selection would be reread during handoff.
      if (
        mutation.type !== "selection" &&
        (mutation.target === dom || wrapper.contains(mutation.target))
      )
        return true;
      return full?.ignoreMutation?.(mutation) ?? mutation.type !== "selection";
    },
    destroy() {
      disposed = true;
      cancelFocus?.();
      cancelAdmission?.();
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
    if (
      event
        .composedPath()
        .some(
          (target) =>
            target instanceof Element && target.closest(".scient-latex-math-admission-hint"),
        )
    )
      return;
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
