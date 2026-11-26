import { DEFAULT_THEMES, preloadHighlighter } from "@pierre/diffs";
import { EnvironmentId, ThreadId, type ProjectReadFileResult } from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";
import { StrictMode, useSyncExternalStore, type ReactNode } from "react"; // SCIENT-FORK: useDraft
import { describe, expect, it, vi } from "vite-plus/test";
import { cdp, userEvent } from "vite-plus/test/browser";
import { act, fakeTimers, render } from "../../../test/render";
import appCss from "~/index.css?inline";
import { isMacPlatform } from "~/lib/utils";
import {
  createWorkspaceFocusController,
  requestWorkspaceFocus, // SCIENT-FORK: Scient's panel focus cases
  startWorkspaceFocus,
  workspaceAreaProps,
} from "~/lib/workspaceFocus";
// SCIENT-FORK:START — Scient's panel focus cases open Compute files in Results.
import { computeFileContextId } from "~/scient/compute/computeContextStore";
import { useComputeFilePresentationStore } from "~/scient/compute/computeFilePresentationStore";
// SCIENT-FORK:END

// SCIENT-FORK:START — Scient's read result has a revision and its URL state a refresh, which T3's
// fixtures leave out; the mocks hand them on as the real types.
type TestReadFile = Omit<ProjectReadFileResult, "revision">;
type TestAssetUrl =
  | { readonly _tag: "Loading" }
  | { readonly _tag: "Success"; url: string; expiresAt: number; fileRevision?: string };
const state = vi.hoisted(() => ({
  file: null as TestReadFile | null,
  optimistic: null as TestReadFile | null,
  writeFile: vi.fn(),
  assetUrl: { _tag: "Loading" } as TestAssetUrl,
  // SCIENT-FORK:END
  assetResources: [] as Array<import("@t3tools/contracts").AssetResource>,
  mintUrl: vi.fn<() => Promise<string | null>>(),
  browserAssetMints: 0,
  openedBrowserUrls: [] as string[],
}));

vi.mock(import("@t3tools/client-runtime/state/runtime"), async (original) => ({
  ...(await original()),
  runAtomCommand: ((_registry: unknown, _command: unknown, request: unknown) =>
    state.writeFile(request)) as never,
}));
vi.mock(import("~/state/session"), async (original) => ({
  ...(await original()),
  readEnvironmentScope: () => true,
  useEnvironmentScope: () => true,
}));
vi.mock(import("~/state/filesystem"), async (original) => ({
  ...(await original()),
  useFilesystemReadAccess: () => ({ canReadFiles: true, isPending: false, error: null }),
}));
vi.mock(import("~/state/use-atom-command"), async (original) => ({
  ...(await original()),
  useAtomCommand: (() => state.writeFile) as never,
}));
vi.mock(import("~/state/server"), async (original) => {
  const actual = await original();
  const { Atom } = await import("effect/reactivity");
  const noConfig = Atom.make(null);
  return {
    ...actual,
    serverEnvironment: { ...actual.serverEnvironment, configValueAtom: (() => noConfig) as never },
  };
});
vi.mock(import("~/remoteOpen"), async (original) => ({
  ...(await original()),
  useRemoteOpenState: () => ({ mode: "local-exec" }) as never,
  useRemoteOpenResolution: () => ({ state: { mode: "local-exec" }, isResolved: true }) as never,
}));
vi.mock(import("~/hooks/useTheme"), async (original) => ({
  ...(await original()),
  useTheme: () => ({ resolvedTheme: "dark" }) as never,
}));
vi.mock(import("~/hooks/useWorkspaceMutationRefresh"), () => ({
  useWorkspaceMutationRefresh: vi.fn(),
}));
vi.mock(import("~/assets/assetUrls"), async (original) => ({
  ...(await original()),
  useAssetUrlRefresh: () => state.mintUrl,
  useAssetUrlState: (
    _environmentId: unknown,
    resource: import("@t3tools/contracts").AssetResource | null,
  ) => {
    if (resource) state.assetResources.push(resource);
    return state.assetUrl as import("~/assets/assetUrls").AssetUrlState; // SCIENT-FORK: see TestAssetUrl
  },
}));
vi.mock(import("~/browser/previewRuntime"), async (original) => ({
  ...(await original()),
  usePreviewAvailable: () => true,
}));
vi.mock(import("~/state/environments"), async (original) => ({
  ...(await original()),
  useEnvironmentHttpBaseUrl: () => "http://environment.test",
}));
vi.mock(import("~/state/assets"), async (original) => {
  const actual = await original();
  const { Atom } = await import("effect/reactivity");
  const Effect = await import("effect/Effect");
  // Like the real query family, a minted URL stays cached until the atom is refreshed.
  const createUrl = Atom.family((_key: string) =>
    Atom.make(
      Effect.sync(() => ({
        relativeUrl: `/api/assets/mint-${++state.browserAssetMints}/page.html`,
        expiresAt: Number.MAX_SAFE_INTEGER,
      })),
    ).pipe(Atom.keepAlive),
  );
  return {
    ...actual,
    assetEnvironment: {
      ...actual.assetEnvironment,
      createUrl: ((target: { input: { resource: { path: string } } }) =>
        createUrl(target.input.resource.path)) as never,
    },
  };
});
vi.mock(import("~/browser/openFileInPreview"), async (original) => {
  const actual = await original();
  return {
    ...actual,
    openFileInPreview: (async (input: Parameters<typeof actual.openFileInPreview>[0]) => {
      const result = await input.createAssetUrl({
        environmentId: input.threadRef.environmentId,
        input: {
          resource: {
            _tag: "workspace-file",
            threadId: input.threadRef.threadId,
            path: input.filePath,
          },
        },
      });
      if (result._tag === "Success") state.openedBrowserUrls.push(result.value.relativeUrl);
      return AsyncResult.success(undefined);
    }) as never,
  };
});
// The Word engine compiles a large WebAssembly bundle; these tests only need the URL it loads.
vi.mock(import("./OfficeFilePreview"), () => ({
  OfficeFilePreview: ({ src }: { src: string }) => <div data-testid="office-preview">{src}</div>,
}));
vi.mock(import("./FileBreadcrumbs"), () => ({ FileBreadcrumbs: () => <></> }));
vi.mock(import("./FileBrowserPanel"), () => ({
  default: () => (
    <div role="tree">
      <button type="button" role="treeitem" data-item-path="src/">
        src
      </button>
      <button type="button" role="treeitem" data-item-path="server.ts">
        server.ts
      </button>
    </div>
  ),
}));
vi.mock(import("../DiffWorkerPoolProvider"), () => ({
  DiffWorkerPoolProvider: ({ children }: { children?: ReactNode }) => <>{children}</>,
}));
vi.mock(import("./projectFilesQueryState"), async (original) => ({
  ...(await original()),
  useProjectFileQuery: () => ({
    data: (useDraft() ?? state.file) as ProjectReadFileResult | null, // SCIENT-FORK: shows the draft
    error: null,
    isPending: false,
    readError: null,
    isNotFile: false,
    isFile: true,
    // SCIENT-FORK:START — Scient's query also reports the last read and failure details.
    authoritativeData: state.file as ProjectReadFileResult | null,
    failure: null,
    failureReason: null,
    failureOsErrorCode: null,
    isMissing: false,
    // SCIENT-FORK:END
    refresh: vi.fn(),
  }),
  getOptimisticProjectFileQueryData: () => state.optimistic as ProjectReadFileResult | null, // SCIENT-FORK
  getUnsavedProjectFileQueryData: () => null,
  setProjectFileQueryData: (
    _environmentId: EnvironmentId,
    _cwd: string,
    relativePath: string,
    contents: string,
  ) => {
    state.optimistic = { relativePath, contents, truncated: false, byteLength: contents.length };
    for (const listener of draftListeners) listener(); // SCIENT-FORK: see useDraft
  },
  confirmProjectFileQueryData: () => true,
}));

import FilePreviewPanel from "./FilePreviewPanel";

// SCIENT-FORK:START — Scient's editor takes the query's data as the file's latest version, so the
// query re-renders with each draft, as the real one does.
const draftListeners = new Set<() => void>();
function useDraft() {
  return useSyncExternalStore(
    (listener) => {
      draftListeners.add(listener);
      return () => draftListeners.delete(listener);
    },
    () => state.optimistic,
  );
}
// SCIENT-FORK:END

const environmentId = EnvironmentId.make("markdown-preview-test");
const threadRef = { environmentId, threadId: ThreadId.make("thread") };
function setup() {
  const keys = ["t3code.fileExplorerOpen", "t3code.renderMarkdown"];
  const previous = keys.map((key) => localStorage.getItem(key));
  localStorage.setItem(keys[0]!, "false");
  localStorage.setItem(keys[1]!, "true");
  state.file = null;
  state.optimistic = null;
  state.assetUrl = { _tag: "Loading" };
  state.assetResources = [];
  state.openedBrowserUrls = [];
  let mints = 0;
  state.mintUrl.mockReset().mockImplementation(async () => `/assets/report.docx?mint=${++mints}`);
  state.writeFile.mockReset().mockResolvedValue(AsyncResult.success(undefined));
  return {
    [Symbol.dispose]() {
      for (const [index, key] of keys.entries()) {
        const value = previous[index];
        if (value == null) localStorage.removeItem(key);
        else localStorage.setItem(key, value);
      }
    },
  };
}

function markdownPreview(
  truncated: boolean,
  contents = "- [ ] Keep the rest of this file\n",
  relativePath = "tasks.md",
) {
  state.file = {
    relativePath,
    contents,
    byteLength: truncated ? 1_200_000 : contents.length,
    truncated,
  };
  return filePreview(relativePath);
}

function filePreview(relativePath: string, workspaceMutationId: string | null = null) {
  return (
    <FilePreviewPanel
      environmentId={environmentId}
      cwd="/workspace"
      projectName="Project"
      relativePath={relativePath}
      threadRef={threadRef}
      composerDraftTarget={threadRef}
      keybindings={[]}
      availableEditors={[]}
      openInShortcutEnabled={false}
      revealLine={null}
      revealRequestId={0}
      onOpenFile={vi.fn()}
      // SCIENT-FORK:START — the panel's Scient props
      htmlPresentationRequest={null}
      latexPresentationRequest={null}
      latexRootRelativePath={null}
      onFileMoved={vi.fn()}
      onFileRenamed={vi.fn()}
      onOpenFileSource={vi.fn()}
      onHtmlPresentationRequestHandled={vi.fn()}
      onLatexPresentationRequestHandled={vi.fn()}
      // SCIENT-FORK:END
      onNavigateFolder={vi.fn()}
      folderTrail={undefined}
      onPendingChange={vi.fn()}
      selectedFilePending={false}
      workspaceMutationId={workspaceMutationId}
    />
  );
}

function documentPreview(workspaceMutationId: string, fileRevision: string) {
  state.file = null;
  state.assetUrl = {
    _tag: "Success",
    url: "/assets/report.docx",
    expiresAt: Number.MAX_SAFE_INTEGER,
    fileRevision,
  };
  return filePreview("report.docx", workspaceMutationId);
}

function deepActiveElement() {
  let active = document.activeElement;
  while (active?.shadowRoot?.activeElement) active = active.shadowRoot.activeElement;
  return active;
}

describe("source file focus", () => {
  it("hands panel focus to the file's editor, which owns mod+f", async () => {
    using _settings = setup();
    const style = document.createElement("style");
    style.textContent = appCss;
    document.head.append(style);
    using _style = { [Symbol.dispose]: () => style.remove() };
    await preloadHighlighter({ themes: Object.values(DEFAULT_THEMES), langs: ["typescript"] });
    const panel = () => (
      <div {...workspaceAreaProps("panel", 1, "Workspace panel")}>
        <div data-right-panel-surface-content>{filePreview("server.ts")}</div>
      </div>
    );
    const editorHasFocus = () => expect(deepActiveElement()?.matches("[data-content]")).toBe(true);

    await using screen = await render(panel());
    const focus = createWorkspaceFocusController(document);
    using _focus = { [Symbol.dispose]: focus.dispose };
    expect(focus.focus("panel")).toBe(true);
    state.file = {
      relativePath: "server.ts",
      contents: "const server = 1;\n",
      byteLength: 18,
      truncated: false,
    };
    await screen.rerender(panel());
    await vi.waitFor(editorHasFocus);
    await userEvent.keyboard("x");
    await vi.waitFor(() => expect(deepActiveElement()?.textContent).toContain("xconst server"));

    (deepActiveElement() as HTMLElement).blur();
    expect(focus.focus("panel", false)).toBe(true);
    await vi.waitFor(editorHasFocus);
    await userEvent.keyboard(
      isMacPlatform(navigator.platform) ? "{Meta>}f{/Meta}" : "{Control>}f{/Control}",
    );
    await vi.waitFor(() => expect(deepActiveElement()).toBeInstanceOf(HTMLInputElement));

    const findField = deepActiveElement() as HTMLInputElement;
    await userEvent.keyboard("server");
    findField.blur();
    expect(focus.focus("panel", false)).toBe(true);
    await vi.waitFor(editorHasFocus);
    const editor = deepActiveElement() as HTMLElement;
    await userEvent.keyboard("ab");
    await vi.waitFor(() => expect(editor.textContent).toContain("xabconst server"));
    expect(findField.value).toBe("server");
    editorHasFocus();
  });

  it("focuses the editor when a file row is clicked or activated with Enter", async () => {
    using _settings = setup();
    localStorage.setItem("t3code.fileExplorerOpen", "true");
    const style = document.createElement("style");
    style.textContent = appCss;
    document.head.append(style);
    using _style = { [Symbol.dispose]: () => style.remove() };
    await preloadHighlighter({ themes: Object.values(DEFAULT_THEMES), langs: ["typescript"] });
    state.file = {
      relativePath: "server.ts",
      contents: "const server = 1;\n",
      byteLength: 18,
      truncated: false,
    };
    await using screen = await render(
      <div {...workspaceAreaProps("panel", 1, "Workspace panel")} style={{ width: 900 }}>
        <div data-right-panel-surface-content>{filePreview("server.ts")}</div>
      </div>,
    );
    using _focus = {
      [Symbol.dispose]: startWorkspaceFocus({ subscribe: () => () => {} } as never),
    };
    const editorHasFocus = () => expect(deepActiveElement()?.matches("[data-content]")).toBe(true);
    // The explorer measures its parent row; a wrapper without a box would cap it at the minimum.
    await expect
      .element(screen.getByRole("separator", { name: "Resize file explorer" }))
      .toHaveAttribute("aria-valuemax", "560");
    const folderRow = screen.getByRole("treeitem", { name: "src" });
    const fileRow = screen.getByRole("treeitem", { name: "server.ts" });

    (folderRow.element() as HTMLElement).focus();
    await userEvent.keyboard("{Enter}");
    expect(document.activeElement).toBe(folderRow.element());

    await userEvent.click(fileRow);
    await vi.waitFor(editorHasFocus);

    (fileRow.element() as HTMLElement).focus();
    await userEvent.keyboard("{Enter}");
    await vi.waitFor(editorHasFocus);
  });
});

describe("source file scroll", () => {
  it("returns a file tab to where it was scrolled after another file was shown", async () => {
    using _settings = setup();
    const style = document.createElement("style");
    style.textContent = appCss;
    document.head.append(style);
    using _style = { [Symbol.dispose]: () => style.remove() };
    await preloadHighlighter({ themes: Object.values(DEFAULT_THEMES), langs: ["typescript"] });
    const sourceFile = (relativePath: string, lines: number) => {
      const contents = Array.from({ length: lines }, (_, i) => `const line${i} = ${i};`).join("\n");
      state.file = { relativePath, contents, byteLength: contents.length, truncated: false };
      // The app mounts under StrictMode, whose remount must not wipe the saved offset.
      return (
        <StrictMode>
          <div style={{ height: 400, display: "flex", flexDirection: "column" }}>
            {filePreview(relativePath)}
          </div>
        </StrictMode>
      );
    };
    const scroller = () => document.querySelector<HTMLElement>(".file-preview-virtualizer");

    await using screen = await render(sourceFile("a.ts", 2000));
    await vi.waitFor(() => expect(scroller()?.scrollHeight).toBeGreaterThan(5000));
    scroller()!.scrollTop = 4200;
    await vi.waitFor(() => expect(scroller()?.scrollTop).toBe(4200));

    await screen.rerender(sourceFile("b.ts", 1500));
    await vi.waitFor(() => expect(scroller()?.scrollTop).toBe(0));
    await screen.rerender(sourceFile("a.ts", 2000));

    await vi.waitFor(() => expect(scroller()?.scrollTop).toBe(4200));
  });

  it.each([
    {
      label: "keeps a downward drag whose anchor stays mounted across a window shift",
      startLine: 65,
      initialScrollLine: 65,
      direction: "down" as const,
      targetFirstMounted: 101,
      expectedIncludedLine: 121,
    },
    {
      label: "keeps a downward drag whose anchor unmounts on a window shift",
      startLine: 5,
      initialScrollLine: null,
      direction: "down" as const,
      targetFirstMounted: 101,
      expectedIncludedLine: 121,
    },
    {
      label: "keeps an upward drag whose anchor unmounts on a window shift",
      startLine: 385,
      initialScrollLine: 385,
      direction: "up" as const,
      targetFirstMounted: 201,
      expectedIncludedLine: 290,
    },
  ])(
    "$label",
    async ({
      startLine,
      initialScrollLine,
      direction,
      targetFirstMounted,
      expectedIncludedLine,
    }) => {
      using _settings = setup();
      localStorage.setItem("t3code.renderMarkdown", "false");
      const style = document.createElement("style");
      style.textContent = appCss;
      document.head.append(style);
      using _style = { [Symbol.dispose]: () => style.remove() };
      await preloadHighlighter({ themes: Object.values(DEFAULT_THEMES), langs: ["markdown"] });

      const lines = Array.from({ length: 400 }, (_, index) => `line ${index + 1} markdown content`);
      const contents = `${lines.join("\n")}\n`;
      state.file = {
        // SCIENT-FORK: Markdown opens in a document session; a text file reaches the same editor.
        relativePath: "notes.txt",
        contents,
        byteLength: contents.length,
        truncated: false,
      };

      await using screen = await render(
        <div style={{ width: 560, height: 400, display: "flex", flexDirection: "column" }}>
          {filePreview("notes.txt") /* SCIENT-FORK: as above */}
        </div>,
      );

      const shadowRoot = () => screen.container.querySelector("diffs-container")?.shadowRoot;
      const rows = () => shadowRoot()?.querySelectorAll<HTMLElement>("[data-line]") ?? [];
      await vi.waitFor(() =>
        expect(
          shadowRoot()?.querySelector('[data-content][contenteditable="true"]'),
        ).not.toBeNull(),
      );

      const scroller = screen.container.querySelector<HTMLElement>(".file-preview-virtualizer")!;
      if (initialScrollLine !== null) {
        if (direction === "up") {
          await vi.waitFor(() => expect(scroller.scrollHeight).toBeGreaterThan(5000));
          scroller.scrollTop = scroller.scrollHeight;
          await vi.waitFor(() =>
            expect(
              [...rows()].some((row) => row.getAttribute("data-line") === String(startLine)),
            ).toBe(true),
          );
        }
        const target = [...rows()].find(
          (row) => row.getAttribute("data-line") === String(initialScrollLine),
        );
        expect(target).toBeDefined();
        target!.scrollIntoView({ block: direction === "up" ? "end" : "start" });
        await vi.waitFor(() => expect(scroller.scrollTop).toBeGreaterThan(0));
      }

      const startRow = [...rows()].find(
        (row) => row.getAttribute("data-line") === String(startLine),
      );
      expect(startRow).toBeDefined();
      const startRect = startRow!.getBoundingClientRect();
      const scrollerRect = scroller.getBoundingClientRect();
      const nearEdgeY = direction === "down" ? scrollerRect.bottom - 5 : scrollerRect.top + 5;
      const outsideEdgeY = direction === "down" ? scrollerRect.bottom + 60 : scrollerRect.top - 60;
      const frame = window.frameElement?.getBoundingClientRect();
      const mouse = (type: "mousePressed" | "mouseMoved" | "mouseReleased", x: number, y: number) =>
        cdp().send("Input.dispatchMouseEvent", {
          type,
          x: x + (frame?.left ?? 0),
          y: y + (frame?.top ?? 0),
          button: "left",
          buttons: type === "mouseReleased" ? 0 : 1,
          clickCount: 1,
        });

      const startX = direction === "up" ? startRect.left + 140 : startRect.left + 2;
      // The editor records the drag anchor on the press's selectionchange; drag only after it.
      const anchored = new Promise((resolve) =>
        document.addEventListener("selectionchange", resolve, { once: true }),
      );
      await mouse("mousePressed", startX, startRect.top + 5);
      await anchored;
      await mouse("mouseMoved", startRect.left + 80, nearEdgeY);
      await mouse("mouseMoved", startRect.left + 80, outsideEdgeY);
      await vi.waitFor(() => {
        const firstMounted = Number(rows()[0]?.getAttribute("data-line"));
        if (direction === "down") {
          expect(firstMounted).toBeGreaterThanOrEqual(targetFirstMounted);
        } else {
          expect(firstMounted).toBeLessThanOrEqual(targetFirstMounted);
        }
      });
      await mouse("mouseReleased", startRect.left + 80, outsideEdgeY);

      const overlayRanges = shadowRoot()!.querySelectorAll("[data-selection-range]");
      expect(overlayRanges.length).toBeGreaterThan(0);

      const clipboardData = new DataTransfer();
      const contentEl = shadowRoot()!.querySelector("[data-content]")!;
      const handled = !contentEl.dispatchEvent(
        new ClipboardEvent("copy", {
          clipboardData,
          bubbles: true,
          cancelable: true,
          composed: true,
        }),
      );
      expect(handled).toBe(true);
      const copied = clipboardData.getData("text/plain");
      expect(copied).toContain(`line ${startLine} `);
      expect(copied).toContain(`line ${expectedIncludedLine} markdown content`);
    },
  );

  it("scrolls a find match below many wrapped lines into view", async () => {
    using _settings = setup();
    const style = document.createElement("style");
    style.textContent = appCss;
    document.head.append(style);
    using _style = { [Symbol.dispose]: () => style.remove() };
    await preloadHighlighter({ themes: Object.values(DEFAULT_THEMES), langs: ["typescript"] });
    const wrapped = "wrap ".repeat(60);
    const lines = Array.from({ length: 800 }, (_, i) => `const line${i} = "${wrapped}";`);
    lines.push(
      "const needle = 1;",
      ...Array.from({ length: 40 }, (_, i) => `const tail${i} = ${i};`),
    );
    const contents = lines.join("\n");
    state.file = {
      relativePath: "wrapped.ts",
      contents,
      byteLength: contents.length,
      truncated: false,
    };
    const scroller = () => document.querySelector<HTMLElement>(".file-preview-virtualizer");

    await using _screen = await render(
      <div style={{ width: 500, height: 400, display: "flex", flexDirection: "column" }}>
        {filePreview("wrapped.ts")}
      </div>,
    );
    await vi.waitFor(() => expect(scroller()?.scrollHeight).toBeGreaterThan(20_000));
    const shadowRows = () =>
      [...document.querySelectorAll("*")].flatMap((host) =>
        host.shadowRoot ? [...host.shadowRoot.querySelectorAll<HTMLElement>("[data-line]")] : [],
      );
    await userEvent.click(shadowRows().find((row) => row.getAttribute("data-line") === "1")!);
    await vi.waitFor(() => expect(deepActiveElement()?.matches("[data-content]")).toBe(true));
    await userEvent.keyboard(
      isMacPlatform(navigator.platform) ? "{Meta>}f{/Meta}" : "{Control>}f{/Control}",
    );
    await vi.waitFor(() => expect(deepActiveElement()).toBeInstanceOf(HTMLInputElement));
    await userEvent.keyboard("needle{Enter}");

    const visibleLines = () => {
      const viewport = scroller()!.getBoundingClientRect();
      return shadowRows()
        .filter((row) => {
          const box = row.getBoundingClientRect();
          return box.height > 0 && box.top >= viewport.top && box.bottom <= viewport.bottom;
        })
        .map((row) => Number(row.getAttribute("data-line")));
    };
    await vi.waitFor(() => expect(visibleLines()).toContain(801));
  });
});

describe("rendered Markdown task saves", () => {
  it("renders the whole file of a truncated read, read-only", async () => {
    using _settings = setup();
    state.assetUrl = {
      _tag: "Success",
      url: "/assets/tasks.md",
      expiresAt: Number.MAX_SAFE_INTEGER,
    };
    const realFetch = globalThis.fetch;
    using _fetch = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation((input, init) =>
        new URL(String(input), location.href).pathname === "/assets/tasks.md"
          ? Promise.resolve(
              new Response("- [ ] Keep the rest of this file\n\nPast the first megabyte\n"),
            )
          : realFetch(input, init),
      );
    await using screen = await render(markdownPreview(true));
    await expect.element(screen.getByText("Past the first megabyte")).toBeVisible();
    const checkbox = screen.container.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
    expect(checkbox.disabled).toBe(true);
    await act(async () => checkbox.click());
    expect(state.optimistic).toBeNull();
    expect(state.writeFile).not.toHaveBeenCalled();
  });

  // SCIENT-FORK: a writable .md opens in Scient's Markdown editor, whose task saves are tested in
  // scient/markdownEditor/ScientMarkdownWorkspaceSurface.browser.test.tsx.
});

describe("workspace document previews", () => {
  it("keeps an unchanged document loaded when another workspace change lands", async () => {
    using _settings = setup();
    await using screen = await render(documentPreview("mutation-1", "revision-1"));
    const preview = screen.getByTestId("office-preview");
    await expect.element(preview).toHaveTextContent("/assets/report.docx?mint=1");
    const loaded = preview.element();

    await screen.rerender(documentPreview("mutation-2", "revision-1"));

    expect(state.mintUrl, "an unchanged document re-minted its URL").toHaveBeenCalledOnce();
    expect(screen.container.contains(loaded), "an unchanged document was remounted").toBe(true);
  });

  it("keeps an unchanged document mounted while its revision check reloads", async () => {
    using _settings = setup();
    await using screen = await render(documentPreview("mutation-1", "revision-1"));
    const preview = screen.getByTestId("office-preview");
    await expect.element(preview).toHaveTextContent("/assets/report.docx?mint=1");
    const loaded = preview.element();

    state.assetUrl = { _tag: "Loading" };
    await screen.rerender(filePreview("report.docx", "mutation-1"));
    await screen.rerender(documentPreview("mutation-1", "revision-1"));

    expect(
      state.mintUrl,
      "a reloading revision check re-minted the document URL",
    ).toHaveBeenCalledOnce();
    expect(
      screen.container.contains(loaded),
      "a reloading revision check remounted the document",
    ).toBe(true);
  });

  // SCIENT-FORK: a failed revision check keeps the document as it was read; tested in
  // scient/fileSurfaces/ScientFileRevisionBoundary.browser.test.tsx.
  it("loads the new bytes when the document itself changes", async () => {
    using _settings = setup();
    await using screen = await render(documentPreview("mutation-1", "revision-1"));
    const preview = screen.getByTestId("office-preview");
    await expect.element(preview).toHaveTextContent("/assets/report.docx?mint=1");

    await screen.rerender(documentPreview("mutation-2", "revision-2"));

    await expect.element(preview).toHaveTextContent("/assets/report.docx?mint=2");
  });
});

describe("open file in preview browser", () => {
  it("mints a fresh asset URL on every click so the browser cannot reuse cached bytes", async () => {
    using _settings = setup();
    state.file = {
      relativePath: "page.html",
      contents: "<h1>page</h1>",
      byteLength: 13,
      truncated: false,
    };
    await using screen = await render(filePreview("page.html"));
    const button = screen.getByRole("button", { name: "Open file in preview browser" });

    await userEvent.click(button);
    await vi.waitFor(() => expect(state.openedBrowserUrls).toHaveLength(1));
    await userEvent.click(button);
    await vi.waitFor(() => expect(state.openedBrowserUrls).toHaveLength(2));

    expect(state.openedBrowserUrls[1], "the second click reused the first signed URL").not.toBe(
      state.openedBrowserUrls[0],
    );
  });
});

// SCIENT-FORK: a writable .md opens in Scient's Markdown editor, where Mod+A selects the document;
// tested in scient/markdownEditor/ScientMarkdownWorkspaceSurface.browser.test.tsx.

describe("rendered Markdown relative images", () => {
  it.each([
    // SCIENT-FORK: a project .md opens in Scient's Markdown editor; its image paths are tested in
    // scient/markdownEditor/markdownImageSource.test.ts.
    ["/README.md", "/diagram.png"],
  ])("resolves relative images in %s against its folder", async (relativePath, expectedPath) => {
    using _settings = setup();
    await using _screen = await render(
      markdownPreview(false, "![diagram](diagram.png)\n", relativePath),
    );
    await vi.waitFor(() => expect(state.assetResources).not.toHaveLength(0));
    expect(state.assetResources).toContainEqual(
      expect.objectContaining({ _tag: "media-file", path: expectedPath }),
    );
  });
});

// SCIENT-FORK:START — panel focus asked while a file opens ends on its editor, else on the panel.
describe("panel focus while a file opens", () => {
  const panel = (relativePath: string) => (
    <div {...workspaceAreaProps("panel", 1, "Workspace panel")}>
      <div data-right-panel-surface-content>{filePreview(relativePath)}</div>
    </div>
  );
  async function openWithPanelFocus(relativePath: string) {
    const style = document.createElement("style");
    style.textContent = appCss;
    document.head.append(style);
    const stopFocus = startWorkspaceFocus({ subscribe: () => () => {} } as never);
    const screen = await render(panel(relativePath));
    requestWorkspaceFocus({ area: "panel", selector: "[data-file-content-focus]" });
    await vi.waitFor(() =>
      expect(document.activeElement?.matches("[data-file-content-focus]")).toBe(true),
    );
    const unmount = screen[Symbol.asyncDispose].bind(screen);
    return Object.assign(screen, {
      [Symbol.asyncDispose]: async () => {
        await unmount();
        stopFocus();
        style.remove();
      },
    });
  }
  const contents = (relativePath: string, text: string, readOnly = false) => ({
    relativePath,
    contents: text,
    byteLength: text.length,
    truncated: false,
    ...(readOnly ? { readOnly } : {}),
  });

  it("reaches a Markdown source editor that opens after its document session", async () => {
    using _settings = setup();
    localStorage.setItem("t3code.renderMarkdown", "false");
    await preloadHighlighter({ themes: Object.values(DEFAULT_THEMES), langs: ["markdown"] });
    // The session's first read goes through the mocked command; it answers once released.
    const { promise: sessionRead, resolve: admit } = Promise.withResolvers<void>();
    state.writeFile.mockImplementation(async (request: { input: { contents?: string } }) => {
      if (request.input.contents !== undefined) return AsyncResult.success({ revision: "saved" });
      await sessionRead;
      const bytes = new TextEncoder().encode(state.file!.contents);
      const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
      const revision = `sha256:${Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
      return AsyncResult.success({ ...state.file, revision });
    });
    await using screen = await openWithPanelFocus("notes.md");
    {
      using _frames = fakeTimers();
      state.file = contents("notes.md", "# Notes\n");
      await screen.rerender(panel("notes.md"));
      await expect.element(screen.getByLabelText("Opening editor")).toBeInTheDocument();
      // Focus lost here would be recovered to the panel at the next frame.
      await act(() => vi.advanceTimersToNextFrame());
      expect(document.activeElement?.matches("[data-file-content-focus]")).toBe(true);
    }
    admit();

    await vi.waitFor(() => expect(deepActiveElement()?.matches("[data-content]")).toBe(true));
    await userEvent.keyboard("x");
    await vi.waitFor(() => expect(deepActiveElement()?.textContent).toContain("x# Notes"));
  });

  it("moves to the panel when the file opens read-only", async () => {
    using _settings = setup();
    await using screen = await openWithPanelFocus("server.ts");

    state.file = contents("server.ts", "const server = 1;\n", true);
    await screen.rerender(panel("server.ts"));

    await vi.waitFor(() => {
      const active = document.activeElement;
      expect(active).not.toBe(document.body);
      expect(screen.container.contains(active)).toBe(true);
      expect(active?.matches("[data-file-content-focus]")).toBe(false);
    });
  });

  it("leaves focus the user moved elsewhere while the file opened", async () => {
    using _settings = setup();
    await using screen = await openWithPanelFocus("server.ts");
    const composer = document.createElement("textarea");
    document.body.append(composer);
    using _composer = { [Symbol.dispose]: () => composer.remove() };
    composer.focus();
    using _frames = fakeTimers();

    state.file = contents("server.ts", "const server = 1;\n", true);
    await screen.rerender(panel("server.ts"));
    expect(screen.container.querySelector("[data-file-content-focus]")).toBeNull();
    // Focus recovery would move it at the next frame.
    await act(() => vi.advanceTimersToNextFrame());

    expect(document.activeElement).toBe(composer);
  });

  it("offers no editor target while a Compute file shows only its results", async () => {
    using _settings = setup();
    const contextId = computeFileContextId({
      environmentId,
      threadId: threadRef.threadId,
      cwd: "/workspace",
      relativePath: "analysis.py",
    });
    const presentation = useComputeFilePresentationStore.getState();
    presentation.setFileView(contextId, "results");
    using _view = { [Symbol.dispose]: () => presentation.remove(contextId) };
    // Still loading: no editor will open in Results, so nothing offers to take its focus.
    await using screen = await render(panel("analysis.py"));
    expect(screen.container.querySelector("[data-file-content-focus]")).toBeNull();
    state.file = contents("analysis.py", "print(1)\n");
    await screen.rerender(panel("analysis.py"));
    await expect.element(screen.getByRole("button", { name: "Results" })).toBeInTheDocument();
    expect(screen.container.querySelector("[data-file-content-focus]")).toBeNull();

    await act(async () => presentation.setFileView(contextId, "code"));
    expect(screen.container.querySelector("[data-file-content-focus]")).not.toBeNull();
  });
});
// SCIENT-FORK:END
