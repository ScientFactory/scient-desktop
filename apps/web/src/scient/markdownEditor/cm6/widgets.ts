import { WidgetType } from "@codemirror/view";
import katex from "katex";

/** Renders KaTeX output for a math range. The TeX source stays in the buffer. */
export class MathWidget extends WidgetType {
  constructor(
    readonly tex: string,
    readonly displayMode: boolean,
  ) {
    super();
  }

  override eq(other: MathWidget): boolean {
    return other.tex === this.tex && other.displayMode === this.displayMode;
  }

  override toDOM(): HTMLElement {
    const element = document.createElement(this.displayMode ? "div" : "span");
    element.className = this.displayMode ? "cm-md-math cm-md-math-display" : "cm-md-math";
    element.innerHTML = katex.renderToString(this.tex, {
      displayMode: this.displayMode,
      throwOnError: false,
      strict: false,
    });
    return element;
  }
}

/** Renders a resolved image for an image range. Source text stays in the buffer. */
export class MarkdownImageWidget extends WidgetType {
  constructor(
    readonly authoredSource: string,
    readonly resolvedUrl: string | null,
    readonly alt: string,
  ) {
    super();
  }

  override eq(other: MarkdownImageWidget): boolean {
    return (
      other.authoredSource === this.authoredSource &&
      other.resolvedUrl === this.resolvedUrl &&
      other.alt === this.alt
    );
  }

  override toDOM(): HTMLElement {
    const figure = document.createElement("figure");
    figure.className = "cm-md-image";
    if (this.resolvedUrl !== null) {
      const image = document.createElement("img");
      image.src = this.resolvedUrl;
      image.alt = this.alt;
      image.loading = "lazy";
      image.draggable = false;
      figure.append(image);
      if (this.alt) {
        const caption = document.createElement("figcaption");
        caption.textContent = this.alt;
        figure.append(caption);
      }
    } else {
      const pending = document.createElement("span");
      pending.className = "cm-md-image-pending";
      pending.textContent = this.authoredSource;
      figure.append(pending);
    }
    return figure;
  }
}

/** Interactive checkbox replacing a task-list marker. Clicking patches the marker source. */
export class TaskCheckboxWidget extends WidgetType {
  constructor(
    readonly checked: boolean,
    readonly taskText: string,
    readonly toggle: () => void,
  ) {
    super();
  }

  override eq(other: TaskCheckboxWidget): boolean {
    return other.checked === this.checked && other.taskText === this.taskText;
  }

  override toDOM(): HTMLElement {
    const wrapper = document.createElement("span");
    wrapper.className = "cm-md-task";
    const box = document.createElement("input");
    box.type = "checkbox";
    box.checked = this.checked;
    box.setAttribute(
      "aria-label",
      `${this.checked ? "Mark task incomplete" : "Mark task complete"}: ${this.taskText || "Untitled task"}`,
    );
    box.contentEditable = "false";
    box.addEventListener("change", () => this.toggle());
    wrapper.append(box);
    return wrapper;
  }

  override ignoreEvent(): boolean {
    return true;
  }
}

/** Visual bullet replacing a raw list marker on inactive lines. */
export class BulletWidget extends WidgetType {
  constructor(readonly marker: string) {
    super();
  }

  override eq(other: BulletWidget): boolean {
    return other.marker === this.marker;
  }

  override toDOM(): HTMLElement {
    const bullet = document.createElement("span");
    bullet.className = "cm-md-bullet";
    bullet.textContent = "•";
    bullet.dataset.marker = this.marker;
    return bullet;
  }
}

/** A horizontal rule drawn over the raw marker line. */
export class HorizontalRuleWidget extends WidgetType {
  override eq(other: WidgetType): boolean {
    return other instanceof HorizontalRuleWidget;
  }

  override toDOM(): HTMLElement {
    const rule = document.createElement("div");
    rule.className = "cm-md-hr";
    return rule;
  }
}

/** Empty-document placeholder rendered at position zero. */
export class PlaceholderWidget extends WidgetType {
  constructor(readonly text: string) {
    super();
  }

  override eq(other: PlaceholderWidget): boolean {
    return other.text === this.text;
  }

  override toDOM(): HTMLElement {
    const placeholder = document.createElement("span");
    placeholder.className = "cm-md-placeholder";
    placeholder.setAttribute("aria-hidden", "true");
    placeholder.textContent = this.text;
    return placeholder;
  }
}
