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
import { act, render } from "../../../test/render";

import FileBrowserPanel from "./FileBrowserPanel";
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
vi.mock("~/hooks/useTheme", () => ({ useTheme: () => ({ resolvedTheme: "dark" }) }));
vi.mock("~/hooks/useWorkspaceMutationRefresh", () => ({ useWorkspaceMutationRefresh: vi.fn() }));
vi.mock("~/composerHandleContext", () => ({ useComposerHandleContext: () => null }));
vi.mock("~/fileContextMenu", () => ({ useFileContextMenu: () => ({}) }));
vi.mock("~/localApi", () => ({ readLocalApi: () => undefined }));
vi.mock("~/components/ui/toast", () => ({ toastManager: { add: vi.fn() } }));
vi.mock("~/components/MorphIcon", () => ({ MorphIcon: () => null }));
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

  async function renderPanel() {
    const container = document.createElement("div");
    // The tree virtualizes its rows, so it needs a real viewport to render any.
    container.style.cssText = "display: flex; flex-direction: column; width: 320px; height: 480px;";
    await using stack = new AsyncDisposableStack();
    const screen = stack.use(await render(<FileBrowserPanel {...props} />, { container }));
    const rerender = () => screen.rerender(<FileBrowserPanel {...props} />);
    function searchInput() {
      const input = container!.querySelector<HTMLInputElement>('input[type="search"]');
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
    expect(document.activeElement).not.toBe(input);
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
});
