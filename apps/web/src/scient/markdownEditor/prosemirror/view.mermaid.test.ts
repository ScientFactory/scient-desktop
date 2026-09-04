// @vitest-environment happy-dom

import { undo } from "@codemirror/commands";
import { EditorView as CodeMirrorEditorView } from "@codemirror/view";
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { renderMermaidDiagram } from "~/scient/diagrams/mermaidRuntime";
import { ScientMarkdownEditorView } from "./view";

vi.mock("~/scient/diagrams/mermaidRuntime", () => ({ renderMermaidDiagram: vi.fn() }));

const broken = "flowchart LR\n  Source --> Editor --> Save ---";
const repaired = "flowchart LR\n  Source --> Editor --> Save";
const markdown = (source: string) =>
  `Before **unchanged**.\n\n\`\`\`mermaid\n${source}\n\`\`\`\n\nAfter.\n`;
const mounted: ScientMarkdownEditorView[] = [];

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("IntersectionObserver", undefined);
  vi.mocked(renderMermaidDiagram).mockImplementation(async (source) => {
    if (source.endsWith("---")) throw new Error("Parse error on line 3");
    return { svg: '<svg aria-label="Repaired diagram" />', diagramType: "flowchart" };
  });
});

afterEach(async () => {
  await act(() => mounted.splice(0).forEach((controller) => controller.destroy()));
  document.body.replaceChildren();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

async function fixture(mode: "write" | "read" = "write") {
  const onUserSourceChange = vi.fn();
  const controller = new ScientMarkdownEditorView({
    source: markdown(broken),
    revision: "synthetic-before",
    mode,
    ariaLabel: "Diagram repair document",
    onUserSourceChange,
  });
  mounted.push(controller);
  const host = document.createElement("div");
  document.body.append(host);
  await act(() => {
    controller.mount(host);
  });
  await vi.waitFor(() => expect(host.textContent).toContain("Unable to render this diagram"));
  return { controller, host, onUserSourceChange };
}

function sourceBox(host: HTMLElement) {
  return host.querySelector<HTMLElement>("pre.scient-mermaid-source");
}

function nestedEditor(host: HTMLElement) {
  const content = host.querySelector<HTMLElement>(".cm-content")!;
  expect(content).not.toBeNull();
  return CodeMirrorEditorView.findFromDOM(content)!;
}

describe("editing a failed Mermaid diagram from its visible source", () => {
  it("repairs through the real nested editor, preserves surrounding Markdown, and supports undo", async () => {
    const { controller, host, onUserSourceChange } = await fixture();
    expect(sourceBox(host)?.textContent).toBe(broken);
    await act(() => sourceBox(host)!.click());
    const editor = nestedEditor(host);
    expect(editor.hasFocus).toBe(true);
    expect(sourceBox(host)).toBeNull();
    expect(host.querySelectorAll(".cm-editor")).toHaveLength(1);
    expect(onUserSourceChange).not.toHaveBeenCalled();

    await act(() =>
      editor.dispatch({ changes: { from: 0, to: editor.state.doc.length, insert: repaired } }),
    );
    expect(controller.session.session.draftSource).toBe(markdown(repaired));
    await vi.waitFor(() =>
      expect(host.querySelector('svg[aria-label="Repaired diagram"]')).not.toBeNull(),
    );
    expect(editor.hasFocus).toBe(true);
    expect(nestedEditor(host)).toBe(editor);
    expect(sourceBox(host)).toBeNull();
    await act(() => {
      expect(undo(editor)).toBe(true);
    });
    expect(controller.session.session.draftSource).toBe(markdown(broken));
  });

  it.each(["Enter", " "])(
    "opens with %j and restores the error source after Escape",
    async (key) => {
      const { controller, host, onUserSourceChange } = await fixture();
      const box = sourceBox(host)!;
      await act(() => {
        box.focus();
        box.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
      });
      const editor = nestedEditor(host);
      expect(editor.hasFocus).toBe(true);
      expect(sourceBox(host)).toBeNull();
      await act(() =>
        editor.contentDOM.dispatchEvent(
          new KeyboardEvent("keydown", {
            key: "Escape",
            bubbles: true,
            cancelable: true,
          }),
        ),
      );
      expect(sourceBox(host)?.textContent).toBe(broken);
      expect(host.querySelector<HTMLElement>(".scient-markdown-code-editor")?.hidden).toBe(true);
      expect(controller.session.session.draftSource).toBe(markdown(broken));
      expect(onUserSourceChange).not.toHaveBeenCalled();
      await act(() => sourceBox(host)!.click());
      expect(nestedEditor(host)).toBe(editor);
      expect(editor.hasFocus).toBe(true);
    },
  );

  it("keeps read mode inert and refreshes the source affordance when switching modes", async () => {
    const { controller, host, onUserSourceChange } = await fixture("read");
    expect(sourceBox(host)?.getAttribute("role")).toBeNull();
    await act(() => sourceBox(host)!.click());
    expect(host.querySelector(".cm-editor")).toBeNull();
    await act(() => controller.setMode("write"));
    expect(sourceBox(host)?.getAttribute("role")).toBe("button");
    await act(() => sourceBox(host)!.click());
    expect(nestedEditor(host).hasFocus).toBe(true);
    await act(() => controller.setMode("read"));
    expect(sourceBox(host)?.getAttribute("role")).toBeNull();
    expect(sourceBox(host)?.textContent).toBe(broken);
    expect(host.querySelector<HTMLElement>(".scient-markdown-code-editor")?.hidden).toBe(true);
    expect(onUserSourceChange).not.toHaveBeenCalled();
  });
});
