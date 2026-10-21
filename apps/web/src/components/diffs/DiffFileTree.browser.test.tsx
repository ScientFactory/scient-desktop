import type { CodeViewScrollTarget } from "@pierre/diffs";
import type { FileTree as FileTreeModel } from "@pierre/trees";
import type { ComponentProps } from "react";
import { describe, expect, it, vi } from "vite-plus/test";

import type { FileDiffMetadata } from "@pierre/diffs";

import { act, render } from "../../../test/render";

import { DiffFileTree, type DiffFileTreeEntry } from "./DiffFileTree";
import { diffFileTreeEntries } from "./diffFileTree.logic";
import { useCodeViewFileReveal } from "./useCodeViewFileReveal";

const captured = vi.hoisted(() => ({ model: null as unknown }));
// Read the tree model the component builds, so tests can assert its selection and expansion.
vi.mock(import("@pierre/trees/react"), async (original) => {
  const actual = await original();
  const RealFileTree = actual.FileTree;
  return {
    ...actual,
    FileTree: ((props: ComponentProps<typeof RealFileTree>) => {
      captured.model = props.model;
      return <RealFileTree {...props} />;
    }) as typeof RealFileTree,
  };
});

const entries: DiffFileTreeEntry[] = [
  { path: "01-tall.ts", status: "modified" },
  { path: "02-short.ts", status: "modified" },
  { path: "03-medium.ts", status: "modified" },
];

describe("diff tree file activation", () => {
  const targets: CodeViewScrollTarget[] = [];
  const viewer = {
    getInstance: () => viewer,
    scrollTo: (target: CodeViewScrollTarget) => targets.push(target),
  };

  function Panel({
    files = entries,
    selectedPath = null,
    revealRequestId = 0,
  }: {
    files?: DiffFileTreeEntry[];
    selectedPath?: string | null;
    revealRequestId?: number;
  }) {
    const reveal = useCodeViewFileReveal(viewer, "working-tree");
    return (
      <DiffFileTree
        entries={files}
        ariaLabel="Working tree files"
        selectedPath={selectedPath}
        revealRequestId={revealRequestId}
        onSelectFile={(path) => reveal(`${path}\0${path}`)}
      />
    );
  }

  const model = (): FileTreeModel => captured.model as FileTreeModel;

  function setup(_fixture: _Fixture) {
    targets.length = 0;
    _fixture.container = document.createElement("div");
    _fixture.container.style.cssText =
      "display: flex; flex-direction: column; width: 320px; height: 480px";
  }

  function row(_fixture: _Fixture, path: string): HTMLElement {
    const host = _fixture.container.querySelector("file-tree-container");
    const element = (host?.shadowRoot ?? _fixture.container).querySelector<HTMLElement>(
      `[data-item-path="${CSS.escape(path)}"]`,
    );
    expect(element, `row ${path}`).not.toBeNull();
    return element!;
  }

  function fileRows(_fixture: _Fixture): HTMLElement[] {
    const host = _fixture.container.querySelector("file-tree-container");
    return [
      ...(host?.shadowRoot ?? _fixture.container).querySelectorAll<HTMLElement>(
        '[role="treeitem"][data-item-type="file"]',
      ),
    ];
  }

  async function activate(
    _fixture: _Fixture,
    target: string | HTMLElement,
    modifiers: MouseEventInit = {},
  ) {
    await act(async () => {
      (typeof target === "string" ? row(_fixture, target) : target).dispatchEvent(
        new MouseEvent("click", {
          bubbles: true,
          composed: true,
          button: 0,
          detail: 1,
          ...modifiers,
        }),
      );
    });
  }

  it("mounts a file-to-symlink type change as one tree row", async () => {
    await using _fixture = _createFixture();

    setup(_fixture);
    const typeChange = diffFileTreeEntries([
      { type: "deleted", name: "AGENTS.md", prevName: "AGENTS.md" } as FileDiffMetadata,
      { type: "new", name: "AGENTS.md", prevName: "AGENTS.md" } as FileDiffMetadata,
      { type: "change", name: "CLAUDE.md", prevName: "CLAUDE.md" } as FileDiffMetadata,
    ]);
    await using _screen = await render(<Panel files={[...typeChange]} />, {
      container: _fixture.container,
    });

    const tree = model();
    expect(tree.getItem("AGENTS.md")?.isDirectory()).toBe(false);
    expect(tree.getItem("CLAUDE.md")?.isDirectory()).toBe(false);
    await activate(_fixture, "AGENTS.md");
    expect(targets).toEqual([{ type: "item", id: "AGENTS.md\u0000AGENTS.md", align: "start" }]);
  });

  it("reissues the reveal when the sole selected file is activated again", async () => {
    await using _fixture = _createFixture();

    setup(_fixture);
    await using _screen = await render(<Panel />, { container: _fixture.container });
    await activate(_fixture, "02-short.ts");
    expect(model().getSelectedPaths()).toEqual(["02-short.ts"]);
    await activate(_fixture, "02-short.ts");
    expect(targets).toEqual([
      { type: "item", id: "02-short.ts\u000002-short.ts", align: "start" },
      { type: "item", id: "02-short.ts\u000002-short.ts", align: "start" },
    ]);
  });

  it("reveals newly selected files once in either direction", async () => {
    await using _fixture = _createFixture();

    setup(_fixture);
    await using _screen = await render(<Panel />, { container: _fixture.container });
    await activate(_fixture, "02-short.ts");
    await activate(_fixture, "01-tall.ts");
    await activate(_fixture, "03-medium.ts");
    expect(targets.map((target) => ("id" in target ? target.id : null))).toEqual(
      ["02-short.ts", "01-tall.ts", "03-medium.ts"].map((path) => `${path}\0${path}`),
    );
  });

  it("keeps focus-only navigation separate from button activation", async () => {
    await using _fixture = _createFixture();

    setup(_fixture);
    await using _screen = await render(<Panel />, { container: _fixture.container });
    await activate(_fixture, "02-short.ts");
    await act(async () => model().getItem("01-tall.ts")!.focus());
    expect(model().getSelectedPaths()).toEqual(["02-short.ts"]);
    expect(targets).toHaveLength(1);
    await activate(_fixture, "01-tall.ts", { detail: 0 });
    await activate(_fixture, "01-tall.ts", { detail: 0 });
    expect(targets).toHaveLength(3);
  });

  it.each(["ctrlKey", "metaKey"] as const)(
    "does not reveal a selected file that a %s click deselects",
    async (modifier) => {
      await using _fixture = _createFixture();

      setup(_fixture);
      await using _screen = await render(<Panel />, { container: _fixture.container });
      await activate(_fixture, "02-short.ts");
      await activate(_fixture, "02-short.ts", { [modifier]: true });
      expect(model().getSelectedPaths()).toEqual([]);
      expect(targets).toHaveLength(1);
    },
  );

  it("lets a click narrow multiple selected files without a second reveal", async () => {
    await using _fixture = _createFixture();

    setup(_fixture);
    await using _screen = await render(<Panel />, { container: _fixture.container });
    await activate(_fixture, "02-short.ts");
    await act(async () => model().getItem("01-tall.ts")!.select());
    expect(model().getSelectedPaths()).toHaveLength(2);
    targets.length = 0;
    await activate(_fixture, "02-short.ts");
    expect(model().getSelectedPaths()).toEqual(["02-short.ts"]);
    expect(targets).toHaveLength(1);
  });

  it("leaves directory selection and expansion to the tree", async () => {
    await using _fixture = _createFixture();

    setup(_fixture);
    await using _screen = await render(
      <Panel files={[{ path: "src/app.ts", status: "modified" }]} />,
      { container: _fixture.container },
    );
    const directory = model().getItem("src/")!;
    if (!("isExpanded" in directory)) throw new Error("Expected the directory handle");
    expect(directory.isExpanded()).toBe(true);
    await activate(_fixture, "src/");
    expect(directory.isExpanded()).toBe(false);
    await activate(_fixture, "src/");
    expect(directory.isExpanded()).toBe(true);
    expect(targets).toEqual([]);
  });

  it("reorders refreshed files without reopening a collapsed folder", async () => {
    await using _fixture = _createFixture();

    setup(_fixture);
    const files: DiffFileTreeEntry[] = [
      { path: "src/state/shell.ts", status: "modified" },
      { path: "src/features/route.ts", status: "added" },
    ];
    await using screen = await render(<Panel files={files} />, { container: _fixture.container });
    const initialFolder = model().getItem("src/features/")!;
    if (!("collapse" in initialFolder)) throw new Error("Expected the directory handle");
    await act(async () => initialFolder.collapse());
    await screen.rerender(<Panel files={[files[1]!, files[0]!]} />);
    const folder = model().getItem("src/features/")!;
    if (!("isExpanded" in folder)) throw new Error("Expected the directory handle");
    expect(folder.isExpanded()).toBe(false);
  });

  it("reveals real diff paths and statuses when a directory is replaced by a file", async () => {
    await using _fixture = _createFixture();

    setup(_fixture);
    const files: DiffFileTreeEntry[] = [
      { path: "office/config.ts", status: "deleted" },
      { path: "office", status: "added" },
    ];
    await using screen = await render(<Panel files={files} selectedPath="office" />, {
      container: _fixture.container,
    });
    expect(fileRows(_fixture).map((row) => row.getAttribute("data-item-git-status"))).toEqual([
      "deleted",
      "added",
    ]);
    expect(fileRows(_fixture)[1]!.getAttribute("aria-selected")).toBe("true");
    expect(targets).toEqual([]);
    await activate(_fixture, fileRows(_fixture)[1]!);
    await activate(_fixture, fileRows(_fixture)[0]!);
    await activate(_fixture, "office/");
    expect(targets).toEqual([
      { type: "item", id: "office\0office", align: "start" },
      { type: "item", id: "office/config.ts\0office/config.ts", align: "start" },
    ]);
    expect(row(_fixture, "office/").getAttribute("aria-expanded")).toBe("false");
    await screen.rerender(<Panel files={files} selectedPath="office/config.ts" />);
    expect(row(_fixture, "office/").getAttribute("aria-expanded")).toBe("true");
    expect(fileRows(_fixture)[0]!.getAttribute("aria-selected")).toBe("true");
    expect(targets).toHaveLength(2);
  });

  it("keeps selection, focus, and collapsed folders through a colliding slice and refresh", async () => {
    await using _fixture = _createFixture();

    setup(_fixture);
    const files: DiffFileTreeEntry[] = [
      { path: "office", status: "deleted" },
      { path: "src/route.ts", status: "modified" },
    ];
    await using screen = await render(<Panel files={files} />, { container: _fixture.container });
    await activate(_fixture, "src/");
    await activate(_fixture, "office");
    await act(async () => model().focusPath("office"));
    expect(model().getFocusedPath()).toBe("office");
    expect(row(_fixture, "office").getAttribute("aria-selected")).toBe("true");
    const appended: DiffFileTreeEntry[] = [...files, { path: "office/config.ts", status: "added" }];
    await screen.rerender(<Panel files={appended} />);
    expect(row(_fixture, "src/").getAttribute("aria-expanded")).toBe("false");
    expect(fileRows(_fixture)[0]!.getAttribute("aria-selected")).toBe("true");
    expect(row(_fixture, "office/").getAttribute("aria-selected")).toBe("false");
    expect.soft(model().getFocusedPath()).toBe("office\u200b");
    expect(targets).toEqual([{ type: "item", id: "office\0office", align: "start" }]);
    await activate(_fixture, fileRows(_fixture)[0]!);
    await activate(_fixture, fileRows(_fixture)[1]!);
    expect(targets).toEqual([
      { type: "item", id: "office\0office", align: "start" },
      { type: "item", id: "office\0office", align: "start" },
      { type: "item", id: "office/config.ts\0office/config.ts", align: "start" },
    ]);
    await activate(_fixture, "office/");
    await screen.rerender(<Panel files={appended.map((file) => ({ ...file }))} />);
    expect(row(_fixture, "src/").getAttribute("aria-expanded")).toBe("false");
    expect(row(_fixture, "office/").getAttribute("aria-expanded")).toBe("false");
    await activate(_fixture, fileRows(_fixture)[0]!);
    expect(targets.at(-1)).toEqual({ type: "item", id: "office\0office", align: "start" });
    expect(targets).toHaveLength(4);
  });

  it("preserves filename and extension icons when files become directory prefixes", async () => {
    await using _fixture = _createFixture();

    setup(_fixture);
    const files: DiffFileTreeEntry[] = [
      { path: "AGENTS.md", status: "deleted" },
      { path: "config.ts", status: "deleted" },
    ];
    const rootFileIcons = () =>
      fileRows(_fixture)
        .filter((row) => row.getAttribute("aria-level") === "1")
        .map((row) => row.querySelector('[data-item-section="icon"] use')?.getAttribute("href"));
    await using screen = await render(<Panel files={files} />, { container: _fixture.container });
    const icons = rootFileIcons();
    expect(icons).toEqual(["#t3-file-icon-agents", "#file-tree-builtin-typescript"]);
    await screen.rerender(
      <Panel
        files={[
          ...files,
          { path: "AGENTS.md/note.txt", status: "added" },
          { path: "config.ts/note.txt", status: "added" },
        ]}
      />,
    );
    expect(rootFileIcons()).toEqual(icons);
  });

  it("preserves a collapsed controlled selection through paging until explicitly revealed", async () => {
    await using _fixture = _createFixture();

    setup(_fixture);
    const files: DiffFileTreeEntry[] = [
      { path: "src/office", status: "deleted" },
      { path: "src/route.ts", status: "modified" },
    ];
    await using screen = await render(<Panel files={files} selectedPath="src/office" />, {
      container: _fixture.container,
    });
    expect(model().getSelectedPaths()).toEqual(["src/office"]);
    expect(targets).toEqual([]);
    await activate(_fixture, "src/office");
    expect(targets).toEqual([{ type: "item", id: "src/office\0src/office", align: "start" }]);

    const folder = model().getItem("src/")!;
    if (!("collapse" in folder)) throw new Error("Expected the directory handle");
    await act(async () => folder.collapse());
    expect(row(_fixture, "src/").getAttribute("aria-expanded")).toBe("false");
    using scroll = vi.spyOn(model(), "scrollToPath");
    const appended: DiffFileTreeEntry[] = [...files, { path: "src/office/x.ts", status: "added" }];
    await screen.rerender(<Panel files={appended} selectedPath="src/office" />);
    expect.soft(row(_fixture, "src/").getAttribute("aria-expanded")).toBe("false");
    expect.soft(scroll).not.toHaveBeenCalled();
    const selected = model().getSelectedPaths();
    expect(selected).toHaveLength(1);
    expect(model().getItem(selected[0]!)?.isDirectory()).toBe(false);
    expect(targets).toHaveLength(1);

    await act(async () => folder.collapse());
    scroll.mockClear();
    await screen.rerender(<Panel files={appended} selectedPath="src/office" revealRequestId={1} />);
    expect(row(_fixture, "src/").getAttribute("aria-expanded")).toBe("true");
    expect(model().getSelectedPaths()).toEqual(selected);
    expect(row(_fixture, selected[0]!).getAttribute("aria-selected")).toBe("true");
    expect(scroll).toHaveBeenCalledOnce();
    expect(targets).toHaveLength(1);
    await activate(_fixture, selected[0]!);
    expect(targets).toEqual([
      { type: "item", id: "src/office\0src/office", align: "start" },
      { type: "item", id: "src/office\0src/office", align: "start" },
    ]);

    await act(async () => folder.collapse());
    await screen.rerender(
      <Panel files={appended} selectedPath="src/route.ts" revealRequestId={1} />,
    );
    expect(row(_fixture, "src/").getAttribute("aria-expanded")).toBe("true");
    expect(model().getSelectedPaths()).toEqual(["src/route.ts"]);
    expect(targets).toHaveLength(2);
  });
});

function _createFixture() {
  const stack = new AsyncDisposableStack();
  return {
    container: undefined! as HTMLDivElement,
    stack,
    async [Symbol.asyncDispose]() {
      await stack.disposeAsync();
    },
  };
}
type _Fixture = ReturnType<typeof _createFixture>;
