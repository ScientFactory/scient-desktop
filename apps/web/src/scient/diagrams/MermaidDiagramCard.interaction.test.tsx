// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { ComposerHandleContext, type ComposerHandleRef } from "~/composerHandleContext";
import { toastManager } from "~/components/ui/toast";
import { MermaidDiagramCard } from "./MermaidDiagramCard";
import { buildMermaidRepairRequest } from "./mermaidRepair";
import {
  MermaidRenderError,
  renderMermaidDiagram,
  type RenderedMermaidDiagram,
} from "./mermaidRuntime";

vi.mock("../presentation/useNearViewport", () => ({
  useNearViewport: () => ({ ref: null, isNearViewport: true }),
}));
vi.mock("~/components/ui/toast", () => ({ toastManager: { add: vi.fn() } }));
vi.mock("./mermaidRuntime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./mermaidRuntime")>()),
  renderMermaidDiagram: vi.fn(),
}));

function pendingRender() {
  let resolve!: (result: RenderedMermaidDiagram) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<RenderedMermaidDiagram>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

describe("Mermaid error recovery", () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;
  let draft: string;
  let composer: ComposerHandleRef;
  const diagnostic = "Parse error on line 2:\nA[\n ^\nExpected closing bracket";
  const source = "flowchart LR\nA[";
  const writeText = vi.fn();

  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    writeText.mockReset().mockResolvedValue(undefined);
    vi.mocked(toastManager.add).mockReset();
    vi.mocked(renderMermaidDiagram)
      .mockReset()
      .mockRejectedValue(new MermaidRenderError(new Error(diagnostic)));
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    draft = "An existing draft";
    composer = {
      current: {
        readSnapshot: () => ({ value: draft }),
        insertTextAtEnd: vi.fn((text: string) => {
          draft += text;
          return true;
        }),
        focusAtEnd: vi.fn(),
      },
    } as unknown as ComposerHandleRef;
  });
  afterEach(async () => {
    await act(() => root.unmount());
    container.remove();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });
  async function render(text = source, theme: "light" | "dark" = "light", withComposer = true) {
    await act(() =>
      root.render(
        <ComposerHandleContext value={withComposer ? composer : null}>
          <MermaidDiagramCard source={text} language="mermaid" title={null} theme={theme} />
        </ComposerHandleContext>,
      ),
    );
  }
  function button(label: string) {
    const found = [...container.querySelectorAll("button")].find(
      (item) => item.getAttribute("aria-label") === label || item.textContent === label,
    );
    expect(found, label).toBeDefined();
    return found!;
  }
  async function menuAction(label: string) {
    await act(() => button("More diagram actions").click());
    const item = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(
      (node) => node.textContent === label,
    );
    expect(item, label).toBeDefined();
    await act(() => item!.click());
  }

  it("offers a reviewable request and preserves the original diagram and draft", async () => {
    await render();
    const ask = button("Ask agent to fix");
    await act(() => ask.click());
    await act(() => ask.click());
    expect(draft).toBe(`An existing draft\n\n${buildMermaidRepairRequest(source, diagnostic)}`);
    expect(composer.current!.insertTextAtEnd).toHaveBeenCalledTimes(1);
    expect(container.textContent).not.toContain("Request added");
    expect(toastManager.add).not.toHaveBeenCalled();
    expect(container.textContent).toContain(source);
    expect(renderMermaidDiagram).toHaveBeenCalledTimes(1);
  });

  it("copies the same full diagnostic and source even outside a composer", async () => {
    await render(source, "light", false);
    expect(container.querySelector('[aria-label="Ask agent to fix"]')).toBeNull();
    await act(() => button("Copy error and source").click());
    expect(writeText).toHaveBeenCalledWith(buildMermaidRepairRequest(source, diagnostic));
    expect(container.textContent).toContain("Error and source copied");
  });

  it("reports unavailable composer and rejected clipboard without losing source", async () => {
    composer.current = null;
    writeText.mockRejectedValue(new Error("permission denied"));
    await render();
    await act(() => button("Ask agent to fix").click());
    expect(toastManager.add).toHaveBeenCalledWith(
      expect.objectContaining({ title: "The composer is unavailable right now." }),
    );
    await act(() => button("Copy error and source").click());
    expect(toastManager.add).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Unable to copy the error and source." }),
    );
    expect(container.textContent).not.toContain("Unable to copy");
    expect(draft).toBe("An existing draft");
    expect(container.textContent).toContain(source);
  });

  it("keeps the editable error source mounted throughout correction and retry", async () => {
    const cleanup = vi.fn();
    const editor = { open: false, mount: vi.fn(() => cleanup) };
    const renderEditor = async (text: string) => {
      await act(() =>
        root.render(
          <MermaidDiagramCard
            source={text}
            sourceEditor={editor}
            language="mermaid"
            title={null}
            theme="light"
          />,
        ),
      );
    };
    await renderEditor(source);
    expect(editor.mount).toHaveBeenCalledTimes(1);
    const pending = pendingRender();
    vi.mocked(renderMermaidDiagram).mockReturnValueOnce(pending.promise);
    await renderEditor(`${source}correcting`);
    expect(cleanup).not.toHaveBeenCalled();
    expect(editor.mount).toHaveBeenCalledTimes(1);
    await act(() => pending.reject(new MermaidRenderError(new Error("Still incomplete"))));
    expect(cleanup).not.toHaveBeenCalled();
    await menuAction("Retry");
    expect(editor.mount).toHaveBeenCalledTimes(1);
  });

  it("handles unavailable clipboard and settling a render after unmount", async () => {
    await render();
    vi.stubGlobal("navigator", {});
    await act(() => button("Copy error and source").click());
    expect(toastManager.add).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Clipboard access is unavailable." }),
    );
    const pending = pendingRender();
    vi.mocked(renderMermaidDiagram).mockReturnValueOnce(pending.promise);
    await render(`${source}next`);
    await act(() => root.render(null));
    await act(() => pending.reject(new Error("Late error")));
    expect(container.textContent).toBe("");
  });

  it.each(["source", "theme", "retry"] as const)(
    "disables stale repair actions during a %s change",
    async (change) => {
      await render();
      const pending = pendingRender();
      vi.mocked(renderMermaidDiagram).mockReturnValueOnce(pending.promise);
      if (change === "retry") await menuAction("Retry");
      else
        await render(
          change === "source" ? `${source}new` : source,
          change === "theme" ? "dark" : "light",
        );
      expect(button("Ask agent to fix").disabled).toBe(true);
      expect(button("Copy error and source").disabled).toBe(true);
      expect(container.textContent).not.toContain("Parse error on line 2");
      await act(() => button("Ask agent to fix").click());
      expect(draft).toBe("An existing draft");
      await act(() => pending.reject(new MermaidRenderError(new Error("New error"))));
      expect(button("Ask agent to fix").disabled).toBe(false);
      await act(() => button("Ask agent to fix").click());
      expect(draft).toContain("New error");
      expect(draft).not.toContain(diagnostic);
    },
  );

  it("keeps copy feedback outside layout and uses compact icon controls beside the error", async () => {
    await render();
    const figure = container.querySelector('[role="figure"]')!;
    const errorRow = container.querySelector('[aria-label="Diagram error"]')!;
    const copy = button("Copy error and source");
    const initialChildren = [...figure.children];
    expect(errorRow.contains(copy)).toBe(true);
    expect(errorRow.contains(button("Ask agent to fix"))).toBe(true);
    expect(copy.textContent).toBe("");
    expect(copy.className).toContain("chat-markdown-chrome-action");
    vi.useFakeTimers();
    await act(() => copy.click());
    expect(copy.querySelector(".lucide-check")).not.toBeNull();
    expect([...figure.children]).toEqual(initialChildren);
    expect(container.querySelector('[aria-live="polite"]')?.className).toBe("sr-only");
    await act(() => vi.advanceTimersByTime(1501));
    expect(copy.querySelector(".lucide-check")).toBeNull();
    expect([...figure.children]).toEqual(initialChildren);
    expect(toastManager.add).not.toHaveBeenCalled();
  });

  it("keeps one fixed-height error line during retry, with no obsolete diagnostic", async () => {
    await render();
    const errorRow = container.querySelector('[aria-label="Diagram error"]')!;
    const summary = errorRow.firstElementChild!;
    const children = [...errorRow.children];
    const pending = pendingRender();
    vi.mocked(renderMermaidDiagram).mockReturnValueOnce(pending.promise);
    await menuAction("Retry");
    expect(container.querySelector('[aria-label="Diagram error"]')).toBe(errorRow);
    expect([...errorRow.children]).toEqual(children);
    expect(summary.textContent).toBe("Rendering diagram…");
    expect(summary.getAttribute("title")).toBeNull();
    expect(summary.className).toContain("truncate");
    await act(() => pending.reject(new MermaidRenderError(new Error(diagnostic))));
    expect([...errorRow.children]).toEqual(children);
    expect(summary.textContent).toBe("Parse error on line 2:");
  });

  it("lets the source menu hide and show the automatic error fallback", async () => {
    await render();
    const sourceContainer = container.querySelector(".scient-mermaid-source")!.parentElement!;
    expect(sourceContainer.hidden).toBe(false);
    await menuAction("Hide source");
    expect(sourceContainer.hidden).toBe(true);
    await menuAction("Show source");
    expect(sourceContainer.hidden).toBe(false);
  });

  it("ignores out-of-order results and removes an old SVG when inputs change", async () => {
    const first = pendingRender();
    const second = pendingRender();
    vi.mocked(renderMermaidDiagram)
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    await render("flowchart LR\nA --> B");
    await render("flowchart LR\nC --> D");
    await act(() =>
      second.resolve({ svg: "<svg><text>Latest diagram</text></svg>", diagramType: "flowchart" }),
    );
    await act(() => first.reject(new Error("Old error")));
    expect(container.textContent).toContain("Latest diagram");
    expect(container.textContent).not.toContain("Old error");
    const third = pendingRender();
    vi.mocked(renderMermaidDiagram).mockReturnValueOnce(third.promise);
    await render("flowchart LR\nC --> D", "dark");
    expect(container.textContent).not.toContain("Latest diagram");
    expect(container.textContent).toContain("Rendering diagram");
    await act(() =>
      third.resolve({ svg: "<svg><text>Dark diagram</text></svg>", diagramType: "flowchart" }),
    );
    expect(container.textContent).toContain("Dark diagram");
  });
});
