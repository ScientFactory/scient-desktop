import "../../../index.css";

import { EditorView as CodeMirrorEditorView } from "@codemirror/view";
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { userEvent } from "vitest/browser";

import { renderMermaidDiagram } from "~/scient/diagrams/mermaidRuntime";
import { createScientNestedCodeEditor } from "../nodes/codeMirrorCodeEditor";
import { ScientMarkdownEditorView } from "./view";

// Browser ESM retains the real exports without awaiting an importOriginal
// factory across mermaidRuntime <-> isolatedMermaid's module cycle.
vi.mock("~/scient/diagrams/mermaidRuntime", { spy: true });
vi.mock("../nodes/codeMirrorCodeEditor", { spy: true });

const broken = "flowchart LR\n  Source --> Editor --> Save ---";
const repaired = "flowchart LR\n  Source --> Editor --> Save";
const markdown = (source: string) =>
  `Before **unchanged**.\n\n\`\`\`mermaid\n${source}\n\`\`\`\n\nAfter.\n`;
const mounted: ScientMarkdownEditorView[] = [];

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
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

async function fixture(mode: "write" | "read" = "write", source = broken) {
  const onUserSourceChange = vi.fn();
  const showRichFenceContextMenu = vi.fn(async () => null);
  const controller = new ScientMarkdownEditorView({
    source: markdown(source),
    revision: "synthetic-before",
    mode,
    ariaLabel: "Diagram repair document",
    onUserSourceChange,
    showRichFenceContextMenu,
  });
  mounted.push(controller);
  const host = document.createElement("div");
  host.style.cssText = "width:380px;margin:20px";
  document.body.append(host);
  await act(() => {
    controller.mount(host);
  });
  await vi.waitFor(() =>
    source === broken
      ? expect(host.querySelector('[aria-label="Diagram error"]')).not.toBeNull()
      : expect(host.querySelector('svg[aria-label="Repaired diagram"]')).not.toBeNull(),
  );
  return { controller, host, onUserSourceChange, showRichFenceContextMenu };
}

function sourceBox(host: HTMLElement) {
  return host.querySelector<HTMLElement>(".scient-markdown-code-editor")!;
}

function nestedEditor(host: HTMLElement) {
  const content = host.querySelector<HTMLElement>(".cm-content")!;
  expect(content).not.toBeNull();
  return CodeMirrorEditorView.findFromDOM(content)!;
}

async function clickText(editor: CodeMirrorEditorView, position: number) {
  await expect.poll(() => editor.coordsAtPos(position)).not.toBeNull();
  const cursor = editor.coordsAtPos(position)!;
  const content = editor.contentDOM.getBoundingClientRect();
  await act(async () => {
    await userEvent.click(editor.contentDOM, {
      position: {
        x: cursor.left - content.left,
        y: (cursor.top + cursor.bottom) / 2 - content.top,
      },
    });
  });
}

async function escape(_editor: CodeMirrorEditorView) {
  await act(async () => {
    await userEvent.keyboard("{Escape}");
  });
}

async function key(editor: CodeMirrorEditorView, name: string, gesture: string) {
  let event: KeyboardEvent | undefined;
  const record = (received: KeyboardEvent) => {
    if (received.key === name) event = received;
  };
  editor.contentDOM.addEventListener("keydown", record);
  try {
    await act(async () => {
      await userEvent.keyboard(gesture);
    });
    expect(event).toBeDefined();
    return event!;
  } finally {
    editor.contentDOM.removeEventListener("keydown", record);
  }
}

describe("persistent Mermaid source editing", () => {
  it("places the first-click cursor in the existing box and edits in the middle without replacing it", async () => {
    const { controller, host, onUserSourceChange } = await fixture();
    const box = sourceBox(host);
    const parent = box.parentElement;
    const wrapper = parent!.parentElement!;
    const wrapperClass = wrapper.className;
    const editor = nestedEditor(host);
    expect(box.closest(".scient-mermaid-card")).not.toBeNull();
    expect(box.hidden).toBe(false);
    expect(editor.hasFocus).toBe(false);
    expect(host.querySelector("pre.scient-mermaid-source")).toBeNull();
    const position = broken.indexOf("Editor") + 3;
    await clickText(editor, position);
    expect(editor.hasFocus).toBe(true);
    expect(editor.state.selection.main.head).toBe(position);
    expect(sourceBox(host)).toBe(box);
    expect(box.parentElement).toBe(parent);
    expect(wrapper.className).toBe(wrapperClass);
    expect(onUserSourceChange).not.toHaveBeenCalled();
    await act(async () => {
      await userEvent.keyboard("X");
    });
    expect(controller.session.session.draftSource).toBe(
      markdown(broken.slice(0, position) + "X" + broken.slice(position)),
    );
    await escape(editor);
    expect(box.hidden).toBe(false);
    expect(sourceBox(host)).toBe(box);
    expect(box.parentElement).toBe(parent);
    await clickText(editor, 5);
    expect(editor.state.selection.main.head).toBe(5);
    expect(nestedEditor(host)).toBe(editor);
  });

  it("retains the same focused source surface through repair, another parse failure, and undo", async () => {
    const { controller, host } = await fixture();
    const box = sourceBox(host);
    const parent = box.parentElement;
    const editor = nestedEditor(host);
    await clickText(editor, broken.length);
    await act(async () => {
      await userEvent.keyboard("{Backspace}{Backspace}{Backspace}{Backspace}");
    });
    expect(controller.session.session.draftSource).toBe(markdown(repaired));
    await vi.waitFor(() =>
      expect(host.querySelector('svg[aria-label="Repaired diagram"]')).not.toBeNull(),
    );
    expect(editor.hasFocus).toBe(true);
    expect(nestedEditor(host)).toBe(editor);
    expect(box.parentElement).toBe(parent);
    expect(host.querySelectorAll(".cm-editor")).toHaveLength(1);
    const undo = await key(editor, "z", "{ControlOrMeta>}z{/ControlOrMeta}");
    expect(undo.defaultPrevented).toBe(true);
    expect(controller.session.session.draftSource).toBe(markdown(broken));
    await vi.waitFor(() =>
      expect(host.textContent).toContain("Preview kept at the last valid version"),
    );
    expect(editor.hasFocus).toBe(true);
    expect(box.parentElement).toBe(parent);
  });

  it("uses native keyboard editing and keeps the same box across read/write mode changes", async () => {
    const { controller, host, onUserSourceChange } = await fixture("read");
    const box = sourceBox(host);
    const editor = nestedEditor(host);
    expect(editor.contentDOM.getAttribute("contenteditable")).toBe("false");
    await act(() => controller.setMode("write"));
    await clickText(editor, 0);
    expect(editor.hasFocus).toBe(true);
    expect(editor.contentDOM.getAttribute("contenteditable")).toBe("true");
    const enter = await key(editor, "Enter", "{Enter}");
    expect(enter.defaultPrevented).toBe(true);
    expect(editor.state.doc.toString()).toBe("\n" + broken);
    await escape(editor);
    expect(box.hidden).toBe(false);
    await act(() => controller.setMode("read"));
    expect(editor.contentDOM.getAttribute("contenteditable")).toBe("false");
    expect(nestedEditor(host)).toBe(editor);
    expect(sourceBox(host)).toBe(box);
    expect(onUserSourceChange).toHaveBeenCalledOnce();
  });

  it("keeps the native text context menu inside the source editor", async () => {
    const { host, showRichFenceContextMenu } = await fixture();
    const editor = nestedEditor(host);
    let nativeContext: MouseEvent | undefined;
    const record = (event: MouseEvent) => {
      nativeContext = event;
    };
    editor.contentDOM.addEventListener("contextmenu", record);
    await userEvent.click(editor.contentDOM, { button: "right" });
    editor.contentDOM.removeEventListener("contextmenu", record);
    expect(nativeContext).toBeDefined();
    expect(nativeContext!.defaultPrevented).toBe(false);
    expect(showRichFenceContextMenu).not.toHaveBeenCalled();
    await act(async () => {
      await userEvent.click(host.querySelector<HTMLElement>(".scient-mermaid-card")!, {
        button: "right",
        position: { x: 10, y: 10 },
      });
    });
    expect(showRichFenceContextMenu).toHaveBeenCalledOnce();
  });

  it("opens valid diagram source from More and reuses it on reopening", async () => {
    const { host, onUserSourceChange } = await fixture("write", repaired);
    expect(host.querySelector(".cm-editor")).toBeNull();
    const openFromMenu = async () => {
      await act(async () => {
        await userEvent.click(
          host.querySelector<HTMLButtonElement>('[aria-label="More diagram actions"]')!,
        );
      });
      await act(async () => {
        await userEvent.click(
          [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(
            (item) => item.textContent === "Edit source",
          )!,
        );
      });
    };
    await openFromMenu();
    const editor = nestedEditor(host);
    expect(sourceBox(host).closest(".scient-mermaid-card")).not.toBeNull();
    expect(editor.hasFocus).toBe(true);
    await escape(editor);
    expect(sourceBox(host).hidden).toBe(true);
    await openFromMenu();
    expect(nestedEditor(host)).toBe(editor);
    expect(editor.hasFocus).toBe(true);
    expect(onUserSourceChange).not.toHaveBeenCalled();
  });

  it.each(["write", "read"] as const)(
    "keeps source readable and retries a failed editor in the same slot (%s)",
    async (mode) => {
      vi.mocked(createScientNestedCodeEditor).mockImplementationOnce(() => {
        throw new Error("Editor unavailable");
      });
      const { host, onUserSourceChange } = await fixture(mode);
      const box = sourceBox(host);
      const parent = box.parentElement;
      expect(box.hidden).toBe(false);
      expect(box.textContent).toBe(broken);
      await act(async () => {
        await userEvent.click(
          host.querySelector<HTMLButtonElement>('[aria-label="Retry code editor"]')!,
        );
      });
      expect(sourceBox(host)).toBe(box);
      expect(box.parentElement).toBe(parent);
      expect(nestedEditor(host).state.doc.toString()).toBe(broken);
      expect(onUserSourceChange).not.toHaveBeenCalled();
    },
  );
});
