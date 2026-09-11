// @vitest-environment happy-dom
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { EditorView as CodeMirrorView } from "@codemirror/view";
import {
  captureMarkdownCitation,
  createMarkdownCitation,
  markdownCitationDomRange,
} from "./markdownCitation";
import { ScientMarkdownEditorView } from "./prosemirror/view";
import { revealMarkdownCitation } from "./markdownCitationReveal";

const source = {
  environmentId: EnvironmentId.make("local"),
  threadId: ThreadId.make("thread"),
  cwd: "/project",
  path: "test.md",
};
const mounted: ScientMarkdownEditorView[] = [];
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
});
afterEach(async () => {
  await act(() => mounted.splice(0).forEach((controller) => controller.destroy()));
  document.body.replaceChildren();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
async function mount(text: string) {
  const onUserSourceChange = vi.fn();
  const controller = new ScientMarkdownEditorView({
    source: text,
    revision: "fixture",
    mode: "write",
    ariaLabel: "Markdown",
    onUserSourceChange,
  });
  mounted.push(controller);
  const host = document.createElement("div");
  document.body.append(host);
  await act(() => {
    controller.mount(host);
  });
  return { controller, view: controller.view!, onUserSourceChange };
}
function select(first: Node, firstOffset: number, last: Node, lastOffset: number) {
  const range = document.createRange();
  range.setStart(first, firstOffset);
  range.setEnd(last, lastOffset);
  const selection = window.getSelection()!;
  selection.removeAllRanges();
  selection.addRange(range);
  return selection;
}

describe("Markdown citation in the mounted editor", () => {
  it("does not substitute a rendered chart's hidden source for a cross-block selection", async () => {
    const { controller, view } = await mount("Before.\n\n```text\nHidden source\n```\n\nAfter.\n");
    // The node view uses this marker when a rich renderer replaces its source.
    view.dom
      .querySelector("[data-scient-markdown-code-block]")!
      .setAttribute("data-scient-markdown-rich-fence", "mermaid");
    const paragraphs = view.dom.querySelectorAll("p");
    const selection = select(paragraphs[0]!.firstChild!, 0, paragraphs[1]!.firstChild!, 6);
    expect(captureMarkdownCitation(controller, source, selection)).toBeNull();
    expect(controller.createSaveIntent()).toBeNull();
  });
  it("captures a native selection across inline markup without changing source/history", async () => {
    const { controller, view, onUserSourceChange } = await mount("An **important** sentence.\n");
    const first = view.dom.querySelector("strong")!.firstChild!;
    const last = view.dom.querySelector("p")!.lastChild!;
    const selection = select(first, 0, last, 9);
    const before = controller.session.session;
    const doc = view.state.doc;
    const captured = captureMarkdownCitation(controller, source, selection)!;
    expect(captured.citation.text).toBe("important sentence");
    expect(captured.citation.path).toBe("test.md");
    expect(captured.sourceAnchor.range.toString()).toBe("important sentence");
    expect(captured.sourceAnchor.resolveRange()?.toString()).toBe("important sentence");
    expect(view.state.doc).toBe(doc);
    expect(controller.session.session).toBe(before);
    expect(controller.createSaveIntent()).toBeNull();
    expect(onUserSourceChange).not.toHaveBeenCalled();
  });

  it("captures text in table cells", async () => {
    const { controller, view } = await mount("| A | B |\n|---|---|\n| Alpha | Beta |\n");
    const cells = view.dom.querySelectorAll("td");
    const captured = captureMarkdownCitation(
      controller,
      source,
      select(cells[0]!.firstChild!, 0, cells[1]!.firstChild!, 4),
    );
    expect(captured?.citation.text).toBe("Alpha\nBeta");
    expect(captured?.citation.endLine).toBe(3);
  });

  it("reads a partial selection from the real nested CodeMirror, not the whole node", async () => {
    const { controller, view, onUserSourceChange } = await mount(
      "```text\nzero\n  one\n  two\nlast\n```\n",
    );
    const codeDom = view.dom.querySelector<HTMLElement>(".cm-editor")!;
    const code = CodeMirrorView.findFromDOM(codeDom)!;
    expect(code).not.toBeNull();
    await act(() => {
      code.dispatch({ selection: { anchor: 5, head: 16 } });
    });
    const first = code.domAtPos(5);
    const last = code.domAtPos(16);
    const captured = captureMarkdownCitation(
      controller,
      source,
      select(first.node, first.offset, last.node, last.offset),
    );
    expect(captured?.citation.text).toBe("  one\n  two");
    expect(captured?.citation.from).toBe(6);
    expect(captured?.citation.to).toBe(17);
    expect(controller.createSaveIntent()).toBeNull();
    expect(onUserSourceChange).not.toHaveBeenCalled();
  });

  it("rejects a cross-surface selection or controls", async () => {
    const { controller, view } = await mount("Only this document.\n");
    const outside = document.createTextNode("Other surface");
    document.body.append(outside);
    const inside = view.dom.querySelector("p")!.firstChild!;
    expect(captureMarkdownCitation(controller, source, select(inside, 0, outside, 5))).toBeNull();
    const button = document.createElement("button");
    button.textContent = "Control";
    view.dom.append(button);
    const range = document.createRange();
    range.selectNodeContents(button);
    const selectedControl = {
      rangeCount: 1,
      isCollapsed: false,
      getRangeAt: () => range,
    } as unknown as Selection;
    expect(captureMarkdownCitation(controller, source, selectedControl) === null).toBe(true);
  });

  it("invalidates the live comment anchor when document text changes", async () => {
    const { controller, view } = await mount("Original sentence.\n");
    const node = view.dom.querySelector("p")!.firstChild!;
    const captured = captureMarkdownCitation(controller, source, select(node, 0, node, 8))!;
    await act(() => {
      view.dispatch(view.state.tr.insertText("New ", 1));
    });
    expect(captured.sourceAnchor.resolveRange()).toBeNull();
    expect(captured.citation.text).toBe("Original");
  });

  it("reveals using a highlight without replacing selection or creating a save", async () => {
    const { controller, view, onUserSourceChange } = await mount("Quoted paragraph.\n");
    const citation = createMarkdownCitation(controller.session, source, 1, 7)!;
    const selection = view.state.selection;
    const before = controller.session.session;
    const scroll = vi.spyOn(HTMLElement.prototype, "scrollIntoView").mockImplementation(() => {});
    const pending: FrameRequestCallback[] = [];
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      pending.push(callback);
      return pending.length;
    });
    vi.stubGlobal("cancelAnimationFrame", vi.fn());
    const stop = revealMarkdownCitation(controller, citation);
    pending.splice(0).forEach((callback) => callback(0));
    expect(scroll).toHaveBeenCalled();
    expect(markdownCitationDomRange(controller, citation)?.toString()).toBe("Quoted");
    expect(view.state.selection).toBe(selection);
    expect(controller.session.session).toBe(before);
    expect(onUserSourceChange).not.toHaveBeenCalled();
    stop();
  });
});
