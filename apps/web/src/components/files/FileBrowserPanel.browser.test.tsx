import "~/index.css";

import {
  EnvironmentId,
  type ProjectDirectoryEntry,
  type ProjectEntry,
  type ProjectListDirectoryInput,
} from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";
import { COMPOSER_MENTION_DRAG_TYPE } from "~/components/chat/composerMentionDrag";
import { type ReactNode } from "react";
import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";
import { dismissContextMenu, showContextMenuFallback } from "~/contextMenuFallback";
import { act, render } from "../../../test/render";

import { RightPanelSheet } from "~/components/RightPanelSheet";
import { isMacPlatform } from "~/lib/utils";
import FileBrowserPanel from "./FileBrowserPanel";
import { dispatchPreviewAction } from "../preview/previewActionBus";
import { refreshProjectFiles } from "./projectFilesQueryState";
import { writeExpandedDirectories } from "./fileTreeExpansion";
// SCIENT-FORK:START
import { resetOverleafStoreForTests } from "~/scient/overleaf/overleafStore";
// SCIENT-FORK:END

const files = vi.hoisted(() => ({
  directories: {} as Record<string, ProjectDirectoryEntry[]>,
  searchEntries: [] as ProjectEntry[],
  searchPending: false,
  searchError: null as string | null,
  listDirectory: vi.fn(),
  refresh: vi.fn(),
  localApi: undefined as unknown,
}));

vi.mock("~/state/use-atom-command", () => ({
  useAtomCommand: () => files.listDirectory,
}));
vi.mock("~/state/queries", () => ({
  useProjectPathSearch: ({ query }: { query: string }) => ({
    searchedQuery: query.trim(),
    entries: files.searchEntries,
    isPending: files.searchPending,
    error: files.searchError,
    truncated: false,
    refresh: files.refresh,
  }),
}));
// SCIENT-FORK:START — the file actions reach modules that read the theme's other exports
vi.mock("~/hooks/useTheme", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/hooks/useTheme")>()),
  useTheme: () => ({ resolvedTheme: "dark" }),
}));
// SCIENT-FORK:END
vi.mock("~/hooks/useWorkspaceMutationRefresh", () => ({ useWorkspaceMutationRefresh: vi.fn() }));
vi.mock("~/composerHandleContext", () => ({ useComposerHandleContext: () => null }));
vi.mock("~/fileContextMenu", () => ({
  useFileContextMenu: () => ({ buildItems: () => [], activate: () => Promise.resolve() }),
}));
vi.mock("~/localApi", () => ({ readLocalApi: () => files.localApi }));
vi.mock("~/components/ui/toast", () => ({ toastManager: { add: vi.fn() } }));
// SCIENT-FORK:START — Overleaf links of the workspace, for the Connect dialog and the marks
const overleaf = vi.hoisted(() => ({ folders: [] as string[] }));
vi.mock("~/scient/overleaf/client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/scient/overleaf/client")>()),
  listOverleafConnections: async () => ({
    connections: overleaf.folders.map((folder, index) => ({
      connectionId: `c${index}`,
      checkoutRoot: "/workspace",
      folder,
      projectId: "0123456789abcdef01234567",
      branch: "master",
      state: "active",
      completedSyncCount: 1,
      createdAt: "2026-10-24T10:00:00.000Z",
      updatedAt: "2026-10-24T10:00:00.000Z",
      linkedHere: true,
    })),
  }),
  readOverleafStatus: async () => {
    throw new Error("not needed");
  },
  readOverleafToken: async () => ({ saved: true }),
}));
// SCIENT-FORK:END
vi.mock("~/components/ui/tooltip", () => ({
  TooltipProvider: ({ children }: { children: ReactNode }) => children,
  Tooltip: ({ children }: { children: ReactNode }) => children,
  TooltipTrigger: ({ render }: { render: ReactNode }) => render,
  TooltipPopup: () => null,
}));

/** Refresh and expand-all live in the Files menu ("⋯") at the end of the bar. */
async function chooseFromFilesMenu(container: HTMLElement, label: string) {
  const findItem = () =>
    [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(
      (candidate) => candidate.textContent?.trim() === label,
    );
  await act(() =>
    container.querySelector<HTMLButtonElement>('button[aria-label="Files menu"]')!.click(),
  );
  await expect.poll(findItem).toBeDefined();
  await act(() => findItem()!.click());
}

function entry(
  relativePath: string,
  kind: ProjectDirectoryEntry["kind"] = "file",
): ProjectDirectoryEntry {
  return { name: relativePath.split("/").at(-1)!, relativePath, kind, readOnly: false };
}

describe("Files panel search", () => {
  const props = {
    environmentId: EnvironmentId.make("test-environment"),
    cwd: "/workspace",
    projectName: "Test project",
    selectedPath: null,
    selectedPathRevealId: 0,
    onOpenFile: vi.fn(),
    onOpenFileSource: vi.fn(),
    workspaceMutationId: null,
  };

  async function renderPanel({ cwd = props.cwd }: { readonly cwd?: string } = {}) {
    const container = document.createElement("div");
    // The tree virtualizes its rows, so it needs a real viewport to render any.
    container.style.cssText = "display: flex; flex-direction: column; width: 320px; height: 480px;";
    await using stack = new AsyncDisposableStack();
    const screen = stack.use(
      await render(<FileBrowserPanel {...props} cwd={cwd} />, { container }),
    );
    const rerender = () => screen.rerender(<FileBrowserPanel {...props} cwd={cwd} />);
    function searchInput() {
      const input = container!.querySelector<HTMLInputElement>('input[role="searchbox"]');
      expect(input).not.toBeNull();
      return input!;
    }

    async function search(value: string) {
      const input = searchInput();
      // React tracks the last value it saw on the element, so set it through the native setter.
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
      await act(async () => {
        input.dispatchEvent(new Event("input", { bubbles: true }));
      });
    }

    function visiblePaths() {
      const tree = container!.querySelector("file-tree-container");
      if (!tree || getComputedStyle(tree).visibility === "hidden") return [];
      return [...tree.shadowRoot!.querySelectorAll("[data-item-path]")].map((row) =>
        row.getAttribute("data-item-path"),
      );
    }

    function hasMessage(message: string) {
      return [...container!.querySelectorAll("div")].some(
        (node) => node.childNodes.length === 1 && node.textContent === message,
      );
    }

    function expectVisibleLoadingStatus() {
      const status = container!.querySelector<HTMLElement>('[role="status"]');
      expect(status?.textContent).toBe("Loading files…");
      expect(status!.checkVisibility()).toBe(true);
      const bounds = status!.getBoundingClientRect();
      expect(bounds.width).toBeGreaterThan(1);
      expect(bounds.height).toBeGreaterThan(1);
    }

    function rowTop(path: string) {
      const row = container!
        .querySelector("file-tree-container")
        ?.shadowRoot!.querySelector(`[data-item-path="${CSS.escape(path)}"]`);
      expect(row, `visible row ${path}`).not.toBeNull();
      const bounds = row!.getBoundingClientRect();
      expect(bounds.height).toBeGreaterThan(0);
      return bounds.top;
    }

    const environment = stack.move();
    return {
      container,
      searchInput,
      search,
      visiblePaths,
      hasMessage,
      expectVisibleLoadingStatus,
      rowTop,
      rerender,
      [Symbol.asyncDispose]: () => environment.disposeAsync(),
    };
  }
  function setup() {
    files.directories = {
      "": [entry("src", "directory"), entry("package.json")],
      src: [entry("src/app.ts")],
    };
    files.listDirectory.mockReset();
    files.listDirectory.mockImplementation(
      async ({ input }: { input: ProjectListDirectoryInput }) =>
        AsyncResult.success({
          entries: files.directories[input.relativeDirectory] ?? [],
          complete: true,
        }),
    );
    files.searchEntries = [];
    files.searchPending = false;
    files.searchError = null;
    files.refresh.mockReset();
    props.onOpenFile.mockReset();
  }

  it("keeps visible rows stationary during a lazy directory refresh and pending search", async () => {
    setup();
    let finish!: (value: unknown) => void;
    files.listDirectory.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    await using screen = await renderPanel();
    expect(screen.visiblePaths()).toEqual([]);
    expect(screen.hasMessage("Loading files…")).toBe(true);
    await act(() =>
      finish(AsyncResult.success({ entries: files.directories[""], complete: true })),
    );
    await expect.poll(screen.visiblePaths).toEqual(["src/", "package.json"]);
    const initialTop = screen.rowTop("package.json");
    let finishRefresh!: (value: unknown) => void;
    files.listDirectory.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishRefresh = resolve;
        }),
    );
    await chooseFromFilesMenu(screen.container, "Refresh files");
    expect(screen.rowTop("package.json")).toBe(initialTop);
    await act(() =>
      finishRefresh(AsyncResult.success({ entries: files.directories[""], complete: true })),
    );
    await screen.search("pack");
    await expect.poll(screen.visiblePaths).toEqual(["package.json"]);
    const filteredTop = screen.rowTop("package.json");
    files.searchPending = true;
    await screen.search("package");
    expect(screen.rowTop("package.json")).toBe(filteredTop);
    files.searchPending = false;
    await screen.rerender();
    expect(screen.rowTop("package.json")).toBe(filteredTop);
  });

  it("catches up with changes made in other apps on coming back to the window", async () => {
    setup();
    await using screen = await renderPanel();
    await expect.poll(screen.visiblePaths).toEqual(["src/", "package.json"]);
    files.directories[""]!.push(entry("from-elsewhere.tex"));
    window.dispatchEvent(new Event("focus"));
    await act(async () => undefined);
    expect(screen.visiblePaths()).not.toContain("from-elsewhere.tex");
    window.dispatchEvent(new Event("blur"));
    window.dispatchEvent(new Event("focus"));
    await expect.poll(screen.visiblePaths).toContain("from-elsewhere.tex");
  });

  // SCIENT-FORK:START — Refresh on Scient's lazy tree reads only the open folders
  it("refreshes the open folders and unloads a closed one listed before", async () => {
    setup();
    files.directories[""] = [entry("docs", "directory"), ...files.directories[""]!];
    files.directories.docs = [entry("docs/guide.md")];
    await using screen = await renderPanel({ cwd: "/repo-refresh-on-screen" });
    await expect.poll(screen.visiblePaths).toEqual(["docs/", "src/", "package.json"]);
    const treeRow = (path: string) =>
      screen.container
        .querySelector("file-tree-container")!
        .shadowRoot!.querySelector<HTMLElement>(`[data-item-path="${CSS.escape(path)}"]`)!;
    for (const folder of ["docs/", "src/"]) await act(() => treeRow(folder).click());
    await expect.poll(screen.visiblePaths).toContain("docs/guide.md");
    await expect.poll(screen.visiblePaths).toContain("src/app.ts");
    await act(() => treeRow("docs/").click());
    await expect.poll(screen.visiblePaths).not.toContain("docs/guide.md");
    files.listDirectory.mockClear();

    files.directories.src!.push(entry("src/new.ts"));
    await chooseFromFilesMenu(screen.container, "Refresh files");
    await expect.poll(screen.visiblePaths).toContain("src/new.ts");
    expect(
      new Set(files.listDirectory.mock.calls.map(([request]) => request.input.relativeDirectory)),
    ).toEqual(new Set(["", "src"]));
  });
  // SCIENT-FORK:END

  it("shows no matching files instead of the full tree when a filename is absent", async () => {
    setup();
    await using screen = await renderPanel();
    const { searchInput, search, visiblePaths, hasMessage } = screen;
    expect(visiblePaths()).toEqual(["src/", "package.json"]);

    await search(".env.local");
    await expect.poll(visiblePaths).toEqual([]);
    expect(hasMessage(`No files or folders match “${searchInput().value.trim()}”.`)).toBe(true);

    await search("package");
    await expect.poll(visiblePaths).toEqual(["package.json"]);
    expect(hasMessage(`No files or folders match “${searchInput().value.trim()}”.`)).toBe(false);

    await search("");
    await expect.poll(visiblePaths).toEqual(["src/", "package.json"]);
  });

  it("still finds ignored files already loaded from a directory", async () => {
    setup();
    files.directories[""]!.push(entry(".env.local"));
    await using screen = await renderPanel();
    const { searchInput, search, visiblePaths, hasMessage } = screen;
    await search(".env.local");
    await expect.poll(visiblePaths).toEqual([".env.local"]);
    expect(hasMessage(`No files or folders match “${searchInput().value.trim()}”.`)).toBe(false);
  });

  it("waits for remote matches without showing unrelated files or a premature empty result", async () => {
    setup();
    files.directories[""]!.push(entry("config", "directory"));
    await using screen = await renderPanel();
    const { searchInput, search, visiblePaths, hasMessage } = screen;
    files.searchPending = true;
    await search("settings.ts");
    await expect.poll(visiblePaths).toEqual([]);
    expect(hasMessage("Searching…")).toBe(true);
    expect(hasMessage(`No files or folders match “${searchInput().value.trim()}”.`)).toBe(false);

    files.directories.config = [entry("config/settings.ts")];
    files.searchEntries = [{ path: "config/settings.ts", kind: "file" }];
    files.searchPending = false;
    await screen.rerender();
    await expect.poll(visiblePaths).toEqual(["config/", "config/settings.ts"]);
    expect(hasMessage(`No files or folders match “${searchInput().value.trim()}”.`)).toBe(false);
  });

  it("restores the tree on Escape after an unsuccessful search", async () => {
    setup();
    await using screen = await renderPanel();
    const { searchInput, search, visiblePaths, hasMessage } = screen;
    await search("missing-file");
    await expect.poll(visiblePaths).toEqual([]);

    const input = searchInput();
    input.focus();
    await act(async () => {
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    // Clearing a search keeps focus in the field; only an Escape on an empty field leaves it.
    expect(document.activeElement).toBe(input);
    await expect.poll(visiblePaths).toEqual(["src/", "package.json"]);
    expect(hasMessage(`No files or folders match “${searchInput().value.trim()}”.`)).toBe(false);
  });

  it("does not report an empty result when the search failed", async () => {
    setup();
    await using screen = await renderPanel();
    const { container, searchInput, search, visiblePaths, hasMessage } = screen;
    files.searchError = "Workspace search failed.";
    await search("missing-file");
    await expect.poll(visiblePaths).toEqual([]);
    expect(hasMessage(`No files or folders match “${searchInput().value.trim()}”.`)).toBe(false);
    expect(container!.textContent).toContain("Couldn’t search unopened folders.");
  });

  it("expands only known folders without recursively enumerating the workspace", async () => {
    setup();
    files.directories.src = [entry("src/lib", "directory"), entry("src/index.ts")];
    files.directories["src/lib"] = [entry("src/lib/util.ts")];
    await using screen = await renderPanel();
    await expect.poll(screen.visiblePaths).toEqual(["src/", "package.json"]);
    await chooseFromFilesMenu(screen.container, "Expand all folders");
    await expect.poll(screen.visiblePaths).toContain("src/lib/");
    expect(
      files.listDirectory.mock.calls.map(([request]) => request.input.relativeDirectory),
    ).toEqual(["", "src"]);
    expect(screen.visiblePaths()).not.toContain("src/lib/util.ts");
    await chooseFromFilesMenu(screen.container, "Expand all folders");
    await expect.poll(screen.visiblePaths).toContain("src/lib/util.ts");
    await chooseFromFilesMenu(screen.container, "Collapse all folders");
    await expect.poll(screen.visiblePaths).toEqual(["src/", "package.json"]);
  });
  describe("a very large folder", () => {
    const LARGE_FOLDER_SIZE = 50_000;
    // Out of sort order, because inserting in order hides the cost of each insert.
    const largeFolder = () =>
      Array.from({ length: LARGE_FOLDER_SIZE }, (_, index) =>
        entry(`big/f${String((index * 7_919) % LARGE_FOLDER_SIZE).padStart(5, "0")}.txt`),
      );
    const treeRow = (container: HTMLElement, path: string) =>
      container
        .querySelector("file-tree-container")
        ?.shadowRoot?.querySelector<HTMLElement>(`[data-item-path="${CSS.escape(path)}"]`) ?? null;

    it("opens without freezing and keeps the folder that was open", async () => {
      setup();
      files.directories[""] = [entry("big", "directory"), ...files.directories[""]!];
      files.directories.big = largeFolder();
      // Its own folder, so the folders it opens are not remembered for the other tests.
      await using screen = await renderPanel({ cwd: "/large-folder-open" });
      await expect.poll(screen.visiblePaths).toEqual(["big/", "src/", "package.json"]);
      treeRow(screen.container, "src/")!.click();
      await expect.poll(screen.visiblePaths).toContain("src/app.ts");

      treeRow(screen.container, "big/")!.click();
      // Batching every row blocked the panel past this wait; the rebuild takes about 170 ms.
      await expect.poll(screen.visiblePaths).toContain("big/f00000.txt");
      expect(treeRow(screen.container, "big/")!.getAttribute("aria-expanded")).toBe("true");
      const src = treeRow(screen.container, "src/");
      if (src) expect(src.getAttribute("aria-expanded")).toBe("true");
    });

    it("keeps an open search accurate when the folder's listing arrives", async () => {
      setup();
      files.directories[""] = [entry("big", "directory"), ...files.directories[""]!];
      files.directories.big = largeFolder();
      await using screen = await renderPanel({ cwd: "/large-folder-search" });
      await expect.poll(screen.visiblePaths).toContain("big/");
      files.searchEntries = [{ path: "big/f49999.txt", kind: "file" }];
      await screen.search("f49999");
      await expect.poll(screen.visiblePaths).toEqual(["big/", "big/f49999.txt"]);
      expect(screen.searchInput().value).toBe("f49999");
      await screen.search("");
      await expect.poll(screen.visiblePaths).toEqual(["big/", "src/", "package.json"]);
    });
  });

  it.each(["a folder listing", "coming back to the window"] as const)(
    "keeps naming a new file while %s refreshes the tree",
    async (refresh) => {
      setup();
      files.localApi = { contextMenu: { show: showContextMenuFallback } };
      const cwd = `/naming-${refresh.replaceAll(" ", "-")}`;
      await using screen = await renderPanel({ cwd });
      using _menu = {
        [Symbol.dispose]: () => {
          dismissContextMenu();
          files.localApi = undefined;
        },
      };
      await expect.poll(screen.visiblePaths).toEqual(["src/", "package.json"]);
      const tree = () => screen.container.querySelector("file-tree-container")!.shadowRoot!;
      tree()
        .querySelector<HTMLElement>('[data-item-path="src/"]')!
        .dispatchEvent(
          new MouseEvent("contextmenu", {
            bubbles: true,
            cancelable: true,
            composed: true,
            button: 2,
          }),
        );
      const newFile = page.getByRole("menuitem", { name: "New File", exact: true });
      await expect.element(newFile).toBeVisible();
      await userEvent.click(newFile);
      const field = () => tree().querySelector("input");
      await expect.poll(() => field() !== null && tree().activeElement === field()).toBe(true);
      await userEvent.keyboard("draft");
      expect(field()!.value).toBe("draft");
      const listings = files.listDirectory.mock.calls.length;
      // Another app adds a file meanwhile, so the listing changes the tree.
      files.directories["src"]!.push(entry("src/from-elsewhere.tex"));
      if (refresh === "a folder listing") {
        await act(() => refreshProjectFiles(props.environmentId, cwd));
      } else {
        window.dispatchEvent(new Event("blur"));
        window.dispatchEvent(new Event("focus"));
      }
      await expect.poll(() => files.listDirectory.mock.calls.length).toBeGreaterThan(listings);
      await expect.poll(screen.visiblePaths).toContain("src/from-elsewhere.tex");
      const changes = () =>
        files.listDirectory.mock.calls.flatMap(([request]) =>
          "change" in request.input ? [request.input.change] : [],
        );
      expect(changes()).toEqual([]);
      expect(field()?.value).toBe("draft");
      expect(tree().activeElement).toBe(field());
      await userEvent.keyboard("{Enter}");
      await expect
        .poll(changes)
        .toEqual([expect.objectContaining({ _tag: "create-file", relativePath: "src/draft" })]);
    },
  );

  it("keeps renaming a file while a listing moves its row", async () => {
    setup();
    files.directories.src = [entry("src/app.ts"), entry("src/zeta.ts")];
    files.localApi = { contextMenu: { show: showContextMenuFallback } };
    await using screen = await renderPanel({ cwd: "/renaming-moved-row" });
    using _menu = {
      [Symbol.dispose]: () => {
        dismissContextMenu();
        files.localApi = undefined;
      },
    };
    await expect.poll(screen.visiblePaths).toEqual(["src/", "package.json"]);
    const tree = () => screen.container.querySelector("file-tree-container")!.shadowRoot!;
    await act(() => tree().querySelector<HTMLElement>('[data-item-path="src/"]')!.click());
    await expect.poll(screen.visiblePaths).toContain("src/zeta.ts");
    tree()
      .querySelector<HTMLElement>('[data-item-path="src/zeta.ts"]')!
      .dispatchEvent(
        new MouseEvent("contextmenu", {
          bubbles: true,
          cancelable: true,
          composed: true,
          button: 2,
        }),
      );
    const rename = page.getByRole("menuitem", { name: "Rename…", exact: true });
    await expect.element(rename).toBeVisible();
    await userEvent.click(rename);
    const field = () => tree().querySelector("input");
    await expect.poll(() => field() !== null && tree().activeElement === field()).toBe(true);
    await userEvent.keyboard("omega.ts");
    // A file another app adds above the row moves it while it is being renamed.
    files.directories.src.push(entry("src/beta.ts"));
    await act(() => refreshProjectFiles(props.environmentId, "/renaming-moved-row"));
    await expect.poll(screen.visiblePaths).toContain("src/beta.ts");
    const moves = () =>
      files.listDirectory.mock.calls.flatMap(([request]) =>
        "change" in request.input ? [request.input.change] : [],
      );
    expect(moves()).toEqual([]);
    expect(field()?.value).toBe("omega.ts");
    expect(tree().activeElement).toBe(field());
    await userEvent.keyboard("{Enter}");
    await expect.poll(moves).toEqual([
      expect.objectContaining({
        _tag: "move",
        items: [{ from: "src/zeta.ts", to: "src/omega.ts" }],
      }),
    ]);
  });

  it("copies with the pointer and returns to the row after keyboard dismissal", async () => {
    setup();
    files.directories = { "": [entry("README.md")] };
    files.localApi = { contextMenu: { show: showContextMenuFallback } };
    await using screen = await renderPanel();
    using _menu = {
      [Symbol.dispose]: () => {
        dismissContextMenu();
        files.localApi = undefined;
      },
    };
    using clipboard = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue(undefined);
    await expect.poll(screen.visiblePaths).toEqual(["README.md"]);
    const findRow = () =>
      screen.container
        .querySelector("file-tree-container")!
        .shadowRoot!.querySelector<HTMLElement>('[data-item-path="README.md"]')!;
    findRow().dispatchEvent(
      new MouseEvent("contextmenu", {
        bubbles: true,
        cancelable: true,
        composed: true,
        button: 2,
      }),
    );
    // SCIENT-FORK:START — Copy mention sits under Copy; Add to chat opens the menu
    const copy = page.getByRole("menuitem", { name: "Copy", exact: true });
    await expect.element(copy).toBeVisible();
    await userEvent.click(copy);
    const action = page.getByRole("menuitem", { name: "Mention", exact: true });
    await expect.element(action).toBeVisible();
    await userEvent.click(action);
    await vi.waitFor(() => expect(clipboard).toHaveBeenCalledWith("[README.md](README.md)"));

    const row = findRow();
    await userEvent.keyboard("{Tab}");
    row.focus();
    await userEvent.keyboard("{Shift>}{F10}{/Shift}");
    await expect
      .element(page.getByRole("menuitem", { name: "Add to chat", exact: true }))
      .toHaveFocus();
    // SCIENT-FORK:END
    await userEvent.keyboard("{Escape}");
    await vi.waitFor(() => expect((row.getRootNode() as ShadowRoot).activeElement).toBe(row));
  });

  it("dragging a file row carries a composer mention without opening it, and dragend releases it", async () => {
    setup();
    files.directories = { "": [entry("README.md")] };
    await using screen = await renderPanel();
    await expect.poll(screen.visiblePaths).toEqual(["README.md"]);
    const row = screen.container
      .querySelector("file-tree-container")!
      .shadowRoot!.querySelector<HTMLElement>('[data-item-path="README.md"]')!;

    const dataTransfer = new DataTransfer();
    row.dispatchEvent(
      new DragEvent("dragstart", { bubbles: true, cancelable: true, composed: true, dataTransfer }),
    );
    // The tree selects the row the drag picked up; mid-drag that must not open it.
    row.click();
    await expect.poll(() => row.getAttribute("aria-selected")).toBe("true");

    expect(dataTransfer.getData(COMPOSER_MENTION_DRAG_TYPE)).toContain("README.md");
    expect(props.onOpenFile).not.toHaveBeenCalled();

    row.dispatchEvent(new DragEvent("dragend", { bubbles: true, composed: true, dataTransfer }));
    await expect.poll(() => row.getAttribute("aria-selected")).not.toBe("true");

    row.click();
    await expect.poll(() => props.onOpenFile.mock.calls.length).toBe(1);

    // The selection stays put, so reopening the selected file must not depend on a selection change.
    row.click();
    await expect.poll(() => props.onOpenFile.mock.calls.length).toBe(2);
  });

  // SCIENT-FORK:START — Overleaf in the Files panel
  it("marks folders linked to Overleaf and opens Connect from the bar", async () => {
    setup();
    // Earlier tests already read this workspace's (empty) links.
    resetOverleafStoreForTests();
    overleaf.folders = ["src"];
    await using screen = await renderPanel();
    await expect.poll(screen.visiblePaths).toEqual(["src/", "package.json"]);
    const mark = () =>
      screen.container
        .querySelector("file-tree-container")
        ?.shadowRoot!.querySelector(
          '[data-item-path="src/"] [data-icon-name="scient-tree-icon-overleaf"]',
        ) ?? null;
    await expect.poll(mark).not.toBeNull();

    await act(() =>
      screen.container
        .querySelector<HTMLButtonElement>('button[aria-label="Connect an external folder"]')!
        .click(),
    );
    const overleafItem = () =>
      [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(
        (item) => item.textContent?.trim() === "Overleaf…",
      );
    await expect.poll(overleafItem).toBeDefined();
    await act(() => overleafItem()!.click());
    // Nothing is selected, so the dialog offers the project's top folder.
    await expect
      .poll(() => document.querySelector('[role="dialog"]')?.textContent ?? "")
      .toContain("Link the project's top folder");
    overleaf.folders = [];
  });
  // SCIENT-FORK:END

  it("mod+f from a tree row, or the panel find command, focuses the file search", async () => {
    setup();
    files.directories = { "": [entry("README.md")] };
    const container = document.createElement("div");
    // The tree virtualizes its rows, so it needs a real viewport to render any.
    container.style.cssText = "display: flex; flex-direction: column; width: 320px; height: 480px;";
    await using _screen = await render(<FileBrowserPanel {...props} answersPanelFind />, {
      container,
    });
    const row = () =>
      container
        .querySelector("file-tree-container")
        ?.shadowRoot?.querySelector<HTMLElement>('[data-item-path="README.md"]') ?? null;
    await vi.waitFor(() => expect(row()).not.toBeNull());
    row()!.focus();

    const modifier = isMacPlatform(navigator.platform) ? "Meta" : "Control";
    await userEvent.keyboard(`{${modifier}>}f{/${modifier}}`);

    const search = page.getByRole("searchbox", { name: "Search Test project files" });
    await expect.element(search).toHaveFocus();

    (search.element() as HTMLElement).blur();
    dispatchPreviewAction("find");
    await expect.element(search).toHaveFocus();
  });

  it("Escape in the file search clears it without closing the panel sheet", async () => {
    setup();
    const onCloseSheet = vi.fn();
    await using _screen = await render(
      <RightPanelSheet animationDurationMs={0} open onClose={onCloseSheet}>
        <FileBrowserPanel {...props} />
      </RightPanelSheet>,
    );
    const search = page.getByRole("searchbox", { name: "Search Test project files" });
    await userEvent.fill(search, "read");
    for (const composition of [
      { key: "Escape", isComposing: true, keyCode: 27 },
      { key: "Escape", isComposing: false, keyCode: 229 },
    ]) {
      // Safari ends the composition just before the Escape keydown.
      await act(() => {
        search.element().dispatchEvent(new CompositionEvent("compositionend", { bubbles: true }));
        search
          .element()
          .dispatchEvent(new KeyboardEvent("keydown", { ...composition, bubbles: true }));
      });
      await expect.element(search).toHaveValue("read");
    }
    expect(search.element().getAttribute("type")).toBe("text");

    await userEvent.keyboard("{Escape}");
    await expect.element(search).toHaveValue("");
    await expect.element(search).toHaveFocus();
    await act(() => {
      document.activeElement?.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", repeat: true, bubbles: true }),
      );
    });
    expect(onCloseSheet).not.toHaveBeenCalled();

    await userEvent.keyboard("{Escape}");
    await vi.waitFor(() => expect(onCloseSheet).toHaveBeenCalledOnce());
  });

  it("keeps expanded folders when the panel remounts", async () => {
    // SCIENT-FORK:START — Scient's lazy tree lists each folder through the mocked command.
    setup();
    const findTreeRow = (path: string) =>
      document
        .querySelector("file-tree-container")
        ?.shadowRoot?.querySelector<HTMLElement>(`[data-item-path="${path}"]`) ?? null;
    const panel = () => {
      // The tree virtualizes its rows, so it needs a real viewport to render any.
      const container = document.createElement("div");
      container.style.cssText =
        "display: flex; flex-direction: column; width: 320px; height: 480px;";
      return render(<FileBrowserPanel {...props} cwd="/remount" />, { container });
    };
    // SCIENT-FORK:END
    {
      await using _first = await panel();
      await vi.waitFor(() => expect(findTreeRow("src/")).not.toBeNull());
      findTreeRow("src/")!.click();
      await vi.waitFor(() =>
        expect(findTreeRow("src/")!.getAttribute("aria-expanded")).toBe("true"),
      );
    }

    await using _second = await panel();
    await vi.waitFor(() => expect(findTreeRow("src/")).not.toBeNull());
    await vi.waitFor(() => expect(findTreeRow("src/")!.getAttribute("aria-expanded")).toBe("true"));
  });
  describe("revealing a folder while folders above it are still loading", () => {
    // SCIENT-FORK:START — Scient's lazy tree lists each folder through the mocked command.
    const roots = Array.from({ length: 12 }, (_, index) =>
      entry(`d${String(index).padStart(2, "0")}`, "directory"),
    );
    const listing = (parent: string, count: number) =>
      Array.from({ length: count }, (_, index) =>
        entry(`${parent}/f${String(index).padStart(3, "0")}.ts`),
      );
    const treeRoot = () => document.querySelector("file-tree-container")?.shadowRoot ?? null;
    const findTreeScroller = () =>
      treeRoot()?.querySelector<HTMLElement>("[data-file-tree-virtualized-scroll]") ?? null;
    const isTreeRowInView = (path: string) => {
      const rowRect = treeRoot()
        ?.querySelector<HTMLElement>(`[data-item-path="${CSS.escape(path)}"]`)
        ?.getBoundingClientRect();
      const scrollerRect = findTreeScroller()?.getBoundingClientRect();
      return (
        rowRect !== undefined &&
        scrollerRect !== undefined &&
        rowRect.top >= scrollerRect.top &&
        rowRect.bottom <= scrollerRect.bottom
      );
    };
    // d01 and the folder restored inside it list only when the test releases them.
    async function renderRevealedPanel(cwd: string) {
      setup();
      files.directories = { "": roots };
      writeExpandedDirectories(`${props.environmentId}:${cwd}`, ["d01/", "d01/sub/"]);
      const pending = new Map<string, (value: unknown) => void>();
      files.listDirectory.mockImplementation(
        async ({ input }: { input: ProjectListDirectoryInput }) =>
          input.relativeDirectory.startsWith("d01")
            ? new Promise((resolve) => pending.set(input.relativeDirectory, resolve))
            : AsyncResult.success({
                entries: files.directories[input.relativeDirectory] ?? [],
                complete: true,
              }),
      );
      const container = document.createElement("div");
      container.style.cssText = "display:flex;flex-direction:column;height:300px;width:300px";
      await using stack = new AsyncDisposableStack();
      stack.use(
        await render(
          <FileBrowserPanel {...props} cwd={cwd} selectedPath="d09" selectedPathRevealId={1} />,
          { container },
        ),
      );
      await vi.waitFor(() => expect(isTreeRowInView("d09/")).toBe(true));
      const release = async (directory: string, entries: ProjectDirectoryEntry[]) => {
        await vi.waitFor(() => expect(pending.has(directory)).toBe(true));
        await act(() => pending.get(directory)!(AsyncResult.success({ entries, complete: true })));
      };
      const environment = stack.move();
      return { release, [Symbol.asyncDispose]: () => environment.disposeAsync() };
    }
    // SCIENT-FORK:END

    it("keeps the revealed folder in view as restored folders above it load", async () => {
      await using panel = await renderRevealedPanel("/repo-reveal-follows-loading");

      // d01 lists after the reveal and holds another restored folder, which lists in turn.
      await panel.release("d01", [...listing("d01", 60), entry("d01/sub", "directory")]);
      await vi.waitFor(() => expect(findTreeScroller()!.scrollHeight).toBeGreaterThan(60 * 24));
      await panel.release("d01/sub", listing("d01/sub", 60));

      await vi.waitFor(() => expect(isTreeRowInView("d09/")).toBe(true));
    });

    it("leaves the scroll position alone once the user scrolls the tree", async () => {
      await using panel = await renderRevealedPanel("/repo-reveal-user-scroll");

      const scroller = findTreeScroller()!;
      scroller.dispatchEvent(new WheelEvent("wheel", { bubbles: true, composed: true }));
      scroller.scrollTop = 0;
      await panel.release("d01", listing("d01", 60));
      await vi.waitFor(() => expect(scroller.scrollHeight).toBeGreaterThan(60 * 24));

      expect(scroller.scrollTop).toBe(0);
    });
  });
});
