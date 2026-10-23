import { Schema, type NodeSpec } from "@tiptap/pm/model";
import { EditorState, TextSelection } from "@tiptap/pm/state";
import { EditorView } from "@tiptap/pm/view";
import { expect, it } from "vite-plus/test";
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

async function _cleanupFixture0(_fixture: _Fixture) {
  _fixture.view?.destroy();
  _fixture.host?.remove();
}
function mount(_fixture: _Fixture, name: string) {
  _fixture.host = document.createElement("div");
  _fixture.host.className = "scient-latex-visual-workspace";
  _fixture.host.style.cssText = "width:600px;position:relative;";
  document.body.append(_fixture.host);
  const paragraph = (text: string) => schema.node("paragraph", null, schema.text(text));
  const before = paragraph("Before text.");
  const doc = schema.node("doc", null, [before, schema.node(name), paragraph("After text.")]);
  _fixture.view = new EditorView(_fixture.host, {
    state: EditorState.create({ schema, doc, plugins: [latexDocumentObjectSelection()] }),
    attributes: { class: "scient-latex-visual-document" },
    dispatchTransaction: (tr) => _fixture.view.updateState(_fixture.view.state.apply(tr)),
  });
  const position = before.nodeSize;
  const element = _fixture.view.nodeDOM(position) as HTMLElement;
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
function handoff(_fixture: _Fixture, position: number) {
  const selection = TextSelection.create(_fixture.view.state.doc, position - 1, position + 3);
  setLatexObjectDragSelection(_fixture.view, selection);
  _fixture.view.dispatch(_fixture.view.state.tr.setSelection(selection));
  return selection;
}

it.each(["latexRichPreview", "latexDisplayMath"])(
  "%s handoff survives native mouse release and its trailing click",
  async (name) => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture0(_fixture));

    const { position, element } = mount(_fixture, name);
    pointer(element.querySelector("textarea")!, "pointerdown", element);
    const accepted = handoff(_fixture, position);
    const doc = _fixture.view.state.doc;
    pointer(window, "pointerup", element);
    // A native mouse tracker can finish after the window's capture listener.
    const native = () =>
      _fixture.view.dispatch(_fixture.view.state.tr.setSelection(TextSelection.create(doc, 2)));
    window.addEventListener("mouseup", native, { once: true });
    window.dispatchEvent(new MouseEvent("mouseup", { cancelable: true }));
    await Promise.resolve();
    const click = new MouseEvent("click", { bubbles: true, cancelable: true });
    _fixture.view.dom.dispatchEvent(click);
    expect(click.defaultPrevented).toBe(true);
    expect(_fixture.view.state.selection.eq(accepted)).toBe(true);
    expect(_fixture.view.state.doc).toBe(doc);
  },
);

it("returning to a nested selector releases the document fence", async () => {
  await using _fixture = _createFixture();
  _fixture.cleanup.defer(() => _cleanupFixture0(_fixture));

  const { position, element } = mount(_fixture, "latexRichPreview");
  pointer(element.querySelector("textarea")!, "pointerdown", element);
  handoff(_fixture, position);
  setLatexObjectDragSelection(_fixture.view, null);
  const returned = TextSelection.create(_fixture.view.state.doc, 2);
  _fixture.view.dispatch(_fixture.view.state.tr.setSelection(returned));
  pointer(window, "pointerup", element);
  window.dispatchEvent(new MouseEvent("mouseup", { cancelable: true }));
  await Promise.resolve();
  expect(_fixture.view.state.selection.eq(returned)).toBe(true);
});

it("returning inside on release does not replay the preceding outside range", async () => {
  await using _fixture = _createFixture();
  _fixture.cleanup.defer(() => _cleanupFixture0(_fixture));

  const { position, element } = mount(_fixture, "latexRichPreview");
  pointer(element.querySelector("textarea")!, "pointerdown", element);
  handoff(_fixture, position);
  pointer(window, "pointerup", element);
  // The embedded owner's release handler runs after the document listener.
  setLatexObjectDragSelection(_fixture.view, null);
  const returned = TextSelection.create(_fixture.view.state.doc, 2);
  _fixture.view.dispatch(_fixture.view.state.tr.setSelection(returned));
  window.dispatchEvent(new MouseEvent("mouseup", { cancelable: true }));
  await Promise.resolve();
  expect(_fixture.view.state.selection.eq(returned)).toBe(true);
});

it("a newer pointer gesture cancels queued mouse-release restoration", async () => {
  await using _fixture = _createFixture();
  _fixture.cleanup.defer(() => _cleanupFixture0(_fixture));

  const { position, element } = mount(_fixture, "latexDisplayMath");
  pointer(element.querySelector("textarea")!, "pointerdown", element);
  handoff(_fixture, position);
  pointer(window, "pointerup", element);
  window.dispatchEvent(new MouseEvent("mouseup", { cancelable: true }));
  pointer(
    _fixture.view.dom.firstElementChild!,
    "pointerdown",
    _fixture.view.dom.firstElementChild!,
  );
  const newer = TextSelection.create(_fixture.view.state.doc, 2);
  _fixture.view.dispatch(_fixture.view.state.tr.setSelection(newer));
  await Promise.resolve();
  expect(_fixture.view.state.selection.eq(newer)).toBe(true);
});

it("reversing a source-field drag keeps its starting object included", async () => {
  await using _fixture = _createFixture();
  _fixture.cleanup.defer(() => _cleanupFixture0(_fixture));

  const { position, element } = mount(_fixture, "latexRawBlock");
  pointer(element.querySelector("textarea")!, "pointerdown", element);
  pointer(window, "pointermove", _fixture.view.dom.lastElementChild!);
  expect(_fixture.view.state.selection.from).toBeLessThanOrEqual(position);
  expect(_fixture.view.state.selection.to).toBeGreaterThanOrEqual(position + 1);
  pointer(window, "pointermove", _fixture.view.dom.firstElementChild!);
  expect(_fixture.view.state.selection.from).toBeLessThanOrEqual(position);
  expect(_fixture.view.state.selection.to).toBeGreaterThanOrEqual(position + 1);
});

it("release coordinates keep the starting object included without a final move", async () => {
  await using _fixture = _createFixture();
  _fixture.cleanup.defer(() => _cleanupFixture0(_fixture));

  const { position, element } = mount(_fixture, "latexRawBlock");
  pointer(element.querySelector("textarea")!, "pointerdown", element);
  pointer(window, "pointermove", _fixture.view.dom.lastElementChild!);
  pointer(window, "pointerup", _fixture.view.dom.firstElementChild!);
  window.dispatchEvent(new MouseEvent("mouseup", { cancelable: true }));
  await Promise.resolve();
  expect(_fixture.view.state.selection.from).toBeLessThanOrEqual(position);
  expect(_fixture.view.state.selection.to).toBeGreaterThanOrEqual(position + 1);
});

it("active and document-selected embedded content stays uncontained", async () => {
  await using _fixture = _createFixture();
  _fixture.cleanup.defer(() => _cleanupFixture0(_fixture));

  const { position, element } = mount(_fixture, "latexRichPreview");
  const field = element.querySelector("textarea")!;
  field.setAttribute("data-scient-active-slot", "");
  expect(getComputedStyle(element).contentVisibility).toBe("visible");
  field.removeAttribute("data-scient-active-slot");
  handoff(_fixture, position);
  expect(element.hasAttribute("data-latex-document-selection")).toBe(true);
  expect(getComputedStyle(element).contentVisibility).toBe("visible");
});

function _createFixture() {
  const stack = new AsyncDisposableStack();
  const cleanup = new AsyncDisposableStack();
  return {
    view: undefined! as EditorView,
    host: undefined! as HTMLElement,
    stack,
    cleanup,
    async [Symbol.asyncDispose]() {
      try {
        await cleanup.disposeAsync();
      } finally {
        await stack.disposeAsync();
      }
    },
  };
}
type _Fixture = ReturnType<typeof _createFixture>;
