import { Schema, type NodeSpec } from "@tiptap/pm/model";
import { EditorState, TextSelection } from "@tiptap/pm/state";
import { EditorView } from "@tiptap/pm/view";
import { afterEach, expect, it } from "vite-plus/test";
import { latexDocumentObjectSelection } from "./latexDocumentObjectSelection";
import { setLatexObjectDragSelection } from "./latexObjectSelection";
import "./scient-latex.css";

const object = (className: string): NodeSpec => ({
  group: "block",
  atom: true,
  attrs: { kind: { default: "table" } },
  toDOM: () => [
    "div",
    { class: className, "data-node-view-wrapper": "", contenteditable: "false" },
    ["textarea", { "aria-label": "Embedded text" }, "Object"],
  ],
});
const schema = new Schema({
  nodes: {
    doc: { content: "block+" },
    paragraph: { group: "block", content: "text*", toDOM: () => ["p", 0] },
    text: {},
    latexRichPreview: object("scient-latex-rich-preview"),
    latexDisplayMath: object("scient-latex-visual-display-math"),
    latexRawBlock: object("scient-latex-visual-raw"),
  },
});
let view: EditorView;
let host: HTMLElement;
afterEach(() => {
  view?.destroy();
  host?.remove();
});
function mount(name: string) {
  host = document.createElement("div");
  host.className = "scient-latex-visual-workspace";
  host.style.cssText = "width:600px;position:relative;";
  document.body.append(host);
  const paragraph = (text: string) => schema.node("paragraph", null, schema.text(text));
  const before = paragraph("Before text.");
  const doc = schema.node("doc", null, [before, schema.node(name), paragraph("After text.")]);
  view = new EditorView(host, {
    state: EditorState.create({ schema, doc, plugins: [latexDocumentObjectSelection()] }),
    attributes: { class: "scient-latex-visual-document" },
    dispatchTransaction: (tr) => view.updateState(view.state.apply(tr)),
  });
  const position = before.nodeSize;
  const element = view.nodeDOM(position) as HTMLElement;
  return { position, element };
}
function pointer(target: EventTarget, type: string, element: Element) {
  const rect = element.getBoundingClientRect();
  target.dispatchEvent(
    new PointerEvent(type, {
      bubbles: true,
      cancelable: true,
      pointerId: 7,
      pointerType: "mouse",
      button: 0,
      buttons: type === "pointerup" ? 0 : 1,
      clientX: rect.left + rect.width / 2,
      clientY: rect.top + rect.height / 2,
    }),
  );
}
function handoff(position: number) {
  const selection = TextSelection.create(view.state.doc, position - 1, position + 3);
  setLatexObjectDragSelection(view, selection);
  view.dispatch(view.state.tr.setSelection(selection));
  return selection;
}

it.each(["latexRichPreview", "latexDisplayMath"])(
  "%s handoff survives native mouse release and its trailing click",
  async (name) => {
    const { position, element } = mount(name);
    pointer(element.querySelector("textarea")!, "pointerdown", element);
    const accepted = handoff(position);
    const doc = view.state.doc;
    pointer(window, "pointerup", element);
    // A native mouse tracker can finish after the window's capture listener.
    const native = () => view.dispatch(view.state.tr.setSelection(TextSelection.create(doc, 2)));
    window.addEventListener("mouseup", native, { once: true });
    window.dispatchEvent(new MouseEvent("mouseup", { cancelable: true }));
    await Promise.resolve();
    const click = new MouseEvent("click", { bubbles: true, cancelable: true });
    view.dom.dispatchEvent(click);
    expect(click.defaultPrevented).toBe(true);
    expect(view.state.selection.eq(accepted)).toBe(true);
    expect(view.state.doc).toBe(doc);
  },
);

it("returning to a nested selector releases the document fence", async () => {
  const { position, element } = mount("latexRichPreview");
  pointer(element.querySelector("textarea")!, "pointerdown", element);
  handoff(position);
  setLatexObjectDragSelection(view, null);
  const returned = TextSelection.create(view.state.doc, 2);
  view.dispatch(view.state.tr.setSelection(returned));
  pointer(window, "pointerup", element);
  window.dispatchEvent(new MouseEvent("mouseup", { cancelable: true }));
  await Promise.resolve();
  expect(view.state.selection.eq(returned)).toBe(true);
});

it("returning inside on release does not replay the preceding outside range", async () => {
  const { position, element } = mount("latexRichPreview");
  pointer(element.querySelector("textarea")!, "pointerdown", element);
  handoff(position);
  pointer(window, "pointerup", element);
  // The embedded owner's release handler runs after the document listener.
  setLatexObjectDragSelection(view, null);
  const returned = TextSelection.create(view.state.doc, 2);
  view.dispatch(view.state.tr.setSelection(returned));
  window.dispatchEvent(new MouseEvent("mouseup", { cancelable: true }));
  await Promise.resolve();
  expect(view.state.selection.eq(returned)).toBe(true);
});

it("a newer pointer gesture cancels queued mouse-release restoration", async () => {
  const { position, element } = mount("latexDisplayMath");
  pointer(element.querySelector("textarea")!, "pointerdown", element);
  handoff(position);
  pointer(window, "pointerup", element);
  window.dispatchEvent(new MouseEvent("mouseup", { cancelable: true }));
  pointer(view.dom.firstElementChild!, "pointerdown", view.dom.firstElementChild!);
  const newer = TextSelection.create(view.state.doc, 2);
  view.dispatch(view.state.tr.setSelection(newer));
  await Promise.resolve();
  expect(view.state.selection.eq(newer)).toBe(true);
});

it("reversing a source-field drag keeps its starting object included", () => {
  const { position, element } = mount("latexRawBlock");
  pointer(element.querySelector("textarea")!, "pointerdown", element);
  pointer(window, "pointermove", view.dom.lastElementChild!);
  expect(view.state.selection.from).toBeLessThanOrEqual(position);
  expect(view.state.selection.to).toBeGreaterThanOrEqual(position + 1);
  pointer(window, "pointermove", view.dom.firstElementChild!);
  expect(view.state.selection.from).toBeLessThanOrEqual(position);
  expect(view.state.selection.to).toBeGreaterThanOrEqual(position + 1);
});

it("release coordinates keep the starting object included without a final move", async () => {
  const { position, element } = mount("latexRawBlock");
  pointer(element.querySelector("textarea")!, "pointerdown", element);
  pointer(window, "pointermove", view.dom.lastElementChild!);
  pointer(window, "pointerup", view.dom.firstElementChild!);
  window.dispatchEvent(new MouseEvent("mouseup", { cancelable: true }));
  await Promise.resolve();
  expect(view.state.selection.from).toBeLessThanOrEqual(position);
  expect(view.state.selection.to).toBeGreaterThanOrEqual(position + 1);
});

it("active and document-selected embedded content stays uncontained", () => {
  const { position, element } = mount("latexRichPreview");
  const field = element.querySelector("textarea")!;
  field.setAttribute("data-scient-active-slot", "");
  expect(getComputedStyle(element).contentVisibility).toBe("visible");
  field.removeAttribute("data-scient-active-slot");
  handoff(position);
  expect(element.hasAttribute("data-latex-document-selection")).toBe(true);
  expect(getComputedStyle(element).contentVisibility).toBe("visible");
});
