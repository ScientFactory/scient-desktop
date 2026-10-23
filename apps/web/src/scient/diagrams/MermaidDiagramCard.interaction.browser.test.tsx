import {
  render as _fixtureRender,
  type Screen,
  stubGlobal as _fixtureStubGlobal,
  fakeTimers as _fixtureFakeTimers,
  act,
} from "../../../test/render";
import "../../index.css";
import { createRef } from "react";
import { EnvironmentId, MessageId, ThreadId, type AssistantCitation } from "@t3tools/contracts";
import { collectAssistantCitations } from "@t3tools/shared/assistantCitations";

import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { ComposerHandleContext, type ComposerHandleRef } from "~/composerHandleContext";
import { toastManager } from "~/components/ui/toast";
import { AssistantCitationSource } from "~/components/chat/AssistantCitationSource";
import { formatAssistantCitationForComposer } from "~/composer-logic";
import { getSyntaxHighlighterPromise } from "~/lib/syntaxHighlighting";
import { MermaidDiagramCard } from "./MermaidDiagramCard";
import { prepareSvgForExport } from "./mermaidExport";
import { downloadPresentationBlob } from "../presentation/presentationExport";
import { copyPngBlobToClipboard } from "../presentation/imageClipboard";
import { loadCanvasImage } from "../presentation/loadCanvasImage";
import { buildMermaidRepairRequest } from "./mermaidRepair";
import { planMermaidRecovery } from "./mermaidRecovery";
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

vi.mock(import("../presentation/presentationExport"), async (original) => ({
  ...(await original()),
  downloadPresentationBlob: vi.fn(),
}));
vi.mock(import("../presentation/imageClipboard"), () => ({
  copyPngBlobToClipboard: vi.fn(),
}));
vi.mock(import("../presentation/loadCanvasImage"), async (original) => {
  const actual = await original();
  return { ...actual, loadCanvasImage: vi.fn(actual.loadCanvasImage) };
});

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
  let draft: string;

  const diagnostic = "Parse error on line 2:\nA[\n ^\nExpected closing bracket";
  const source = "flowchart LR\nA[";
  const writeText = vi.fn();

  async function _setupFixture0(_fixture: _Fixture) {
    _fixture.stack.use(_fixtureStubGlobal("navigator", { clipboard: { writeText } }));
    writeText.mockReset().mockResolvedValue(undefined);
    vi.mocked(downloadPresentationBlob).mockReset();
    vi.mocked(copyPngBlobToClipboard).mockReset().mockResolvedValue(undefined);
    vi.mocked(loadCanvasImage).mockClear();
    vi.mocked(toastManager.add).mockReset();
    vi.mocked(renderMermaidDiagram)
      .mockReset()
      .mockRejectedValue(new MermaidRenderError(new Error(diagnostic)));
    _fixture.container = document.createElement("div");
    document.body.append(_fixture.container);
    _fixture.root0 = _fixture.stack.use(
      await _fixtureRender(null, { container: _fixture.container, router: false }),
    );
    draft = "An existing draft";
    _fixture.composer = {
      current: {
        readSnapshot: () => ({ value: draft }),
        citeAssistantText: vi.fn((citation: AssistantCitation) => {
          draft += ` ${formatAssistantCitationForComposer(citation, citation.comment)}`;
          return true;
        }),
        focusAtEnd: vi.fn(),
      },
    } as unknown as ComposerHandleRef;
  }
  async function _cleanupFixture1(_fixture: _Fixture) {
    await act(async () => await _fixture.root0.unmount());
    _fixture.container.remove();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  }
  async function render(
    _fixture: _Fixture,
    text = source,
    theme: "light" | "dark" = "light",
    withComposer = true,
  ) {
    await act(
      async () =>
        await _fixture.root0.rerender(
          <ComposerHandleContext value={withComposer ? _fixture.composer : null}>
            <div data-assistant-citation-viewport>
              <AssistantCitationSource
                messageId={MessageId.make("assistant")}
                threadRef={{
                  environmentId: EnvironmentId.make("local"),
                  threadId: ThreadId.make("thread"),
                }}
                itemKey="assistant"
                listRef={createRef()}
                request={null}
              >
                <MermaidDiagramCard source={text} language="mermaid" title={null} theme={theme} />
              </AssistantCitationSource>
            </div>
          </ComposerHandleContext>,
        ),
    );
  }
  function button(_fixture: _Fixture, label: string) {
    const found = [..._fixture.container.querySelectorAll("button")].find(
      (item) => item.getAttribute("aria-label") === label || item.textContent === label,
    );
    expect(found, label).toBeDefined();
    return found!;
  }
  async function menuAction(_fixture: _Fixture, label: string) {
    await act(() => button(_fixture, "More diagram actions").click());
    const item = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(
      (node) => node.textContent === label,
    );
    expect(item, label).toBeDefined();
    await act(() => item!.click());
  }

  it("offers a reviewable request and preserves the original diagram and draft", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    await render(_fixture);
    const ask = button(_fixture, "Ask agent to fix");
    await act(() => ask.click());
    await act(() => ask.click());
    const citations = collectAssistantCitations(draft);
    expect(citations).toHaveLength(1);
    expect(draft.startsWith("An existing draft ")).toBe(true);
    expect(citations[0]!.citation.text).toBe(source);
    expect(citations[0]!.citation.comment).toContain(diagnostic);
    expect(_fixture.composer.current!.citeAssistantText).toHaveBeenCalledTimes(1);
    expect(_fixture.container.textContent).not.toContain("Request added");
    expect(toastManager.add).not.toHaveBeenCalled();
    expect(_fixture.container.textContent).toContain(source);
    expect(renderMermaidDiagram).toHaveBeenCalledTimes(1);
  });

  it("copies the same full diagnostic and source even outside a composer", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    await render(_fixture, source, "light", false);
    expect(_fixture.container.querySelector('[aria-label="Ask agent to fix"]')).toBeNull();
    await act(() => button(_fixture, "Copy error and source").click());
    expect(writeText).toHaveBeenCalledWith(buildMermaidRepairRequest(source, diagnostic));
    expect(_fixture.container.textContent).toContain("Error and source copied");
  });

  it("cites the shared source block without changing native selection", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    await render(_fixture);
    const nativeSelection = window.getSelection()!;
    const range = document.createRange();
    range.selectNodeContents(_fixture.container.querySelector('[aria-label="Diagram error"]')!);
    nativeSelection.removeAllRanges();
    nativeSelection.addRange(range);
    await act(() => button(_fixture, "Ask agent to fix").click());
    const citation = collectAssistantCitations(draft)[0]!.citation;
    expect(citation.text).toBe(source);
    expect(citation.comment).toContain(diagnostic);
    expect(nativeSelection.getRangeAt(0)).toBe(range);
    expect(toastManager.add).not.toHaveBeenCalled();
    nativeSelection.removeAllRanges();
  });

  it("does not offer a citation action for a document preview sharing a composer", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    await act(
      async () =>
        await _fixture.root0.rerender(
          <ComposerHandleContext value={_fixture.composer}>
            <MermaidDiagramCard source={source} language="mermaid" title={null} theme="light" />
          </ComposerHandleContext>,
        ),
    );
    expect(_fixture.container.querySelector('[aria-label="Ask agent to fix"]')).toBeNull();
    expect(button(_fixture, "Copy error and source")).toBeDefined();
  });

  it("reports unavailable composer and rejected clipboard without losing source", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    _fixture.composer.current = null;
    writeText.mockRejectedValue(new Error("permission denied"));
    await render(_fixture);
    await act(() => button(_fixture, "Ask agent to fix").click());
    expect(toastManager.add).toHaveBeenCalledWith(
      expect.objectContaining({ title: "The composer is unavailable right now." }),
    );
    await act(() => button(_fixture, "Copy error and source").click());
    expect(toastManager.add).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Unable to copy the error and source." }),
    );
    expect(_fixture.container.textContent).not.toContain("Unable to copy");
    expect(draft).toBe("An existing draft");
    expect(_fixture.container.textContent).toContain(source);
  });

  it("keeps the editable error source mounted throughout correction and retry", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    const cleanup = vi.fn();
    const editor = { open: false, mount: vi.fn(() => cleanup) };
    const renderEditor = async (text: string) => {
      await act(
        async () =>
          await _fixture.root0.rerender(
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
    await act(() => button(_fixture, "Retry diagram").click());
    expect(editor.mount).toHaveBeenCalledTimes(1);
  });

  it("handles unavailable clipboard and settling a render after unmount", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    await render(_fixture);
    _fixture.stack.use(_fixtureStubGlobal("navigator", {}));
    await act(() => button(_fixture, "Copy error and source").click());
    expect(toastManager.add).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Clipboard access is unavailable." }),
    );
    const pending = pendingRender();
    vi.mocked(renderMermaidDiagram).mockReturnValueOnce(pending.promise);
    await render(_fixture, `${source}next`);
    await act(async () => await _fixture.root0.rerender(null));
    await act(() => pending.reject(new Error("Late error")));
    expect(_fixture.container.textContent).toBe("");
  });

  it.each(["source", "theme", "retry"] as const)(
    "disables stale repair actions during a %s change",
    async (change) => {
      await using _fixture = _createFixture();
      _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
      await _setupFixture0(_fixture);

      await render(_fixture);
      const pending = pendingRender();
      vi.mocked(renderMermaidDiagram).mockReturnValueOnce(pending.promise);
      if (change === "retry") await act(() => button(_fixture, "Retry diagram").click());
      else
        await render(
          _fixture,
          change === "source" ? `${source}new` : source,
          change === "theme" ? "dark" : "light",
        );
      expect(button(_fixture, "Ask agent to fix").disabled).toBe(true);
      expect(button(_fixture, "Copy error and source").disabled).toBe(true);
      expect(_fixture.container.textContent).not.toContain("Parse error on line 2");
      await act(() => button(_fixture, "Ask agent to fix").click());
      expect(draft).toBe("An existing draft");
      await act(() => pending.reject(new MermaidRenderError(new Error("New error"))));
      expect(button(_fixture, "Ask agent to fix").disabled).toBe(false);
      await act(() => button(_fixture, "Ask agent to fix").click());
      expect(collectAssistantCitations(draft)[0]!.citation.comment).toContain("New error");
      expect(collectAssistantCitations(draft)[0]!.citation.comment).not.toContain(diagnostic);
    },
  );

  it("keeps recovery beside the error and directly above the shared code block", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    await render(_fixture);
    const figure = _fixture.container.querySelector('[role="figure"]')!;
    const errorRow = _fixture.container.querySelector('[aria-label="Diagram error"]')!;
    const toolbar = _fixture.container.querySelector('[aria-label="Diagram recovery"]')!;
    const codeBlock = _fixture.container.querySelector(".chat-markdown-codeblock")!;
    const copy = button(_fixture, "Copy error and source");
    const initialChildren = [...figure.children];
    expect(errorRow.contains(toolbar)).toBe(true);
    expect(toolbar.contains(copy)).toBe(true);
    expect(toolbar.contains(button(_fixture, "Ask agent to fix"))).toBe(true);
    expect(toolbar.contains(button(_fixture, "Retry diagram"))).toBe(true);
    expect(_fixture.container.querySelector('[aria-label="More diagram actions"]')).toBeNull();
    expect(_fixture.container.querySelector('[aria-label="Diagram actions"]')).toBeNull();
    expect(errorRow.nextElementSibling).toBe(codeBlock);
    expect(codeBlock.classList.contains("my-0")).toBe(true);
    expect(codeBlock.className).not.toContain("my-[0.65rem]");
    expect(_fixture.container.querySelector(".scient-mermaid-source")).toBeNull();
    expect(copy.textContent).toBe("");
    expect(copy.tagName).toBe("BUTTON");
    _fixture.stack.use(_fixtureFakeTimers());
    await act(() => copy.click());
    expect(copy.querySelector(".lucide-check")).not.toBeNull();
    expect([...figure.children]).toEqual(initialChildren);
    expect(_fixture.container.querySelector('[aria-live="polite"]')?.className).toBe("sr-only");
    await act(() => vi.advanceTimersByTime(1501));
    expect(copy.querySelector(".lucide-check")).toBeNull();
    expect([...figure.children]).toEqual(initialChildren);
    expect(toastManager.add).not.toHaveBeenCalled();
  });

  it("keeps one fixed-height error line during retry, with no obsolete diagnostic", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    await render(_fixture);
    const errorRow = _fixture.container.querySelector('[aria-label="Diagram error"]')!;
    const summary = errorRow.firstElementChild!;
    const children = [...errorRow.children];
    const pending = pendingRender();
    vi.mocked(renderMermaidDiagram).mockReturnValueOnce(pending.promise);
    await act(() => button(_fixture, "Retry diagram").click());
    expect(_fixture.container.querySelector('[aria-label="Diagram error"]')).toBe(errorRow);
    expect([...errorRow.children]).toEqual(children);
    expect(summary.textContent).toBe("Rendering diagram…");
    expect(summary.getAttribute("title")).toBeNull();
    expect(summary.className).toContain("truncate");
    await act(() => pending.reject(new MermaidRenderError(new Error(diagnostic))));
    expect([...errorRow.children]).toEqual(children);
    expect(summary.textContent).toBe("Parse error on line 2:");
  });

  it("exposes normal source copy and wrapping without changing repair context", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    await render(_fixture);
    const codeBlock = _fixture.container.querySelector(".chat-markdown-codeblock")!;
    expect(codeBlock.getAttribute("data-language")).toBe("mermaid");
    expect(codeBlock.querySelector(".chat-markdown-codeblock-header")).not.toBeNull();
    const wrapped = codeBlock.getAttribute("data-wrap") === "true";
    await act(() => button(_fixture, wrapped ? "Disable line wrap" : "Wrap lines").click());
    expect(codeBlock.getAttribute("data-wrap")).toBe(String(!wrapped));
    await act(() => button(_fixture, "Copy code").click());
    expect(writeText).toHaveBeenCalledWith(source);
    await act(() => button(_fixture, "Ask agent to fix").click());
    expect(collectAssistantCitations(draft)[0]!.citation.text).toBe(source);
    const pending = pendingRender();
    vi.mocked(renderMermaidDiagram).mockReturnValueOnce(pending.promise);
    await act(() => button(_fixture, "Retry diagram").click());
    await act(() => pending.reject(new MermaidRenderError(new Error(diagnostic))));
    expect(_fixture.container.querySelector(".chat-markdown-codeblock")).toBe(codeBlock);
    expect(codeBlock.getAttribute("data-wrap")).toBe(String(!wrapped));
  });

  it.each(["light", "dark"] as const)(
    "uses the normal language header and highlighting in %s appearance",
    async (theme) => {
      await using _fixture = _createFixture();
      _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
      await _setupFixture0(_fixture);

      await getSyntaxHighlighterPromise("mermaid");
      const original = 'flowchart LR\nA["שלום <start> & end"\n';
      await render(_fixture, original, theme);
      const codeBlock = _fixture.container.querySelector(".chat-markdown-codeblock")!;
      const header = codeBlock.querySelector(".chat-markdown-codeblock-header")!;
      expect(
        header.querySelector('[aria-label="Language: mermaid"]') ??
          [...header.querySelectorAll("span")].find((node) => node.textContent === "mermaid"),
      ).toBeTruthy();
      expect(codeBlock.querySelector(".chat-markdown-shiki .shiki code")?.textContent).toBe(
        original,
      );
      await act(() => button(_fixture, "Copy code").click());
      expect(writeText).toHaveBeenCalledWith(original);
    },
  );

  it("preserves the successful diagram toolbar and source controls", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    vi.mocked(renderMermaidDiagram).mockResolvedValueOnce({
      svg: "<svg><text>A valid diagram</text></svg>",
      diagramType: "flowchart",
    });
    const valid = "flowchart LR\nA --> B";
    await render(_fixture, valid);
    expect(button(_fixture, "Expand diagram").disabled).toBe(false);
    expect(_fixture.container.querySelector('[aria-label="Diagram error"]')).toBeNull();
    expect(_fixture.container.querySelector(".chat-markdown-codeblock")).toBeNull();
    await menuAction(_fixture, "Show source");
    const sourcePreview = _fixture.container.querySelector(".scient-mermaid-source")!;
    expect(sourcePreview.textContent).toBe(valid);
    expect(sourcePreview.parentElement!.hidden).toBe(false);
    await menuAction(_fixture, "Copy source");
    expect(writeText).toHaveBeenCalledWith(valid);
    await menuAction(_fixture, "Hide source");
    expect(sourcePreview.parentElement!.hidden).toBe(true);
    expect(_fixture.container.textContent).toContain("A valid diagram");
  });

  it.each([
    { name: "intrinsic", stageWidth: 720, intrinsicWidth: 180, intrinsicHeight: 90 },
    { name: "oversized", stageWidth: 320, intrinsicWidth: 1_200, intrinsicHeight: 600 },
  ])(
    "sizes an $name inline SVG proportionally inside the padded stage",
    async ({ stageWidth, intrinsicWidth, intrinsicHeight }) => {
      await using _fixture = _createFixture();
      _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
      await _setupFixture0(_fixture);

      _fixture.container.style.width = `${stageWidth}px`;
      vi.mocked(renderMermaidDiagram).mockResolvedValueOnce({
        svg: `<svg xmlns="http://www.w3.org/2000/svg" width="100%" style="max-width:${intrinsicWidth}px" viewBox="0 0 ${intrinsicWidth} ${intrinsicHeight}"><rect width="${intrinsicWidth}" height="${intrinsicHeight}" fill="blue"/></svg>`,
        diagramType: "flowchart",
      });
      await render(_fixture, `flowchart LR\nSized${intrinsicWidth} --> Diagram`);
      const stage = _fixture.container.querySelector<HTMLElement>(".scient-mermaid-inline")!;
      const svg = stage.querySelector("svg")!;
      await vi.waitFor(() => expect(svg.getBoundingClientRect().width).toBeGreaterThan(0));
      const style = getComputedStyle(stage);
      const contentWidth =
        stage.clientWidth -
        Number.parseFloat(style.paddingLeft) -
        Number.parseFloat(style.paddingRight);
      const expectedWidth = Math.min(intrinsicWidth, contentWidth);
      const bounds = svg.getBoundingClientRect();
      expect(contentWidth).toBeGreaterThan(0);
      expect(bounds.width).toBeCloseTo(expectedWidth, 0);
      expect(bounds.height).toBeCloseTo((expectedWidth * intrinsicHeight) / intrinsicWidth, 0);
      expect(bounds.width / bounds.height).toBeCloseTo(intrinsicWidth / intrinsicHeight, 2);
      expect(stage.scrollWidth).toBeLessThanOrEqual(stage.clientWidth + 1);
      if (intrinsicWidth < contentWidth) {
        expect(bounds.width).toBeLessThan(contentWidth);
      } else {
        expect(bounds.width).toBeLessThan(intrinsicWidth);
      }
    },
  );

  it.each(["Copy source", "Download SVG", "Copy image", "Download PNG"] as const)(
    "executes %s from the expanded diagram through the export boundary",
    async (action) => {
      await using _fixture = _createFixture();
      _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
      await _setupFixture0(_fixture);

      const exported = Promise.withResolvers<void>();
      writeText.mockImplementation(async () => exported.resolve());
      vi.mocked(copyPngBlobToClipboard).mockImplementation(async () => exported.resolve());
      vi.mocked(downloadPresentationBlob).mockImplementation(() => exported.resolve());
      const original = 'flowchart LR\nA["Current export"] --> B\n';
      const svg =
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 240 120"><rect x="10" y="10" width="40" height="40" fill="red"/><text x="60" y="40">Current export</text></svg>';
      vi.mocked(renderMermaidDiagram).mockResolvedValueOnce({ svg, diagramType: "flowchart" });
      await _fixture.root0.rerender(
        <MermaidDiagramCard
          source={original}
          language="mermaid"
          title="Current pipeline.mmd"
          theme="dark"
        />,
      );
      await userEvent.click(button(_fixture, "Expand diagram"));
      const dialog = page.getByRole("dialog", { name: "Current pipeline.mmd" });
      await expect.element(dialog).toBeVisible();
      await userEvent.click(
        dialog.getByRole("button", { name: "More diagram actions", exact: true }),
      );
      await userEvent.click(page.getByRole("menuitem", { name: action, exact: true }));
      // Native canvas encoding finishes through its callback, not a polling interval.
      await act(async () => await exported.promise);

      if (action === "Copy source") {
        expect(writeText).toHaveBeenCalledExactlyOnceWith(original);
      } else if (action === "Copy image") {
        expect(copyPngBlobToClipboard).toHaveBeenCalledOnce();
        const blob = vi.mocked(copyPngBlobToClipboard).mock.calls[0]![0];
        expect(blob.type).toBe("image/png");
        expect(blob.size).toBeGreaterThan(0);
      } else {
        expect(downloadPresentationBlob).toHaveBeenCalledOnce();
        const [blob, fileName] = vi.mocked(downloadPresentationBlob).mock.calls[0]!;
        expect(fileName).toBe(
          action === "Download SVG" ? "Current-pipeline.svg" : "Current-pipeline.png",
        );
        if (action === "Download SVG") {
          expect(blob.type).toBe("image/svg+xml;charset=utf-8");
          expect(await blob.text()).toBe(prepareSvgForExport(svg, "dark"));
        } else {
          expect(blob.type).toBe("image/png");
          expect(blob.size).toBeGreaterThan(0);
        }
      }

      if (action === "Copy image" || action === "Download PNG") {
        expect(loadCanvasImage).toHaveBeenCalledOnce();
        const input = vi.mocked(loadCanvasImage).mock.calls[0]![0];
        const exported = new DOMParser().parseFromString(await input.text(), "image/svg+xml");
        expect(exported.querySelector("parsererror")).toBeNull();
        expect(exported.querySelector("text")?.textContent).toBe("Current export");
        expect(exported.querySelector("style")?.textContent).toContain("color-scheme:dark");
        expect(exported.documentElement.getAttribute("viewBox")).toBe("0 0 240 120");
      } else {
        expect(loadCanvasImage).not.toHaveBeenCalled();
      }
      if (action !== "Copy source") expect(writeText).not.toHaveBeenCalled();
      if (action !== "Copy image") expect(copyPngBlobToClipboard).not.toHaveBeenCalled();
      if (action === "Copy source" || action === "Copy image") {
        expect(downloadPresentationBlob).not.toHaveBeenCalled();
      }
      expect(toastManager.add).not.toHaveBeenCalled();
      await expect.element(dialog).toBeVisible();
    },
  );

  it("ignores out-of-order results and removes an old SVG when inputs change", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    const first = pendingRender();
    const second = pendingRender();
    vi.mocked(renderMermaidDiagram)
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    await render(_fixture, "flowchart LR\nA --> B");
    await render(_fixture, "flowchart LR\nC --> D");
    await act(() =>
      second.resolve({ svg: "<svg><text>Latest diagram</text></svg>", diagramType: "flowchart" }),
    );
    await act(() => first.reject(new Error("Old error")));
    expect(_fixture.container.textContent).toContain("Latest diagram");
    expect(_fixture.container.textContent).not.toContain("Old error");
    const third = pendingRender();
    vi.mocked(renderMermaidDiagram).mockReturnValueOnce(third.promise);
    await render(_fixture, "flowchart LR\nC --> D", "dark");
    expect(_fixture.container.textContent).not.toContain("Latest diagram");
    expect(_fixture.container.textContent).toContain("Rendering diagram");
    await act(() =>
      third.resolve({ svg: "<svg><text>Dark diagram</text></svg>", diagramType: "flowchart" }),
    );
    expect(_fixture.container.textContent).toContain("Dark diagram");
  });

  it("keeps recovered source explicit and never changes original copy, citations, or source preview", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    const original = "flowchart LR\nA[Read (local)] -> B";
    const recovery = planMermaidRecovery(original)!;
    vi.mocked(renderMermaidDiagram).mockResolvedValue({
      svg: "<svg><text>Read (local)</text></svg>",
      diagramType: "flowchart-v2",
      recovery,
    });
    await render(_fixture, original);
    const figure = _fixture.container.querySelector('[role="figure"]')!;
    expect(figure.getAttribute("data-markdown-copy")).toContain(original);
    expect(figure.getAttribute("data-markdown-copy")).not.toContain(recovery.source);
    expect(_fixture.container.querySelector('[aria-label="Diagram error"]')).toBeNull();
    expect(_fixture.container.querySelector('[aria-label="Ask agent to fix"]')).toBeNull();
    const children = [...figure.children];
    await menuAction(_fixture, "Copy recovered source");
    expect(writeText).toHaveBeenLastCalledWith(recovery.source);
    expect([...figure.children]).toEqual(children);
    await menuAction(_fixture, "Copy original source");
    expect(writeText).toHaveBeenLastCalledWith(original);
    await menuAction(_fixture, "Show source");
    expect(_fixture.container.querySelector(".scient-mermaid-source")?.textContent).toBe(original);
    expect(toastManager.add).not.toHaveBeenCalled();
    expect(draft).toBe("An existing draft");
  });

  it("keeps the original document editor mounted when a recovered result arrives", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    const original = "flowchart LR\nA -> B";
    const cleanup = vi.fn();
    const editor = { open: true, mount: vi.fn(() => cleanup) };
    const pending = pendingRender();
    vi.mocked(renderMermaidDiagram).mockReturnValue(pending.promise);
    await act(
      async () =>
        await _fixture.root0.rerender(
          <MermaidDiagramCard
            source={original}
            sourceEditor={editor}
            language="mermaid"
            title={null}
            theme="light"
          />,
        ),
    );
    expect(editor.mount).toHaveBeenCalledTimes(1);
    await act(() =>
      pending.resolve({
        svg: "<svg/>",
        diagramType: "flowchart",
        recovery: planMermaidRecovery(original)!,
      }),
    );
    expect(cleanup).not.toHaveBeenCalled();
    expect(editor.mount).toHaveBeenCalledTimes(1);
  });

  it("never exposes recovered source from a stale source or theme", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    const original = "flowchart LR\nA -> B";
    const stale = pendingRender();
    const current = pendingRender();
    vi.mocked(renderMermaidDiagram)
      .mockReturnValueOnce(stale.promise)
      .mockReturnValueOnce(current.promise);
    await render(_fixture, original);
    await render(_fixture, "flowchart LR\nC --> D", "dark");
    await act(() =>
      stale.resolve({
        svg: "<svg>Old recovered</svg>",
        diagramType: "flowchart",
        recovery: planMermaidRecovery(original)!,
      }),
    );
    expect(_fixture.container.textContent).not.toContain("Old recovered");
    await act(() => button(_fixture, "More diagram actions").click());
    expect(document.body.textContent).not.toContain("Copy recovered source");
    await act(() => button(_fixture, "More diagram actions").click());
    await act(() => current.reject(new MermaidRenderError(new Error(diagnostic))));
    await act(() => button(_fixture, "Copy error and source").click());
    expect(writeText).toHaveBeenLastCalledWith(
      buildMermaidRepairRequest("flowchart LR\nC --> D", diagnostic),
    );
  });
});

function _createFixture() {
  const stack = new AsyncDisposableStack();
  const cleanup = new AsyncDisposableStack();
  return {
    composer: undefined! as ComposerHandleRef,

    container: undefined! as HTMLDivElement,
    stack,
    cleanup,
    root0: undefined! as Screen,
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
