import type { Node as ProseMirrorNode } from "prosemirror-model";
import { NodeSelection } from "prosemirror-state";
import type { EditorView, NodeView } from "prosemirror-view";

import {
  scientMarkdownFootnoteDefinitionId,
  scientMarkdownFootnoteReferenceId,
  type ScientMarkdownFootnotePresentation,
} from "../footnotes";
import { leaveAtomEditor } from "../prosemirror/safeSelection";

export interface ScientMarkdownFootnoteNodeViewRegistration {
  readonly element: HTMLElement;
  readonly getPos: () => number | undefined;
  readonly refresh: (presentation: ScientMarkdownFootnotePresentation) => void;
  readonly setEditable: (editable: boolean) => void;
}

export type ScientMarkdownFootnoteNodeViewRegistrar = (
  registration: ScientMarkdownFootnoteNodeViewRegistration,
) => () => void;

function sourceValue(node: ProseMirrorNode): string {
  return node.type.name === "citation"
    ? String(node.attrs.source)
    : footnoteBody(String(node.attrs.source));
}

function footnoteBody(source: string): string {
  const lines = source.replace(/^\[\^[^\]\r\n]+\]:[ \t]?/u, "").split(/\r?\n/u);
  return lines
    .map((line, index) => (index === 0 ? line : line.replace(/^(?: {4}|\t)/u, "")))
    .join("\n");
}

function footnoteSource(label: string, body: string): string {
  const [firstLine = "", ...continuation] = body.split(/\r?\n/u);
  return [`[^${label}]: ${firstLine}`, ...continuation.map((line) => `    ${line}`)].join("\n");
}

class ScientReferenceNodeView implements NodeView {
  readonly dom: HTMLElement;
  private readonly label = document.createElement("span");
  private readonly marker: HTMLButtonElement | null;
  private readonly sourceEditor: HTMLInputElement | HTMLTextAreaElement | null;
  private readonly unregisterFootnote: (() => void) | null;
  private node: ProseMirrorNode;
  private presentation: ScientMarkdownFootnotePresentation = new Map();

  constructor(
    node: ProseMirrorNode,
    private readonly view: EditorView,
    private readonly getPos: () => number | undefined,
    registerFootnote?: ScientMarkdownFootnoteNodeViewRegistrar,
  ) {
    this.node = node;
    const definition = node.type.name === "footnote_definition";
    const reference = node.type.name === "footnote_reference";
    this.dom = document.createElement(definition ? "aside" : reference ? "sup" : "span");
    this.dom.className = definition
      ? "scient-markdown-footnote-definition"
      : "scient-markdown-reference";
    this.dom.contentEditable = "false";
    this.dom.setAttribute("data-scient-markdown-reference", node.type.name);
    if (definition) this.dom.tabIndex = -1;

    if (reference) {
      this.marker = document.createElement("button");
      this.marker.type = "button";
      this.marker.className = "scient-markdown-footnote-marker";
      this.marker.addEventListener("mousedown", this.handleMarkerMouseDown);
      this.marker.addEventListener("click", this.handleMarkerClick);
      this.dom.append(this.marker);
      this.sourceEditor = null;
    } else {
      this.marker = null;
      this.label.className = "scient-markdown-reference-label";
      this.dom.append(this.label);
      this.sourceEditor = document.createElement(definition ? "textarea" : "input");
      this.sourceEditor.className = "scient-markdown-reference-source";
      if (definition) {
        this.sourceEditor.classList.add("scient-markdown-footnote-body");
        this.sourceEditor.hidden = false;
        this.sourceEditor.tabIndex = view.editable ? 0 : -1;
        (this.sourceEditor as HTMLTextAreaElement).rows = 1;
      } else {
        this.sourceEditor.hidden = true;
      }
      this.sourceEditor.dir = "auto";
      this.sourceEditor.readOnly = !view.editable;
      this.sourceEditor.setAttribute(
        "aria-label",
        definition ? "Footnote text" : "Citation source",
      );
      this.sourceEditor.addEventListener("mousedown", this.handleEditorMouseDown);
      this.sourceEditor.addEventListener("input", this.handleInput);
      this.sourceEditor.addEventListener("keydown", this.handleKeyDown);
      this.dom.append(this.sourceEditor);
    }

    this.unregisterFootnote =
      node.type.name.startsWith("footnote_") && registerFootnote
        ? registerFootnote({
            element: this.dom,
            getPos: this.getPos,
            refresh: (presentation) => {
              this.presentation = presentation;
              this.render();
            },
            setEditable: (editable) => this.setEditable(editable),
          })
        : null;
    this.render();
  }

  update(node: ProseMirrorNode): boolean {
    if (node.type !== this.node.type) return false;
    this.node = node;
    this.render();
    return true;
  }

  selectNode(): void {
    this.dom.classList.add("is-selected");
    if (!this.sourceEditor || !this.view.editable) return;
    if (this.node.type.name === "citation") this.sourceEditor.hidden = false;
    this.sourceEditor.readOnly = false;
    this.sourceEditor.value = sourceValue(this.node);
  }

  deselectNode(): void {
    this.dom.classList.remove("is-selected");
    if (this.sourceEditor && this.node.type.name === "citation") this.sourceEditor.hidden = true;
  }

  stopEvent(event: Event): boolean {
    return event.target === this.sourceEditor || event.target instanceof HTMLButtonElement;
  }

  ignoreMutation(): boolean {
    return true;
  }

  destroy(): void {
    this.marker?.removeEventListener("mousedown", this.handleMarkerMouseDown);
    this.marker?.removeEventListener("click", this.handleMarkerClick);
    this.sourceEditor?.removeEventListener("mousedown", this.handleEditorMouseDown);
    this.sourceEditor?.removeEventListener("input", this.handleInput);
    this.sourceEditor?.removeEventListener("keydown", this.handleKeyDown);
    this.unregisterFootnote?.();
  }

  private readonly handleMarkerMouseDown = (event: MouseEvent) => {
    if (event.button !== 0) return;
    event.preventDefault();
  };

  private setEditable(editable: boolean): void {
    if (!this.sourceEditor) return;
    this.sourceEditor.readOnly = !editable;
    if (this.node.type.name === "footnote_definition") {
      this.sourceEditor.hidden = false;
      this.sourceEditor.tabIndex = editable ? 0 : -1;
      return;
    }
    this.sourceEditor.hidden = !editable || !this.dom.classList.contains("is-selected");
  }

  private readonly handleMarkerClick = (event: MouseEvent) => {
    if (event.button !== 0) return;
    event.preventDefault();
    const entry = this.presentation.get(String(this.node.attrs.label));
    if (entry?.definitionPosition === null || entry?.definitionPosition === undefined) return;
    this.navigateToDefinition(entry.definitionPosition);
  };

  private readonly handleEditorMouseDown = (event: Event) => {
    if (!(event instanceof MouseEvent) || event.button !== 0 || !this.view.editable) return;
    const position = this.getPos();
    if (position === undefined) return;
    const selection = this.view.state.selection;
    if (!(selection instanceof NodeSelection) || selection.from !== position) {
      this.view.dispatch(
        this.view.state.tr
          .setSelection(NodeSelection.create(this.view.state.doc, position))
          .setMeta("addToHistory", false),
      );
    }
    this.sourceEditor?.focus({ preventScroll: true });
  };

  private readonly handleInput = (event: Event) => {
    if (
      !this.sourceEditor ||
      !this.view.editable ||
      (event instanceof InputEvent && event.isComposing)
    ) {
      return;
    }
    const position = this.getPos();
    if (position === undefined) return;
    const value = this.sourceEditor.value;
    const attrs =
      this.node.type.name === "citation"
        ? { ...this.node.attrs, source: value }
        : {
            ...this.node.attrs,
            source: footnoteSource(String(this.node.attrs.label), value),
          };
    this.view.dispatch(this.view.state.tr.setNodeMarkup(position, undefined, attrs));
  };

  private readonly handleKeyDown = (event: Event) => {
    if (!(event instanceof KeyboardEvent) || event.key !== "Escape") return;
    event.preventDefault();
    leaveAtomEditor(this.view, this.getPos, this.node);
  };

  private render(): void {
    if (this.node.type.name === "citation") {
      this.label.textContent = `[${String(this.node.attrs.source)}]`;
      if (this.sourceEditor && this.sourceEditor !== document.activeElement) {
        this.sourceEditor.value = sourceValue(this.node);
      }
      return;
    }

    const label = String(this.node.attrs.label);
    const entry = this.presentation.get(label);
    const number = entry?.number;
    if (this.marker) {
      const occurrence = Math.max(
        1,
        (entry?.referencePositions.indexOf(this.getPos() ?? -1) ?? -1) + 1,
      );
      const visibleNumber = number?.toString() ?? "?";
      this.marker.textContent = visibleNumber;
      this.marker.id = scientMarkdownFootnoteReferenceId(label, occurrence);
      this.marker.setAttribute(
        "aria-label",
        entry?.definitionPosition == null
          ? `Footnote ${visibleNumber} has no definition`
          : `Go to footnote ${visibleNumber}`,
      );
      if (entry?.definitionPosition == null) this.marker.removeAttribute("aria-describedby");
      else this.marker.setAttribute("aria-describedby", scientMarkdownFootnoteDefinitionId(label));
      this.dom.classList.toggle("is-missing", entry?.definitionPosition == null);
      return;
    }

    this.dom.id = scientMarkdownFootnoteDefinitionId(label);
    this.label.textContent = number === null || number === undefined ? "•" : `${number}.`;
    this.renderBacklinks(entry?.referencePositions ?? [], label, number);
    if (this.sourceEditor && this.sourceEditor !== document.activeElement) {
      this.sourceEditor.value = sourceValue(this.node);
    }
  }

  private renderBacklinks(
    referencePositions: readonly number[],
    label: string,
    number: number | null | undefined,
  ): void {
    this.dom.querySelector(".scient-markdown-footnote-backlinks")?.remove();
    if (referencePositions.length === 0) return;
    const backlinks = document.createElement("span");
    backlinks.className = "scient-markdown-footnote-backlinks";
    referencePositions.forEach((position, index) => {
      const backlink = document.createElement("button");
      backlink.type = "button";
      backlink.className = "scient-markdown-footnote-backlink";
      backlink.textContent = "↩";
      const tooltip = document.createElement("span");
      tooltip.className = "scient-markdown-footnote-backlink-tooltip";
      tooltip.textContent = "Back to text";
      tooltip.setAttribute("aria-hidden", "true");
      backlink.append(tooltip);
      backlink.setAttribute(
        "aria-label",
        `Return to footnote ${number ?? ""} reference ${index + 1}`.replace("  ", " "),
      );
      backlink.setAttribute("aria-controls", scientMarkdownFootnoteReferenceId(label, index + 1));
      backlink.addEventListener("mousedown", (event) => event.preventDefault());
      backlink.addEventListener("click", () => this.navigateToReference(position));
      backlinks.append(backlink);
    });
    (this.sourceEditor ?? this.label).after(backlinks);
  }

  private navigateToDefinition(position: number): void {
    const dom = this.view.nodeDOM(position);
    if (!(dom instanceof HTMLElement)) return;
    dom.scrollIntoView?.({ block: "center" });
    dom.focus({ preventScroll: true });
  }

  private navigateToReference(position: number): void {
    const node = this.view.state.doc.nodeAt(position);
    if (!node) return;
    this.view.dispatch(
      this.view.state.tr
        .setSelection(NodeSelection.create(this.view.state.doc, position))
        .setMeta("addToHistory", false)
        .scrollIntoView(),
    );
    queueMicrotask(() => {
      const dom = this.view.nodeDOM(position);
      if (!(dom instanceof HTMLElement)) return;
      dom.scrollIntoView?.({ block: "center" });
      const marker = dom.querySelector<HTMLButtonElement>(".scient-markdown-footnote-marker");
      (marker ?? dom).focus({ preventScroll: true });
    });
  }
}

export function createScientReferenceNodeView(
  node: ProseMirrorNode,
  view: EditorView,
  getPos: () => number | undefined,
  registerFootnote?: ScientMarkdownFootnoteNodeViewRegistrar,
): NodeView {
  return new ScientReferenceNodeView(node, view, getPos, registerFootnote);
}
