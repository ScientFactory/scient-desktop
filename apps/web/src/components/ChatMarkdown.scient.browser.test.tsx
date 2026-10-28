import {
  EnvironmentFilePath,
  EnvironmentId,
  ThreadId,
  type AssetCreateUrlResult,
  type AssetResource,
  type EnvironmentFileLinkResolution,
  type PreviewSessionSnapshot,
} from "@t3tools/contracts";
import type { AtomCommandResult } from "@t3tools/client-runtime/state/runtime";
import * as Cause from "effect/Cause";
import type { OpenPreviewMutation } from "../browser/openFileInPreview";
import { getBrowserDefaults, type BrowserDefaults } from "../browser/browserDefaults";
import { assetEnvironment } from "../state/assets";
import { previewEnvironment } from "../state/preview";
import { shellEnvironment } from "../state/shell";
import { clearThreadPreviewState } from "../previewStateStore";
import {
  readHtmlPdfRelation,
  useHtmlPdfSourceStore,
} from "../scient/documentExport/htmlPdfSourceStore";
import { searchableMessageSegments } from "@t3tools/shared/threadFindText";
import { countThreadSearchOccurrences } from "@t3tools/shared/threadSearch";
import { AsyncResult } from "effect/reactivity";
import { useEffect, type ReactElement } from "react";
import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";
import { type FileCitation } from "@t3tools/contracts";
import { serializeComposerCitation } from "@t3tools/shared/composerCitations";

import { act, fakeTimers, render, stubGlobal } from "../../test/render";
import "../index.css";
import { useTheme } from "../hooks/useTheme";
import { applyThemeColorPreview, getStandardThemeColors } from "../themePalette";
import { readLocalApi } from "../localApi";
import { toastManager } from "./ui/toast";

import { filesystemEnvironment } from "../state/filesystem";
import { projectEnvironment } from "../state/projects";
import { environmentFileLinkResolution } from "../scient/fileOpening/environmentFileState";
import { selectSelectedRightPanelSurface, useRightPanelStore } from "../rightPanelStore";
import { getSyntaxHighlighterPromise } from "../lib/syntaxHighlighting";
import { MarkdownFindContext } from "./chat/markdownFindContext";
import { useThreadFindHighlights } from "./chat/threadFindHighlights";
import { setMarkdownTaskChecked } from "./files/filePreviewMode";

const { workspaceSearch, filesystemMetadata, resolveFileLink } = vi.hoisted(() => ({
  workspaceSearch: vi.fn(),
  filesystemMetadata: vi.fn(),
  resolveFileLink: vi.fn(),
}));
const htmlOpening = vi.hoisted(() => ({
  enabled: false,
  mint: vi.fn<
    (target: {
      environmentId: EnvironmentId;
      input: { resource: AssetResource };
    }) => Promise<AtomCommandResult<AssetCreateUrlResult, unknown>>
  >(),
  open: vi.fn<OpenPreviewMutation>(),
  editor: vi.fn(),
  defaults: vi.fn<() => Promise<BrowserDefaults>>(),
}));
vi.mock(import("../state/use-atom-command"), async (original) => {
  const actual = await original();
  return {
    ...actual,
    useAtomCommand: ((command: unknown, options: Parameters<typeof actual.useAtomCommand>[1]) =>
      htmlOpening.enabled && command === previewEnvironment.open
        ? htmlOpening.open
        : htmlOpening.enabled && command === shellEnvironment.openInEditor
          ? htmlOpening.editor
          : actual.useAtomCommand(
              command as Parameters<typeof actual.useAtomCommand>[0],
              options,
            )) as typeof actual.useAtomCommand,
  };
});
vi.mock(import("../browser/previewRuntime"), async (original) => {
  const actual = await original();
  return {
    ...actual,
    isPreviewAvailableFor: (id) => htmlOpening.enabled || actual.isPreviewAvailableFor(id),
    previewRuntimeFor: (id) => (htmlOpening.enabled ? "server" : actual.previewRuntimeFor(id)),
  };
});
vi.mock(import("../browser/browserDefaults"), async (original) => {
  const actual = await original();
  return {
    ...actual,
    resolveBrowserDefaults: () =>
      htmlOpening.enabled ? htmlOpening.defaults() : actual.resolveBrowserDefaults(),
  };
});
vi.mock(import("../state/use-atom-query-runner"), async (original) => {
  const actual = await original();
  return {
    ...actual,
    useAtomQueryRunner: ((family: unknown, options: never) =>
      family === filesystemEnvironment.getMetadata
        ? filesystemMetadata
        : family === projectEnvironment.searchEntries
          ? workspaceSearch
          : family === environmentFileLinkResolution
            ? resolveFileLink
            : htmlOpening.enabled && family === assetEnvironment.createUrl
              ? htmlOpening.mint
              : actual.useAtomQueryRunner(family as never, options)) as never,
  };
});

// Atoms derived from the server config run in the real registry over a missing config.
vi.mock(import("../state/server"), async (original) => {
  const actual = await original();
  const { Atom } = await import("effect/reactivity");
  const noConfig = Atom.make(null);
  return {
    ...actual,
    serverEnvironment: { ...actual.serverEnvironment, configValueAtom: (() => noConfig) as never },
  };
});
// A standard client session, so environment-owned file links can open.
vi.mock(import("../state/session"), async (original) => {
  const actual = await original();
  const { AuthStandardClientScopes } = await import("@t3tools/contracts");
  const granted = new Set<string>(AuthStandardClientScopes);
  const hasScope = (environmentId: unknown, scope: string) =>
    environmentId !== null && granted.has(scope);
  return {
    ...actual,
    useEnvironmentScope: hasScope as never,
    readEnvironmentScope: hasScope as never,
    readPreparedConnection: ((id) =>
      htmlOpening.enabled
        ? { httpBaseUrl: "https://file-host.test" }
        : actual.readPreparedConnection(id)) as typeof actual.readPreparedConnection,
    usePreparedConnection: ((id) =>
      htmlOpening.enabled
        ? { _tag: "Some", value: { httpBaseUrl: "https://file-host.test" } }
        : actual.usePreparedConnection(id)) as typeof actual.usePreparedConnection,
  };
});
vi.mock(import("../remoteOpen"), async (original) => ({
  ...(await original()),
  useRemoteOpenResolution: () => ({ state: { mode: "local-exec" }, isResolved: true }) as never,
}));
const { renderDiagram, mountPlotly, mountVegaLite } = vi.hoisted(() => ({
  renderDiagram: vi.fn<(source: string) => Promise<string> | undefined>(),
  mountPlotly: vi.fn<typeof import("../scient/visualizations/plotlyRuntime").mountPlotlyView>(),
  mountVegaLite:
    vi.fn<typeof import("../scient/visualizations/vegaLiteRuntime").mountVegaLiteView>(),
}));
// Keep cache, palette, recovery and resource checks live; control layout completion.
vi.mock(import("./chat/MermaidDiagram"), async (original) => ({
  ...(await original()),
  renderMermaidSvg: async (source: string) => ({
    svg: `<svg xmlns="http://www.w3.org/2000/svg" role="img" aria-label="${(await renderDiagram(source)) ?? "Diagram"}"></svg>`,
    diagramType: "flowchart-v2",
  }),
}));

vi.mock(import("../scient/visualizations/plotlyRuntime"), async (original) => ({
  ...(await original()),
  mountPlotlyView: mountPlotly,
}));
vi.mock(import("../scient/visualizations/vegaLiteRuntime"), async (original) => ({
  ...(await original()),
  mountVegaLiteView: mountVegaLite,
}));

import { __setClientSettingsForTests, getClientSettings } from "../hooks/useSettings";
function setMathRenderingEnabled(mathRenderingEnabled: boolean) {
  __setClientSettingsForTests({ ...getClientSettings(), mathRenderingEnabled });
}

import ChatMarkdown from "./ChatMarkdown";
import { getScientKatexRuntimePromise } from "../scient/math/ScientMath";
import { serializeTableElementToCsv, chatMarkdownClipboardPayload } from "../markdown-clipboard";
import { captureAssistantTextSelection } from "../lib/assistantTextSelection";

const ARTIFACT_TEMPLATE_DIRECTIVE =
  '::artifact-template{skill_name="artifact-template-hello-world" skill_directory="/Users/test/.codex/skills/artifact-template-hello-world" display_name="Hello World" artifact_kind="document"}';

function setup() {
  setMathRenderingEnabled(false);
  htmlOpening.enabled = false;
  htmlOpening.mint
    .mockReset()
    .mockResolvedValue(
      AsyncResult.success({ relativeUrl: "/api/assets/authorized.html", expiresAt: 1 }),
    );
  htmlOpening.open.mockReset().mockImplementation(async ({ input }) =>
    AsyncResult.success({
      threadId: input.threadId,
      tabId: "authorized-html",
      navStatus: { _tag: "Idle" },
      canGoBack: false,
      canGoForward: false,
      updatedAt: "2026-10-01T00:00:00.000Z",
    }),
  );
  htmlOpening.defaults.mockReset().mockResolvedValue(getBrowserDefaults());
  htmlOpening.editor.mockReset().mockResolvedValue(AsyncResult.success(undefined));
  renderDiagram.mockReset();
  mountPlotly.mockReset();
  mountVegaLite.mockReset();
  workspaceSearch.mockReset().mockResolvedValue(AsyncResult.success({ entries: [] }));
  filesystemMetadata.mockReset().mockResolvedValue(AsyncResult.success({ entries: [null] }));
  resolveFileLink
    .mockReset()
    .mockImplementation((target: { input: { path: string } }) =>
      Promise.resolve(AsyncResult.success({ _tag: "literal", path: target.input.path })),
    );
}

async function renderMarkup(element: ReactElement) {
  await using screen = await render(element);
  return screen.container.innerHTML;
}

function renderText(text: string, props: Partial<Parameters<typeof ChatMarkdown>[0]> = {}) {
  return render(<ChatMarkdown cwd="/tmp/project" text={text} {...props} />);
}

function buttonsLabelled(container: HTMLElement, label: string) {
  return [...container.querySelectorAll<HTMLButtonElement>("button")].filter(
    (button) => button.getAttribute("aria-label") === label,
  );
}

describe("ChatMarkdown settled chart fences", () => {
  it.each([
    {
      language: "plotly",
      source: '{"data":[{"type":"scatter","x":[1,2],"y":[3,4]}]}',
      imageLabel: "Settled Plotly",
      expandLabel: "Expand interactive figure",
    },
    {
      language: "vega-lite",
      source:
        '{"data":{"values":[{"x":1,"y":2}]},"mark":"point","encoding":{"x":{"field":"x","type":"quantitative"},"y":{"field":"y","type":"quantitative"}}}',
      imageLabel: "Settled Vega-Lite",
      expandLabel: "Expand interactive chart",
    },
  ])(
    "keeps a closed $language fence literal until settlement",
    async ({ language, source, imageLabel, expandLabel }) => {
      setup();
      const disposePlotly = vi.fn();
      const finalizeVegaLite = vi.fn();
      mountPlotly.mockImplementation(async ({ container }) => {
        container.innerHTML = `<svg role="img" aria-label="${imageLabel}"></svg>`;
        return {
          dispose: disposePlotly,
          getDimensions: () => ({ width: 320, height: 180 }),
          getInteractionMode: () => "pan",
          getState: () => ({ data: [], layout: {}, frames: [] }),
          graph: container as import("plotly.js").PlotlyHTMLElement,
          reset: async () => {},
          resize: () => {},
          setInteractionMode: async () => {},
          setState: async () => {},
          toImage: async () => "data:image/png;base64,AA==",
          updatePresentation: async () => {},
          warnings: [],
        };
      });
      mountVegaLite.mockImplementation(async ({ container }) => {
        container.innerHTML = `<svg role="img" aria-label="${imageLabel}"></svg>`;
        return {
          initialState: {},
          result: {
            finalize: finalizeVegaLite,
            view: {
              getState: () => ({}),
              resize: () => {},
              runAsync: async () => {},
            },
          } as unknown as import("../scient/visualizations/vegaLiteRuntime").MountedVegaLiteView["result"],
          warnings: [],
        };
      });
      const text = `\`\`\`${language}\n${source}\n\`\`\``;
      const message = (isStreaming: boolean) => (
        <ChatMarkdown cwd={undefined} text={text} isStreaming={isStreaming} />
      );
      await using screen = await render(message(true));
      expect(screen.container.querySelector("pre")?.textContent).toContain(source);
      expect(screen.container.querySelector('[role="figure"]')).toBeNull();
      expect(mountPlotly).not.toHaveBeenCalled();
      expect(mountVegaLite).not.toHaveBeenCalled();

      await screen.rerender(message(false));
      await expect.element(screen.getByRole("img", { name: imageLabel })).toBeVisible();
      await expect
        .element(screen.getByRole("button", { name: expandLabel, exact: true }))
        .toBeEnabled();
      expect(
        screen.container.querySelector('[role="figure"]')?.getAttribute("data-markdown-copy"),
      ).toBe(`${text}\n\n`);
      const authored = JSON.parse(source) as Record<string, unknown>;
      if (language === "plotly") {
        expect(mountPlotly).toHaveBeenCalledOnce();
        expect(mountPlotly.mock.calls[0]?.[0].parsed.figure).toMatchObject(authored);
        expect(mountVegaLite).not.toHaveBeenCalled();
      } else {
        expect(mountVegaLite).toHaveBeenCalledOnce();
        expect(mountVegaLite.mock.calls[0]?.[0].parsed.spec).toEqual(authored);
        expect(mountPlotly).not.toHaveBeenCalled();
      }
      await screen.unmount();
      await vi.waitFor(() => {
        expect(language === "plotly" ? disposePlotly : finalizeVegaLite).toHaveBeenCalledOnce();
      });
      expect(language === "plotly" ? finalizeVegaLite : disposePlotly).not.toHaveBeenCalled();
    },
  );
});

describe("ChatMarkdown Mermaid streaming", () => {
  it("reveals a completed fence while streaming and preserves it through later prose and stream end", async () => {
    setup();
    let finishRender!: (label: string) => void;
    renderDiagram.mockReturnValue(
      new Promise<string>((resolve) => {
        finishRender = resolve;
      }),
    );
    const source = "flowchart LR\nA --> B";
    const metadata = 'title="Streaming pipeline" data-owner="lab"';
    const open = `\`\`\`mermaid ${metadata}\n${source}`;
    const closed = `${open}\n\`\`\`\n\n`;
    let selection!: ReturnType<typeof useTheme>;
    function Message({ text, isStreaming }: { text: string; isStreaming: boolean }) {
      const theme = useTheme();
      useEffect(() => {
        selection = theme;
      }, [theme]);
      return <ChatMarkdown cwd={undefined} text={text} isStreaming={isStreaming} />;
    }
    const message = (text: string, isStreaming = true) => (
      <Message text={text} isStreaming={isStreaming} />
    );
    const originalStorage = Object.entries(localStorage);
    await using screen = await render(message(open));
    await using _appearance = {
      async [Symbol.asyncDispose]() {
        await act(() => {
          localStorage.clear();
          for (const [key, value] of originalStorage) localStorage.setItem(key, value);
          window.dispatchEvent(new StorageEvent("storage", { key: null }));
          selection.refreshTheme();
        });
      },
    };
    await act(() => {
      selection.setTheme("dark");
      selection.setAppearanceMode("dark");
    });
    const savedStorage = Object.fromEntries(Object.entries(localStorage));
    await act(() => applyThemeColorPreview(getStandardThemeColors("light"), "light"));
    expect(selection).toMatchObject({ theme: "dark", resolvedTheme: "dark" });
    expect(document.documentElement.classList.contains("dark")).toBe(false);
    expect(Object.fromEntries(Object.entries(localStorage))).toEqual(savedStorage);
    const { container, rerender } = screen;
    expect(container.querySelector("pre")?.textContent).toContain(source);
    expect(renderDiagram).not.toHaveBeenCalled();

    await rerender(message(closed));
    await vi.waitFor(() =>
      expect(renderDiagram).toHaveBeenCalledWith(expect.stringContaining(source)),
    );
    expect(container.querySelector('svg[role="img"]')).toBeNull();
    expect(container.querySelector(".chat-markdown-shiki")).toBeNull();
    expect(container.textContent).toContain("Rendering diagram…");
    expect(container.querySelector("pre")?.closest("[hidden]")).not.toBeNull();

    await act(async () => finishRender("Completed diagram"));
    await vi.waitFor(() => expect(container.querySelector('svg[role="img"]')).not.toBeNull());
    const diagram = container.querySelector<SVGSVGElement>('svg[role="img"]');
    expect(diagram?.getAttribute("aria-label")).toBe("Completed diagram");
    expect(diagram?.style.getPropertyValue("--pele-bg")).toBe("#ffffff");
    const figure = container.querySelector<HTMLElement>('[role="figure"]')!;
    expect(figure.getAttribute("aria-label")).toBe("Streaming pipeline");
    await expect.element(screen.getByText("Streaming pipeline", { exact: true })).toBeVisible();
    expect(figure.getAttribute("data-markdown-copy")).toBe(closed);
    const nativeSelection = window.getSelection()!;
    const previousRanges = Array.from({ length: nativeSelection.rangeCount }, (_, index) =>
      nativeSelection.getRangeAt(index).cloneRange(),
    );
    using _selection = {
      [Symbol.dispose]() {
        nativeSelection.removeAllRanges();
        for (const range of previousRanges) nativeSelection.addRange(range);
      },
    };
    const range = document.createRange();
    range.selectNodeContents(figure);
    nativeSelection.removeAllRanges();
    nativeSelection.addRange(range);
    expect(chatMarkdownClipboardPayload(nativeSelection)?.text).toBe(closed.trim());
    nativeSelection.removeAllRanges();
    for (const streaming of [true, false]) {
      await rerender(message(`${closed}The remaining explanation.`, streaming));
      expect(container.querySelector('svg[role="img"]')).toBe(diagram);
      expect(container.textContent).toContain("The remaining explanation.");
    }

    await userEvent.click(buttonsLabelled(container, "More diagram actions")[0]!);
    await userEvent.click(page.getByRole("menuitem", { name: "Show source", exact: true }));
    const sourcePreview = container.querySelector(".scient-mermaid-source");
    expect(sourcePreview?.textContent).toContain(source);
    expect(sourcePreview?.closest("[hidden]")).toBeNull();
    expect(container.querySelector('svg[role="img"]')).toBe(diagram);
    await userEvent.click(buttonsLabelled(container, "More diagram actions")[0]!);
    await userEvent.click(page.getByRole("menuitem", { name: "Hide source", exact: true }));
    expect(sourcePreview?.closest("[hidden]")).not.toBeNull();
    expect(container.querySelector('svg[role="img"]')).toBe(diagram);
  });

  it.each([
    ["short tilde marker", "~~~~mermaid\nflowchart LR\nA --> B\n~~~", "\n~~~~"],
    [
      "overindented blockquote marker",
      "> ```mermaid\n> flowchart LR\n> A --> B\n>     ```",
      "\n> ```",
    ],
    [
      "overindented list marker",
      "- Diagram\n\n  ```mermaid\n  flowchart LR\n  A --> B\n      ```",
      "\n  ```",
    ],
  ])("keeps a %s in source until a real closer arrives", async (_, open, closing) => {
    setup();
    const message = (text: string) => <ChatMarkdown cwd={undefined} text={text} isStreaming />;
    await using screen = await render(message(open));
    const { container, rerender } = screen;
    expect(renderDiagram).not.toHaveBeenCalled();
    expect(container.querySelector("pre")?.textContent).toContain("A --> B");

    await rerender(message(`${open}${closing}`));
    await vi.waitFor(() =>
      expect(container.querySelector('svg[role="img"]')?.getAttribute("aria-label")).toBe(
        "Diagram",
      ),
    );
  });

  it("does not mistake a CRLF stream cut after CR for a closed fence", async () => {
    setup();
    const open = "```mermaid\r\nflowchart LR\r\nA --> B\r\n\t```";
    const message = (text: string) => <ChatMarkdown cwd={undefined} text={text} isStreaming />;
    await using screen = await render(message(open));
    const { container, rerender } = screen;
    expect(renderDiagram).not.toHaveBeenCalled();
    await rerender(message(`${open}\r`));
    expect(renderDiagram).not.toHaveBeenCalled();
    expect(container.querySelector("pre")?.textContent).toContain("A --> B");

    await rerender(message(`${open}\r\n\`\`\``));
    await vi.waitFor(() =>
      expect(container.querySelector('svg[role="img"]')?.getAttribute("aria-label")).toBe(
        "Diagram",
      ),
    );
  });

  it("falls back to source when a completed diagram fails during streaming", async () => {
    setup();
    await getSyntaxHighlighterPromise("mermaid");
    renderDiagram.mockImplementation(() => {
      throw new Error("Invalid Mermaid diagram");
    });
    using _consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    await using screen = await renderText("```mermaid\ninvalid diagram\n```", {
      isStreaming: true,
    });
    const { container } = screen;
    await vi.waitFor(() =>
      expect(renderDiagram).toHaveBeenCalledWith(expect.stringContaining("invalid diagram")),
    );
    await vi.waitFor(() =>
      expect(container.querySelector('[aria-label="Diagram error"]')).not.toBeNull(),
    );
    expect(container.querySelector('svg[role="img"]')).toBeNull();
    expect(container.querySelector("pre")?.textContent).toContain("invalid diagram");
    expect(container.querySelector("pre")?.getAttribute("aria-hidden")).not.toBe("true");
  });
});

describe("ChatMarkdown workspace file opens", () => {
  const threadRef = {
    environmentId: EnvironmentId.make("workspace"),
    threadId: ThreadId.make("thread"),
  };

  it("keeps a newer absolute file open when an earlier repo-relative lookup finishes", async () => {
    setup();
    const result = AsyncResult.success({
      entries: [{ path: "notes/a.md", kind: "file" }],
      truncated: false,
    });
    let resolvePending!: (value: typeof result) => void;
    const pending = new Promise<typeof result>((resolve) => {
      resolvePending = resolve;
    });
    workspaceSearch.mockReturnValueOnce(pending);
    using openFile = vi
      .spyOn(useRightPanelStore.getState(), "openFile")
      .mockImplementation(() => {});
    await using screen = await renderText(
      "[Notes](physics/notes/a.md) and [Other](/elsewhere/b.md:9)",
      {
        cwd: "/school/physics",
        threadRef,
      },
    );
    const { container } = screen;
    const [notes, other] = container.querySelectorAll("a");
    await act(async () => notes!.click());
    expect(workspaceSearch).toHaveBeenCalledOnce();
    expect(openFile).not.toHaveBeenCalled();

    await act(async () => other!.click());
    await act(async () => resolvePending(result));

    expect(openFile).toHaveBeenCalledExactlyOnceWith(threadRef, "/elsewhere/b.md", 9);
    expect(workspaceSearch).toHaveBeenCalledOnce();
  });
});

describe("ChatMarkdown Scient headings", () => {
  it("exposes headings below the host heading without changing their tags", async () => {
    setup();
    await using screen = await renderText("# Top\n\n## Section\n\n###### Fine print", {
      headingLevelOffset: 3,
    });
    const { container } = screen;
    expect(
      [...container.querySelectorAll("h1, h2, h6")].map((heading) => [
        heading.tagName,
        heading.getAttribute("aria-level"),
      ]),
    ).toEqual([
      ["H1", "4"],
      ["H2", "5"],
      ["H6", "6"],
    ]);
    expect(
      [...container.querySelectorAll("h1, h2, h6")].map((heading) => [
        heading.id,
        heading.getAttribute("dir"),
      ]),
    ).toEqual([
      ["user-content-top", "ltr"],
      ["user-content-section", "ltr"],
      ["user-content-fine-print", "ltr"],
    ]);
    await using flat = await renderText("# Top");
    expect(flat.container.querySelector("h1")?.id).toBe("user-content-top");
    expect(flat.container.querySelector("h1")?.getAttribute("dir")).toBe("ltr");
    expect(flat.container.querySelector("h1")?.hasAttribute("aria-level")).toBe(false);
  });

  it("isolates inline code left to right inside Arabic prose", async () => {
    setup();
    await using screen = await renderText("استخدم `useEffect useLayoutEffect React` هنا");
    const paragraph = screen.container.querySelector("p");
    const code = paragraph?.querySelector("code");
    expect(paragraph?.getAttribute("dir")).toBe("rtl");
    expect(code?.textContent).toBe("useEffect useLayoutEffect React");
    expect(code?.getAttribute("dir")).toBe("ltr");
  });
});

describe("ChatMarkdown thread find", () => {
  function FindProbe(props: {
    container: HTMLElement;
    query: string;
    activeOccurrence?: number;
    children: ReactElement;
  }) {
    useThreadFindHighlights({
      container: props.container,
      query: props.query,
      activeRowId: "row",
      activeOccurrence: props.activeOccurrence ?? 0,
      onActiveRange: () => {},
    });
    return (
      <div data-timeline-row-id="row">
        <div data-thread-find-text>
          <MarkdownFindContext value={props.query !== ""}>{props.children}</MarkdownFindContext>
        </div>
      </div>
    );
  }
  // Highlights live in a document-wide registry the rendered tree does not own.
  const clearHighlights = () => ({ [Symbol.dispose]: () => CSS.highlights.clear() });
  const activeHighlights = () =>
    [...(CSS.highlights.get("t3-thread-find-active") ?? [])].map((range) =>
      (range as Range).toString(),
    );

  it("keeps Mermaid diagrams rendered until find selects a match in their source", async () => {
    setup();
    using _highlights = clearHighlights();
    const container = document.createElement("div");
    const diagram = "```mermaid\ngraph TD; Alpha-->Beta\n```";
    const probe = (query: string) => (
      <FindProbe container={container} query={query}>
        <ChatMarkdown cwd={undefined} text={`Needle first.\n\n${diagram}\n\n${diagram}`} />
      </FindProbe>
    );
    const revealedSources = () =>
      container.querySelectorAll("[data-scient-rich-fence-find-source]:not([hidden])").length;

    await using screen = await render(probe("Needle"), { container });
    await vi.waitFor(() => expect(activeHighlights()).toEqual(["Needle"]));
    expect(revealedSources()).toBe(0);
    await screen.rerender(probe("Alpha"));
    await vi.waitFor(() => {
      expect(revealedSources()).toBe(1);
      expect(activeHighlights()).toEqual(["Alpha"]);
    });
  });

  // regression: da7c4f234d test(web): chat markdown and timeline tests run in a real browser (#20905)
  it.each([
    { text: "Before $x^2$ after.", query: "x^2", count: 1, mathSource: true },
    { text: "Before $x^2$ after.", query: "Before $x^2$ after", count: 1, canonicalPhrase: true },
    { text: "Before \\(x^2\\) after.", query: "(x^2)", count: 1, mathSource: true },
    { text: "$$\nx^2\n$$", query: "x^2", count: 1, mathSource: true },
    { text: "Before $a*b*c$ after.", query: "$abc$", count: 1, mathSource: true },
    { text: "```math\nx^2\n```", query: "x^2", count: 1, mathSource: true },
    {
      text: "```mermaid\ngraph TD; SearchSourceAlpha-->B\n```",
      query: "SearchSourceAlpha",
      count: 1,
    },
    {
      text: "★ Insight ─────\nfirst line\nsecond line",
      query: "first line second",
      count: 0,
      lineBreaks: true,
    },
    { text: '```ts title="src/needle.ts"\nconst a = 1;\n```', query: "needle", count: 0 },
    { text: "```weirdlang\nconst a = 1;\n```", query: "weirdlang", count: 0 },
    { text: "Use $test-t3-app now", query: "T3 App Testing", count: 1 },
    { text: "`/tmp/file.ts:42`", query: "file.ts · L42", count: 1, user: true, lineBreaks: true },
    { text: "> [!NOTE]\n> Searchable alert", query: "Searchable alert", count: 1 },
    {
      text: "<details><summary>Folded</summary><p>Hidden needle</p></details>",
      query: "Hidden needle",
      count: 1,
    },
    { text: ARTIFACT_TEMPLATE_DIRECTIVE, query: "Hello World", count: 1, withTemplate: true },
    {
      text: ARTIFACT_TEMPLATE_DIRECTIVE,
      query: "Document template",
      count: 1,
      withTemplate: true,
    },
    { text: ARTIFACT_TEMPLATE_DIRECTIVE, query: "World Document", count: 0, withTemplate: true },
    { text: ARTIFACT_TEMPLATE_DIRECTIVE, query: "Use template", count: 0, withTemplate: true },
  ])(
    "highlights the indexed occurrences of $query in $text",
    async ({ text, query, count, lineBreaks, user, withTemplate, mathSource, canonicalPhrase }) => {
      setup();
      const skills = [
        { name: "test-t3-app", displayName: "T3 App Testing", path: "", enabled: true },
      ];
      using _highlights = clearHighlights();
      const container = document.createElement("div");
      await using _screen = await render(
        <FindProbe container={container} query={query}>
          <ChatMarkdown
            text={text}
            cwd={undefined}
            skills={skills}
            lineBreaks={lineBreaks ?? false}
            parseRawHtml={!user}
            onUseArtifactTemplate={withTemplate ? () => undefined : undefined}
          />
        </FindProbe>,
        { container },
      );
      // Lazy blocks such as Mermaid can swap their source text after mounting,
      // emptying a range for a moment, so wait for the highlights to settle.
      await vi.waitFor(() => {
        const ranges = [...CSS.highlights.values()].flatMap((value) => [...value]);
        if (mathSource) {
          const source = container.querySelector<HTMLElement>(
            "[data-thread-find-canonical-source]",
          );
          expect(source?.hidden).toBe(false);
          expect(source?.getAttribute("aria-hidden")).toBe("true");
          expect(source?.getAttribute("data-markdown-copy")).toBe("");
        }
        if (canonicalPhrase) {
          expect(ranges).toHaveLength(count);
          expect((ranges[0] as Range)?.toString()).toContain("Before");
          expect((ranges[0] as Range)?.toString()).toContain("after");
        } else {
          expect(ranges.map((range) => (range as Range).toString())).toEqual(
            Array.from({ length: count }, () => query),
          );
        }
      });
      const segments =
        searchableMessageSegments(
          { role: user ? "user" : "assistant", text, streaming: false },
          undefined,
          skills,
        ) ?? [];
      expect(
        segments.reduce((sum, segment) => sum + countThreadSearchOccurrences(segment, query), 0),
      ).toBe(count);
    },
  );
});

// SCIENT-FORK:START - preserve rich markdown assertions in the browser.
describe("Markdown file quote in sent messages", () => {
  it("renders validated file links as the shared citation chip, but not inline code examples", async () => {
    const citation: FileCitation = {
      kind: "file",
      version: 1,
      environmentId: EnvironmentId.make("local"),
      threadId: ThreadId.make("source"),
      cwd: "/workspace",
      path: "notes.md",
      revision: `sha256:${"a".repeat(64)}`,
      origin: "draft",
      from: 1,
      to: 6,
      sourceStart: 0,
      sourceEnd: 10,
      startLine: 1,
      endLine: 1,
      text: "Hello",
      prefix: "",
      suffix: "",
    };
    const token = serializeComposerCitation(citation);
    const html = await renderMarkup(<ChatMarkdown cwd="/workspace" text={token} />);
    expect(html).toContain('data-file-citation-chip="true"');
    expect(html).toContain("notes.md");
    expect(html).toContain("Hello");
    expect(html).not.toContain('data-assistant-citation-chip="true"');
    const code = await renderMarkup(<ChatMarkdown cwd="/workspace" text={`\`${token}\``} />);
    expect(code).not.toContain('data-file-citation-chip="true"');
    expect(code).toContain("scient-file-citation");
    const invalid = await renderMarkup(
      <ChatMarkdown
        cwd="/workspace"
        text="[File quote](scient-file-citation://v1/?data=bad) [unsafe](javascript:alert)"
      />,
    );
    expect(invalid).not.toContain("data-file-citation-chip");
    expect(invalid).not.toContain('href="scient-file-citation');
    expect(invalid).not.toContain('href="javascript:');
  });
});
// SCIENT-FORK:END

// SCIENT-FORK:START - preserve rich markdown assertions in the browser.
describe("ChatMarkdown inline color swatches", () => {
  it("renders exact swatches for supported inline CSS colors without changing other code", async () => {
    const functionalColors = [
      "rgb(27, 78, 216)",
      "rgb(1 96 204 / 40%)",
      "hsl(222, 78%, 48%)",
      "hwb(214 0% 20%)",
      "oklch(0.52 0.19 262)",
      "lab(54% 70 50)",
      "lch(54% 86 36)",
      "color(display-p3 0.1 0.4 0.9)",
    ];
    setup();
    await using screen = await render(
      <ChatMarkdown
        cwd="/workspace"
        text={[
          "Current `#1b4ed8`, proposed `#0160cc`, and identifier `0x1b4ed8`.",
          "",
          functionalColors.map((color) => `\`${color}\``).join(" "),
          "",
          "Named `red`, variable `var(--brand-color)`, and composed `color-mix(in srgb, red, blue)`.",
          "",
          "```text",
          "#e72b2b",
          "```",
        ].join("\n")}
      />,
    );

    const html = screen.container.innerHTML;
    expect(html.match(/data-scient-inline-color-swatch="true"/g)).toHaveLength(
      2 + functionalColors.length,
    );
    const swatches = [
      ...screen.container.querySelectorAll<HTMLElement>('[data-scient-inline-color-swatch="true"]'),
    ];
    const expectedColors = ["#1b4ed8", "#0160cc", ...functionalColors];
    expect(swatches.map((swatch) => swatch.style.backgroundColor)).toEqual(
      expectedColors.map((color) => {
        const probe = document.createElement("span");
        probe.style.backgroundColor = color;
        return probe.style.backgroundColor;
      }),
    );
    expect(html).toContain("0x1b4ed8");
    expect(html).toContain("red");
    expect(html).toContain("var(--brand-color)");
    expect(html).toContain("color-mix(in srgb, red, blue)");
    expect(html).toContain("#e72b2b");
    expect(html).not.toContain('style="background-color:#e72b2b"');
  });
});
// SCIENT-FORK:END

// SCIENT-FORK:START - preserve rich markdown assertions in the browser.
describe("ChatMarkdown standard web links", () => {
  it("renders canonical citation Markdown as a clickable link beside RTL text", async () => {
    const html = await renderMarkup(
      <ChatMarkdown
        cwd="/tmp/project"
        text={'לפני [1](<https://example.com/guideline> "Clinical guideline") אחרי'}
      />,
    );

    expect(html).toContain('href="https://example.com/guideline"');
    expect(html).toMatch(/>1<\/span><\/a>/u);
    expect(html).toContain("לפני");
    expect(html).toContain("אחרי");
    expect(html).not.toContain("\uE200cite\uE202");
  });
});
// SCIENT-FORK:END
// A project file inside the workspace is ChatMarkdown.logic.test.ts's "project file" row.
it.each([
  {
    name: "worktree files with a line and column",
    platform: "MacIntel",
    cwd: "/Users/jordan/project/.claude/worktrees/topic",
    href: "src/main.ts:12:3",
    full: "/Users/jordan/project/.claude/worktrees/topic/src/main.ts:12:3",
    relative: "src/main.ts:12:3",
  },
  {
    name: "main checkout files outside the thread worktree",
    platform: "MacIntel",
    cwd: "/Users/jordan/project/.claude/worktrees/topic",
    href: "/Users/jordan/project/src/main.ts",
    full: "/Users/jordan/project/src/main.ts",
    relative: null,
  },
  {
    name: "Windows drive paths on a Mac client",
    platform: "MacIntel",
    cwd: "C:/repo",
    href: "C:/repo/reports/Device Users.csv:12:3",
    full: String.raw`C:\repo\reports\Device Users.csv:12:3`,
    relative: String.raw`reports\Device Users.csv:12:3`,
  },
  {
    name: "UNC paths on a Mac client",
    platform: "MacIntel",
    cwd: String.raw`\\server\share\repo`,
    href: "file://server/share/repo/reports/report.csv",
    full: String.raw`\\server\share\repo\reports\report.csv`,
    relative: String.raw`reports\report.csv`,
  },
  {
    name: "POSIX paths on a Windows client",
    platform: "Win32",
    cwd: "/home/repo",
    href: "/home/repo/reports/report.csv",
    full: "/home/repo/reports/report.csv",
    relative: "reports/report.csv",
  },
])("copies $name and shows the copied text", async ({ platform, cwd, href, full, relative }) => {
  setup();
  using _platform = vi.spyOn(navigator, "platform", "get").mockReturnValue(platform);
  using _clipboardItem = stubGlobal("ClipboardItem", undefined);
  using writeText = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue(undefined);
  using toast = vi.spyOn(toastManager, "add");
  const api = readLocalApi();
  if (!api) throw new Error("Local API unavailable");
  using choose = vi.spyOn(api.contextMenu, "show");
  await using screen = await renderText(`[File](<${href}>)`, {
    cwd,
    environmentId: EnvironmentId.make("env-file-copy"),
  });
  const { container } = screen;
  const link = container.querySelector(".chat-markdown-file-link");
  if (!link) throw new Error("File link unavailable");
  for (const [action, expected] of [
    ["copy-full", full],
    ...(relative === null ? [] : [["copy-relative", relative] as const]),
  ] as const) {
    choose.mockResolvedValue(action);
    await act(async () => {
      link.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true }));
    });
    expect(writeText).toHaveBeenLastCalledWith(expected);
    expect(choose.mock.lastCall?.[0].some((item) => item.id === "copy-relative")).toBe(
      relative !== null,
    );
    expect(toast).toHaveBeenLastCalledWith(
      expect.objectContaining({ type: "success", description: expected }),
    );
  }
});

describe("ChatMarkdown math", () => {
  const renderMath = async (
    text: string,
    options: Partial<Parameters<typeof ChatMarkdown>[0]> = {},
  ) => {
    setMathRenderingEnabled(true);
    await using stack = new AsyncDisposableStack();
    const screen = stack.use(
      await render(<ChatMarkdown cwd="/tmp/project" text={text} {...options} />),
    );
    screen.container.setAttribute("data-assistant-citation-source", "assistant");
    await act(async () => {
      await getScientKatexRuntimePromise();
    });
    stack.move();
    return screen;
  };

  it.each(["$x$", "$$x$$", "```math\nx\n```", "$\\notACommand{x}$"])(
    "keeps keyboard focus on the parent control in compact previews of %s",
    async (formula) => {
      setup();
      setMathRenderingEnabled(true);
      await using screen = await render(
        <>
          <button type="button">
            Preview <ChatMarkdown inline text={formula} cwd={undefined} />
          </button>
          <button type="button">After preview</button>
        </>,
      );
      const { container } = screen;
      await act(async () => {
        await getScientKatexRuntimePromise();
      });
      const [preview, after] = container.querySelectorAll("button");
      preview!.focus();
      await userEvent.tab();
      expect(document.activeElement).toBe(after);
      if (formula.includes("notACommand")) {
        expect(page.getByRole("button", { name: /notACommand/ }).element()).toBe(preview);
      }
    },
  );

  it("keeps message formulas reachable by keyboard", async () => {
    setup();
    setMathRenderingEnabled(true);
    await using screen = await render(
      <>
        <button type="button">Before equation</button>
        <ChatMarkdown text="$x$" cwd={undefined} />
      </>,
    );
    const { container } = screen;
    container.querySelector("button")!.focus();
    await userEvent.tab();
    expect(document.activeElement).toBe(
      container.querySelector('[aria-label="Scroll inline equation"]'),
    );
  });

  it("renders table formulas and exports their TeX instead of duplicate glyph text", async () => {
    setup();
    await using rendered = await renderMath(
      "| Name | Formula |\n| --- | --- |\n| Norm | $|x|$ and \\(\\|y\\|\\) |\n| Price | $5 and $10 |",
    );

    const table = rendered.container.querySelector("table")!;
    expect([...table.rows].map((row) => row.cells.length)).toEqual([2, 2, 2]);
    expect(table.querySelectorAll(".katex")).toHaveLength(2);
    const norm = table.querySelectorAll(".katex")[1]!;
    expect(norm.querySelector(".katex-mathml semantics > mrow")?.textContent).toBe("∥y∥");
    expect(serializeTableElementToCsv(table)).toBe(
      "Name,Formula\nNorm,$$|x|$$ and $$\\|y\\|$$\nPrice,$5 and $10",
    );
    const glyph = table.querySelector(".katex-mathml mi")!.firstChild!;
    const range = document.createRange();
    range.setStart(glyph, 0);
    range.setEnd(glyph, 1);
    const selection = window.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);
    const payload = chatMarkdownClipboardPayload(selection)!;
    expect(payload.text).toBe("$$|x|$$");
    expect(payload.html).toContain("$$|x|$$");
    expect(payload.html).not.toContain("katex");
    expect(captureAssistantTextSelection(rendered.container, selection)?.selector.text).toBe(
      "$$|x|$$",
    );
  });

  it("shows unsupported TeX as source and keeps active TeX commands inert", async () => {
    setup();
    await using rendered = await renderMath(
      "\\(\\notACommand{x}\\) and \\(\\href{https://example.com}{x}\\)",
    );

    expect(rendered.container.textContent).toContain("$$\\notACommand{x}$$");
    expect(rendered.container.querySelector('a[href="https://example.com"]')).toBeNull();
  });

  it("keeps Scient math, prices and authored task offsets independent of the generic setting", async () => {
    setup();
    const text = "Area $\\pi r^2$ costs $5 and $10.\n\n\\[\nE = mc^2\n\\]\n\n- [ ] check \\(x\\)";
    await using off = await renderText(text);
    expect(off.container.querySelectorAll("[data-markdown-math]")).toHaveLength(3);
    await using literal = await renderText("<code>$x$</code>");
    expect(literal.container.querySelector("[data-markdown-math]")).toBeNull();
    expect(literal.container.querySelector("code")?.textContent).toBe("$x$");
    await using html = await renderText(
      '<code class="language-math math-inline"><span>x</span> + y</code>',
    );
    expect(
      html.container.querySelector("[data-markdown-math]")?.getAttribute("data-markdown-copy"),
    ).toBe("$$x + y$$");
    for (const parseRawHtml of [true, false]) {
      let editedText = text;
      await using math = await renderMath(text, {
        parseRawHtml,
        onTaskListChange: ({ markerOffset, checked }) => {
          editedText = setMarkdownTaskChecked(text, markerOffset, checked);
        },
      });
      expect(
        [...math.container.querySelectorAll("[data-markdown-math]")].map((node) =>
          node.getAttribute("data-markdown-copy"),
        ),
      ).toEqual(["$$\\pi r^2$$", "$$\nE = mc^2\n$$\n\n", "$$x$$"]);
      await act(() =>
        math.container.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click(),
      );
      expect(editedText).toBe(text.replace("- [ ]", "- [x]"));
    }
    await using math = await renderMath("-       intro\n\n        $$\n        x^2\n        $$");
    expect(
      [...math.container.querySelectorAll("[data-markdown-math]")].map((node) =>
        node.getAttribute("data-markdown-copy"),
      ),
    ).toEqual(["$$\nx^2\n$$\n\n"]);
  });
});

const fileOpeningThread = {
  environmentId: EnvironmentId.make("file-opening-environment"),
  threadId: ThreadId.make("file-opening-thread"),
};

function fileOpeningDeferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (cause: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

function setupFileOpening() {
  const settings = getClientSettings();
  const panel = useRightPanelStore.getState();
  const sources = useHtmlPdfSourceStore.getState();
  setup();
  htmlOpening.enabled = true;
  return {
    [Symbol.dispose]() {
      htmlOpening.enabled = false;
      clearThreadPreviewState(fileOpeningThread);
      useHtmlPdfSourceStore.setState(sources, true);
      useRightPanelStore.setState(panel, true);
      __setClientSettingsForTests(settings);
    },
  };
}

function fileOpeningLink(container: HTMLElement, index = 0) {
  const link = container.querySelectorAll<HTMLAnchorElement>("a")[index];
  expect(link).toBeDefined();
  return link!;
}

function selectedFileOpeningSurface() {
  return selectSelectedRightPanelSurface(
    useRightPanelStore.getState().byThreadKey,
    fileOpeningThread,
  );
}

describe("ChatMarkdown environment-owned file opening", () => {
  it.each([
    {
      name: "a recovered file",
      href: "notes/missing.md",
      asked: "notes/missing.md",
      answer: {
        _tag: "recovered",
        path: EnvironmentFilePath.make("moved/actual.md"),
        missingPath: EnvironmentFilePath.make("/repo/notes/missing.md"),
      },
      opened: "moved/actual.md",
    },
    {
      name: "an ambiguous file",
      href: "notes/missing.md",
      asked: "notes/missing.md",
      answer: {
        _tag: "tie",
        paths: [EnvironmentFilePath.make("a/missing.md"), EnvironmentFilePath.make("b/missing.md")],
        missingPath: EnvironmentFilePath.make("/repo/notes/missing.md"),
      },
      opened: "notes/missing.md",
    },
    {
      name: "an authored home link outside the workspace",
      href: "~/notes/today.md",
      asked: "~/notes/today.md",
      answer: { _tag: "literal", path: EnvironmentFilePath.make("/home/host/notes/today.md") },
      opened: "/home/host/notes/today.md",
    },
    {
      name: "an authored home link inside the workspace",
      href: "~/notes/today.md",
      asked: "~/notes/today.md",
      answer: { _tag: "literal", path: EnvironmentFilePath.make("/repo/notes/today.md") },
      opened: "notes/today.md",
    },
    {
      name: "a workspace directory literally named tilde",
      href: "./~/notes/today.md",
      asked: "/repo/~/notes/today.md",
      answer: { _tag: "literal", path: EnvironmentFilePath.make("/repo/~/notes/today.md") },
      opened: "~/notes/today.md",
    },
  ] satisfies Array<{
    name: string;
    href: string;
    asked: string;
    answer: EnvironmentFileLinkResolution;
    opened: string;
  }>)("opens $name without guessing or announcing a replacement", async (scenario) => {
    using _environment = setupFileOpening();
    using toast = vi.spyOn(toastManager, "add").mockReturnValue("file-opening-toast");
    resolveFileLink.mockResolvedValue(AsyncResult.success(scenario.answer));
    using opened = vi.spyOn(useRightPanelStore.getState(), "openFile");
    await using screen = await renderText(`[Open](${scenario.href}:7)`, {
      cwd: "/repo",
      threadRef: fileOpeningThread,
    });

    await act(() => fileOpeningLink(screen.container).click());

    expect(resolveFileLink).toHaveBeenCalledExactlyOnceWith({
      environmentId: fileOpeningThread.environmentId,
      input: { workspaceRoot: "/repo", path: scenario.asked, changedPaths: [] },
    });
    expect(opened).toHaveBeenCalledExactlyOnceWith(fileOpeningThread, scenario.opened, 7);
    expect(selectedFileOpeningSurface()).toMatchObject({
      kind: "file",
      relativePath: scenario.opened,
      revealLine: 7,
    });
    expect(toast).not.toHaveBeenCalled();
    expect(htmlOpening.mint).not.toHaveBeenCalled();
    expect(htmlOpening.open).not.toHaveBeenCalled();
  });

  it.each([
    { route: "file", href: "/outside/old.md", superseding: "panel" },
    { route: "media", href: "/outside/old.png", superseding: "link" },
    { route: "HTML", href: "/outside/old.html", superseding: "panel" },
  ] as const)("ignores a superseded $route environment answer", async ({ href, superseding }) => {
    using _environment = setupFileOpening();
    const answer = fileOpeningDeferred<AtomCommandResult<EnvironmentFileLinkResolution, unknown>>();
    resolveFileLink.mockReturnValueOnce(answer.promise);
    const expanded = vi.fn();
    using opened = vi.spyOn(useRightPanelStore.getState(), "openFile");
    await using screen = await renderText(`[Open](${href}) and [Later](/outside/new.md:9)`, {
      cwd: "/repo",
      threadRef: fileOpeningThread,
      onImageExpand: expanded,
    });
    await act(() => fileOpeningLink(screen.container).click());
    expect(resolveFileLink).toHaveBeenCalledOnce();
    expect(opened).not.toHaveBeenCalled();
    const revision = useRightPanelStore.getState().getUserActionRevision(fileOpeningThread);
    await act(() => {
      if (superseding === "link") fileOpeningLink(screen.container, 1).click();
      else useRightPanelStore.getState().openFile(fileOpeningThread, "/outside/new.md", 9);
    });
    expect(useRightPanelStore.getState().getUserActionRevision(fileOpeningThread)).toBeGreaterThan(
      revision,
    );
    await act(async () => {
      answer.resolve(
        AsyncResult.success({ _tag: "literal", path: EnvironmentFilePath.make(href) }),
      );
      await answer.promise;
    });

    expect(opened).toHaveBeenCalledExactlyOnceWith(fileOpeningThread, "/outside/new.md", 9);
    expect(selectedFileOpeningSurface()).toMatchObject({
      kind: "file",
      relativePath: "/outside/new.md",
      revealLine: 9,
    });
    expect(expanded).not.toHaveBeenCalled();
    expect(htmlOpening.mint).not.toHaveBeenCalled();
    expect(htmlOpening.open).not.toHaveBeenCalled();
  });

  it("shares one 3000 ms deadline between workspace lookup and environment resolution", async () => {
    using _environment = setupFileOpening();
    const lookup = fileOpeningDeferred<
      AtomCommandResult<
        {
          entries: Array<{ path: string; kind: "file" }>;
          truncated: boolean;
        },
        never
      >
    >();
    const answer = fileOpeningDeferred<AtomCommandResult<EnvironmentFileLinkResolution, unknown>>();
    workspaceSearch.mockReturnValueOnce(lookup.promise);
    resolveFileLink.mockReturnValueOnce(answer.promise);
    using opened = vi.spyOn(useRightPanelStore.getState(), "openFile");
    await using screen = await renderText("[Open](physics/notes/a.md:7)", {
      cwd: "/school/physics",
      threadRef: fileOpeningThread,
    });
    using _clock = fakeTimers();
    await act(() => fileOpeningLink(screen.container).click());
    expect(workspaceSearch).toHaveBeenCalledOnce();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
      lookup.resolve(
        AsyncResult.success({
          entries: [{ path: "notes/a.md", kind: "file" }],
          truncated: false,
        }),
      );
      await lookup.promise;
    });
    expect(resolveFileLink).toHaveBeenCalledOnce();
    await act(() => vi.advanceTimersByTimeAsync(999));
    expect(opened).not.toHaveBeenCalled();
    await act(() => vi.advanceTimersByTimeAsync(1));
    expect(opened).toHaveBeenCalledExactlyOnceWith(fileOpeningThread, "notes/a.md", 7);
    await act(async () => {
      answer.resolve(
        AsyncResult.success({
          _tag: "recovered",
          path: EnvironmentFilePath.make("late/other.md"),
          missingPath: EnvironmentFilePath.make("/school/physics/notes/a.md"),
        }),
      );
      await answer.promise;
    });
    expect(opened).toHaveBeenCalledOnce();
  });

  it.each([
    {
      name: "workspace",
      href: "report.html",
      asked: "/repo/report.html",
      kind: "workspace-file",
      path: "/repo/report.html",
    },
    {
      name: "host",
      href: "/outside/report.html",
      asked: "/outside/report.html",
      kind: "environment-file",
      path: "/outside/report.html",
    },
    // An authored ~/ link is asked unexpanded, as the file table's home rows check.
  ] as const)("opens $name HTML through its owning authorized Browser path", async (scenario) => {
    using _environment = setupFileOpening();
    const api = readLocalApi();
    if (!api) throw new Error("Local API unavailable");
    using external = vi.spyOn(api.shell, "openExternal").mockResolvedValue(undefined);
    resolveFileLink.mockResolvedValue(
      AsyncResult.success({
        _tag: "literal",
        path: EnvironmentFilePath.make(scenario.path),
      }),
    );
    using opened = vi.spyOn(useRightPanelStore.getState(), "openFile");
    using toast = vi.spyOn(toastManager, "add").mockReturnValue("file-opening-toast");
    await using screen = await renderText(`[Open](${scenario.href})`, {
      cwd: "/repo",
      threadRef: fileOpeningThread,
    });
    await act(() => fileOpeningLink(screen.container).click());

    expect(resolveFileLink).toHaveBeenCalledExactlyOnceWith({
      environmentId: fileOpeningThread.environmentId,
      input: { workspaceRoot: "/repo", path: scenario.asked, changedPaths: [] },
    });
    expect(htmlOpening.mint).toHaveBeenCalledExactlyOnceWith({
      environmentId: fileOpeningThread.environmentId,
      input: {
        resource:
          scenario.kind === "environment-file"
            ? { _tag: "environment-file", path: scenario.path, access: "html-document" }
            : {
                _tag: "workspace-file",
                cwd: "/repo",
                relativePath: "report.html",
                threadId: fileOpeningThread.threadId,
                path: scenario.path,
              },
      },
    });
    expect(htmlOpening.open).toHaveBeenCalledExactlyOnceWith({
      environmentId: fileOpeningThread.environmentId,
      input: {
        threadId: fileOpeningThread.threadId,
        url: "https://file-host.test/api/assets/authorized.html",
        viewport: getBrowserDefaults().viewport,
        profileId: getBrowserDefaults().profileId,
        runtime: "server",
      },
    });
    expect(selectedFileOpeningSurface()).toMatchObject({
      kind: "preview",
      resourceId: "authorized-html",
    });
    expect(readHtmlPdfRelation(fileOpeningThread, "authorized-html")).toMatchObject({
      threadRef: fileOpeningThread,
      authorizedUrl: "https://file-host.test/api/assets/authorized.html",
      source:
        scenario.kind === "environment-file"
          ? {
              _tag: "environment-html",
              environmentId: fileOpeningThread.environmentId,
              canonicalPath: scenario.path,
            }
          : {
              _tag: "workspace-html",
              environmentId: fileOpeningThread.environmentId,
              relativePath: "report.html",
            },
    });
    expect(opened).not.toHaveBeenCalled();
    expect(external).not.toHaveBeenCalled();
    expect(htmlOpening.editor).not.toHaveBeenCalled();
    expect(toast).not.toHaveBeenCalled();
  });

  it.each(["result", "rejection"] as const)(
    "falls back to the file surface after a current Browser %s failure",
    async (failure) => {
      using _environment = setupFileOpening();
      const error = new Error("Synthetic Browser failure");
      if (failure === "result")
        htmlOpening.open.mockResolvedValueOnce(AsyncResult.failure(Cause.die(error)));
      else htmlOpening.open.mockRejectedValueOnce(error);
      using opened = vi.spyOn(useRightPanelStore.getState(), "openFile");
      using toast = vi.spyOn(toastManager, "add").mockReturnValue("file-opening-toast");
      await using screen = await renderText("[Open](/outside/report.html:7)", {
        cwd: "/repo",
        threadRef: fileOpeningThread,
      });
      await act(() => fileOpeningLink(screen.container).click());

      expect(htmlOpening.open).toHaveBeenCalledOnce();
      expect(opened).toHaveBeenCalledExactlyOnceWith(fileOpeningThread, "/outside/report.html", 7);
      expect(selectedFileOpeningSurface()).toMatchObject({
        kind: "file",
        relativePath: "/outside/report.html",
        revealLine: 7,
      });
      expect(toast).toHaveBeenCalledWith(
        expect.objectContaining({ title: "Unable to open file in browser" }),
      );
    },
  );

  it.each([
    ...(
      [
        // openFileInPreview checks the intent after each await; a success and a failure
        // result share that check, a rejection leaves through the caller's catch, and the
        // settings read converts its rejection, so each stage keeps its distinct exits.
        { href: "/outside/old.html", stage: "authorization", outcome: "failure" },
        { href: "/outside/old.html", stage: "authorization", outcome: "rejection" },
        { href: "/outside/old.html", stage: "settings", outcome: "success" },
        { href: "/outside/old.html", stage: "Browser", outcome: "failure" },
        { href: "/outside/old.html", stage: "Browser", outcome: "rejection" },
        { href: "old.html", stage: "authorization", outcome: "success" },
      ] as const
    ).map((scenario) => ({ ...scenario, superseding: "link" as const })),
    { href: "/outside/old.html", stage: "Browser", outcome: "success", superseding: "panel" },
  ] as const)(
    "keeps newer $superseding intent after $href $stage $outcome completes",
    async ({ href, stage, outcome, superseding }) => {
      using _environment = setupFileOpening();
      const authorization = fileOpeningDeferred<AtomCommandResult<AssetCreateUrlResult, unknown>>();
      const defaults = fileOpeningDeferred<BrowserDefaults>();
      const browser = fileOpeningDeferred<AtomCommandResult<PreviewSessionSnapshot, unknown>>();
      if (stage === "authorization") htmlOpening.mint.mockReturnValueOnce(authorization.promise);
      if (stage === "settings") htmlOpening.defaults.mockReturnValueOnce(defaults.promise);
      if (stage === "Browser") htmlOpening.open.mockReturnValueOnce(browser.promise);
      using opened = vi.spyOn(useRightPanelStore.getState(), "openFile");
      using toast = vi.spyOn(toastManager, "add").mockReturnValue("file-opening-toast");
      await using screen = await renderText(`[Open](${href}) and [Later](/outside/new.md:9)`, {
        cwd: "/repo",
        threadRef: fileOpeningThread,
      });
      await act(() => fileOpeningLink(screen.container).click());
      expect(htmlOpening.mint).toHaveBeenCalledOnce();
      if (stage === "settings") expect(htmlOpening.defaults).toHaveBeenCalledOnce();
      if (stage === "Browser") expect(htmlOpening.open).toHaveBeenCalledOnce();

      // Keep the newer click unresolved: sequence invalidation must work before a panel revision changes.
      const newer =
        fileOpeningDeferred<AtomCommandResult<EnvironmentFileLinkResolution, unknown>>();
      const revision = useRightPanelStore.getState().getUserActionRevision(fileOpeningThread);
      await act(() => {
        if (superseding === "link") {
          resolveFileLink.mockReturnValueOnce(newer.promise);
          fileOpeningLink(screen.container, 1).click();
        } else {
          useRightPanelStore.getState().openFile(fileOpeningThread, "/outside/new.md", 9);
        }
      });
      if (superseding === "link") {
        expect(useRightPanelStore.getState().getUserActionRevision(fileOpeningThread)).toBe(
          revision,
        );
      } else {
        expect(
          useRightPanelStore.getState().getUserActionRevision(fileOpeningThread),
        ).toBeGreaterThan(revision);
      }
      const selection = selectedFileOpeningSurface()?.id;
      const error = new Error("Obsolete HTML open failed");
      await act(async () => {
        if (stage === "authorization") {
          if (outcome === "rejection") authorization.reject(error);
          else
            authorization.resolve(
              outcome === "failure"
                ? AsyncResult.failure(Cause.die(error))
                : AsyncResult.success({ relativeUrl: "/api/assets/old.html", expiresAt: 1 }),
            );
        } else if (stage === "settings") {
          // A rejected settings read becomes the defaults, so it leaves like a success.
          defaults.resolve(getBrowserDefaults());
        } else {
          if (outcome === "rejection") browser.reject(error);
          else
            browser.resolve(
              outcome === "failure"
                ? AsyncResult.failure(Cause.die(error))
                : AsyncResult.success({
                    threadId: fileOpeningThread.threadId,
                    tabId: "obsolete-html",
                    navStatus: { _tag: "Idle" },
                    canGoBack: false,
                    canGoForward: false,
                    updatedAt: "2026-10-01T00:00:00.000Z",
                  }),
            );
        }
        await (
          stage === "authorization"
            ? authorization.promise
            : stage === "settings"
              ? defaults.promise
              : browser.promise
        ).catch(() => undefined);
      });
      expect(opened).toHaveBeenCalledTimes(superseding === "link" ? 0 : 1);
      expect(selectedFileOpeningSurface()?.id).toBe(selection);
      expect(htmlOpening.open).toHaveBeenCalledTimes(stage === "Browser" ? 1 : 0);
      expect(readHtmlPdfRelation(fileOpeningThread, "obsolete-html")).toBeNull();
      expect(toast).not.toHaveBeenCalled();

      if (superseding === "link") {
        await act(async () => {
          newer.resolve(
            AsyncResult.success({
              _tag: "literal",
              path: EnvironmentFilePath.make("/outside/new.md"),
            }),
          );
          await newer.promise;
        });
      }
      expect(opened).toHaveBeenCalledExactlyOnceWith(fileOpeningThread, "/outside/new.md", 9);
      expect(selectedFileOpeningSurface()).toMatchObject({
        kind: "file",
        relativePath: "/outside/new.md",
        revealLine: 9,
      });
    },
  );
});
