// @vitest-environment happy-dom
import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import type { Editor } from "@pierre/diffs/editor";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

type ObservedEditor = Pick<
  Editor<unknown>,
  "applyEdits" | "getText" | "getFile" | "canUndo" | "undo" | "redo" | "setSelections"
>;
const mocks = vi.hoisted(() => ({
  editors: [] as ObservedEditor[],
  addReviewComment: vi.fn(),
  removeReviewComment: vi.fn(),
  attached: vi.fn(),
  lateChanges: [] as Array<(source: string) => void>,
}));

vi.mock("@pierre/diffs/editor", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@pierre/diffs/editor")>();
  return {
    Editor: class<LAnnotation> extends actual.Editor<LAnnotation> {
      constructor(options?: import("@pierre/diffs/editor").EditorOptions<LAnnotation>) {
        super({
          ...options,
          onAttach: (editor, instance) => {
            options?.onAttach?.(editor, instance);
            mocks.attached(editor);
          },
        });
        mocks.editors.push(this);
        mocks.lateChanges.push((source) =>
          options?.onChange?.({ name: "source.md", contents: source }),
        );
      }
    },
  };
});

vi.mock("@pierre/diffs/react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@pierre/diffs/react")>();
  return {
    ...actual,
    // Geometry/virtualization is qualified in the integrated client. Keep the real
    // Pierre File and Editor here so edits, acknowledgements and undo are genuine.
    Virtualizer: ({ children }: { children: ReactNode }) => children,
  };
});
// happy-dom cannot construct Vite's browser workers. Keep the real File/Editor
// on Pierre's main-thread renderer; browser worker rendering requires integrated client review.
vi.mock("~/components/DiffWorkerPoolProvider", () => ({
  DiffWorkerPoolProvider: ({ children }: { children?: ReactNode }) => children,
}));
vi.mock("~/composerDraftStore", () => ({
  useComposerDraftStore: (
    select: (value: {
      addReviewComment: typeof mocks.addReviewComment;
      removeReviewComment: typeof mocks.removeReviewComment;
    }) => unknown,
  ) => select(mocks),
}));
vi.mock("~/components/files/projectFilesQueryState", () => ({
  clearProjectFileQueryData: vi.fn(),
  confirmProjectFileQueryData: vi.fn(),
  getOptimisticProjectFileQueryData: vi.fn(),
  refreshProjectEntriesQuery: vi.fn(),
  setProjectFileQueryData: vi.fn(),
  useProjectFileQuery: vi.fn(),
  useProjectEntriesQuery: vi.fn(),
}));
vi.mock("~/state/projects", () => ({ projectEnvironment: {} }));
vi.mock("~/state/assets", () => ({ assetEnvironment: {} }));
vi.mock("~/state/preview", () => ({ previewEnvironment: {} }));
vi.mock("~/connection/catalog", () => ({ environmentCatalog: {} }));
vi.mock("~/rpc/atomRegistry", () => ({ appAtomRegistry: {} }));

import { MarkdownSourceSurface } from "~/components/files/FilePreviewPanel";
import { MarkdownPersistenceRegistry } from "./markdownPersistenceRegistry";
import { ScientMarkdownWorkspaceSurface } from "../ScientMarkdownWorkspaceSurface";
import { ScientMarkdownEditorView } from "../prosemirror/view";

describe("Markdown source persistence integration", () => {
  it.each(
    (["append", "prepend", "replace"] as const).flatMap((kind) =>
      [false, true].map((clean) => ({ kind, clean })),
    ),
  )(
    "rebases actual source undo across an external $kind (already saved: $clean)",
    async ({ kind, clean }) => {
      const base = "First paragraph.\n\nSecond paragraph.\n";
      let disk = { source: base, revision: "r0" };
      const registry = new MarkdownPersistenceRegistry({
        createTransport: () => ({
          write: async (intent) => {
            if (intent.expectedRevision !== disk.revision) throw "conflict";
            disk = { source: intent.source, revision: disk.revision + "!" };
            return { revision: disk.revision };
          },
          read: async () => disk,
          classifyFailure: () => "conflict",
          subscribe: () => () => {},
          project: () => {},
        }),
      });
      const lease = registry.acquire(target, {
        relativePath: target.relativePath,
        contents: base,
        revision: "r0",
        byteLength: base.length,
        truncated: false,
      })!;
      let attached!: () => void;
      const receipt = new Promise<void>((resolve) => {
        attached = resolve;
      });
      mocks.attached.mockImplementation(() => attached());
      await act(async () =>
        root.render(
          <MarkdownSourceSurface
            persistence={lease}
            {...target}
            composerDraftTarget={threadRef}
            resolvedTheme="light"
            revealRequestId={0}
            wordWrap={false}
            onPostRender={() => {}}
          />,
        ),
      );
      await act(async () => receipt);
      const editor = mocks.editors.at(-1)!;
      await act(async () => {
        const shadow = container.querySelector("diffs-container")!.shadowRoot!;
        const content = shadow.querySelector<HTMLElement>("[contenteditable=true]")!;
        const text = document
          .createTreeWalker(content.querySelector('[data-line="1"]')!, NodeFilter.SHOW_TEXT)
          .nextNode()!;
        const range = document.createRange();
        range.setStart(text, 0);
        range.collapse(true);
        // Chromium supplies this native range before the asynchronous
        // selectionchange has initialized Pierre's internal selection.
        vi.spyOn(document, "getSelection").mockReturnValue({
          getComposedRanges: () => [range],
        } as unknown as Selection);
        editor.setSelections([]);
        content.dispatchEvent(
          new InputEvent("beforeinput", {
            inputType: "insertText",
            data: "My ",
            bubbles: true,
            cancelable: true,
            composed: true,
          }),
        );
        vi.mocked(document.getSelection).mockRestore();
      });
      expect(editor.getText()).toBe("My " + base);
      // Keep a redo branch open while the external update arrives.
      await act(async () => {
        editor.applyEdits([
          {
            range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
            newText: "Extra ",
          },
        ]);
        editor.undo();
      });
      expect(editor.getText()).toBe("My " + base);
      const remote = (source: string) =>
        kind === "append"
          ? source + "\nAgent appendix\n"
          : kind === "prepend"
            ? "# Agent heading\n\n" + source
            : source.replace("Second", "Agent second");
      if (clean)
        await act(async () => {
          await lease.flushNow();
        });
      disk = { source: remote(clean ? "My " + base : base), revision: "external" };
      await act(async () => {
        lease.noteFreshnessHint("changed");
        expect(await lease.flushNow()).toBe(true);
      });
      expect(editor.getText()).toBe(remote("My " + base));
      expect(mocks.editors.at(-1)).toBe(editor);
      expect(lease.getSnapshot().conflict).toBeNull();
      await act(async () => editor.redo());
      expect(editor.getText()).toBe(remote("Extra My " + base));
      await act(async () => editor.undo());
      expect(editor.getText()).toBe(remote("My " + base));
      await act(async () => editor.undo());
      expect(editor.getText()).toBe(remote(base));
      await act(async () => {
        expect(await lease.flushNow()).toBe(true);
      });
      expect(disk.source).toBe(remote(base));
      await act(async () => editor.redo());
      expect(editor.getText()).toBe(remote("My " + base));
      await act(async () => {
        await lease.flushNow();
      });
      lease.release();
    },
  );

  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;
  const environmentId = EnvironmentId.make("source-synthetic");
  const target = { environmentId, cwd: "/synthetic-source", relativePath: "source.md" };
  const threadRef = { environmentId, threadId: ThreadId.make("synthetic-thread") };
  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    mocks.editors.length = 0;
    mocks.lateChanges.length = 0;
    mocks.attached.mockReset();
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
      font: "12px monospace",
      measureText: (text: string) => ({ width: text.length * 8 }),
    } as CanvasRenderingContext2D);
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
      x: 0,
      y: 0,
      top: 0,
      left: 0,
      right: 800,
      bottom: 600,
      width: 800,
      height: 600,
      toJSON: () => ({}),
    });
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("preserves the real source editor and undo timeline when save metadata changes", async () => {
    const write = vi.fn(async (intent: { source: string }) => ({
      revision: `revision:${intent.source}`,
    }));
    const registry = new MarkdownPersistenceRegistry({
      createTransport: () => ({
        write,
        read: async () => ({ source: "A", revision: "rA" }),
        classifyFailure: () => "terminal",
        subscribe: () => () => {},
        project: () => {},
      }),
    });
    const lease = registry.acquire(target, {
      relativePath: target.relativePath,
      contents: "A",
      revision: "rA",
      byteLength: 1,
      truncated: false,
    })!;
    let rendered!: () => void;
    const receipt = new Promise<void>((resolve) => {
      rendered = resolve;
    });
    mocks.attached.mockImplementation(() => rendered());
    await act(async () =>
      root.render(
        <MarkdownSourceSurface
          persistence={lease}
          {...target}
          composerDraftTarget={threadRef}
          resolvedTheme="light"
          revealRequestId={0}
          wordWrap={false}
          onPostRender={() => {}}
        />,
      ),
    );
    await act(async () => receipt);
    expect(mocks.editors.length).toBeGreaterThan(0);
    const editor = mocks.editors.at(-1)!;
    expect(editor.getText()).toBe("A");
    await act(async () =>
      editor.applyEdits([
        {
          range: { start: { line: 0, character: 1 }, end: { line: 0, character: 1 } },
          newText: "B",
        },
      ]),
    );
    expect(lease.getSnapshot().draftSource).toBe("AB");
    await act(async () => {
      await lease.flushNow();
    });
    expect(mocks.editors.at(-1)).toBe(editor);
    expect(editor.canUndo).toBe(true);
    await act(async () => editor.undo());
    expect(lease.getSnapshot().draftSource).toBe("A");
    await act(async () => {
      await lease.flushNow();
    });
    expect(write).toHaveBeenLastCalledWith(
      expect.objectContaining({ source: "A", expectedRevision: "revision:AB" }),
    );
    lease.release();
  });

  it("keeps one save ancestry across real source-rich-source edits and revokes an unmounted source callback", async () => {
    const mount = vi.spyOn(ScientMarkdownEditorView.prototype, "mount");
    let finishFirst!: (result: { revision: string }) => void;
    const held = new Promise<{ revision: string }>((resolve) => {
      finishFirst = resolve;
    });
    const write = vi.fn(async (intent: { source: string; expectedRevision: string }) => ({
      revision: `revision:${intent.source}`,
    }));
    write.mockImplementationOnce(() => held);
    const registry = new MarkdownPersistenceRegistry({
      createTransport: () => ({
        write,
        read: async () => ({ source: "A", revision: "rA" }),
        classifyFailure: () => "terminal",
        subscribe: () => () => {},
        project: () => {},
      }),
    });
    const lease = registry.acquire(target, {
      relativePath: target.relativePath,
      contents: "A",
      revision: "rA",
      byteLength: 1,
      truncated: false,
    })!;
    const sourceView = () => (
      <MarkdownSourceSurface
        persistence={lease}
        {...target}
        composerDraftTarget={threadRef}
        resolvedTheme="light"
        revealRequestId={0}
        wordWrap={false}
        onPostRender={() => {}}
      />
    );
    let attached!: () => void;
    let receipt = new Promise<void>((resolve) => {
      attached = resolve;
    });
    mocks.attached.mockImplementation(() => attached());
    await act(async () => root.render(sourceView()));
    await act(async () => receipt);
    const sourceEditor = mocks.editors.at(-1)!;
    const staleChange = mocks.lateChanges.at(-1)!;
    await act(async () =>
      sourceEditor.applyEdits([
        {
          range: { start: { line: 0, character: 1 }, end: { line: 0, character: 1 } },
          newText: "B",
        },
      ]),
    );
    let saved!: Promise<boolean>;
    await act(async () => {
      saved = lease.flushNow();
    });
    await act(async () =>
      root.render(
        <ScientMarkdownWorkspaceSurface persistence={lease} ariaLabel="Synthetic rich Markdown" />,
      ),
    );
    await act(async () => staleChange("late stale source"));
    expect(lease.getSnapshot().draftSource).toBe("AB");
    const rich = (mount.mock.instances as unknown as ScientMarkdownEditorView[]).find(
      (controller) => controller.view?.dom.isConnected,
    )!;
    expect(rich).toBeDefined();
    await act(async () => rich.replaceUserSource("ABC"));
    await act(async () => {
      finishFirst({ revision: "revision:AB" });
      expect(await saved).toBe(true);
    });
    expect(write).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ source: "ABC", expectedRevision: "revision:AB" }),
    );
    expect(lease.getSnapshot().conflict).toBeNull();
    receipt = new Promise<void>((resolve) => {
      attached = resolve;
    });
    await act(async () => root.render(sourceView()));
    await act(async () => receipt);
    const returnedEditor = mocks.editors.at(-1)!;
    expect(returnedEditor.getText()).toBe("ABC");
    await act(async () =>
      returnedEditor.applyEdits([
        {
          range: { start: { line: 0, character: 3 }, end: { line: 0, character: 3 } },
          newText: "D",
        },
      ]),
    );
    await act(async () => {
      expect(await lease.flushNow()).toBe(true);
    });
    expect(write).toHaveBeenLastCalledWith(
      expect.objectContaining({ source: "ABCD", expectedRevision: "revision:ABC" }),
    );
    lease.release();
  });

  it("accepts the first source keystroke after an incremental external clean read", async () => {
    const write = vi.fn(async () => ({ revision: "rBC" }));
    const registry = new MarkdownPersistenceRegistry({
      createTransport: () => ({
        write,
        read: async () => ({ source: "B", revision: "rB" }),
        classifyFailure: () => "terminal",
        subscribe: () => () => {},
        project: () => {},
      }),
    });
    const lease = registry.acquire(target, {
      relativePath: target.relativePath,
      contents: "A",
      revision: "rA",
      byteLength: 1,
      truncated: false,
    })!;
    let attached!: () => void;
    const receipt = new Promise<void>((resolve) => {
      attached = resolve;
    });
    mocks.attached.mockImplementation(() => attached());
    await act(async () =>
      root.render(
        <MarkdownSourceSurface
          persistence={lease}
          {...target}
          composerDraftTarget={threadRef}
          resolvedTheme="light"
          revealRequestId={0}
          wordWrap={false}
          onPostRender={() => {}}
        />,
      ),
    );
    await act(async () => receipt);
    await act(async () => {
      expect(await lease.refresh()).toBe(true);
    });
    const editor = mocks.editors.at(-1)!;
    expect(editor.getText()).toBe("B");
    await act(async () => {
      document.body.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
    });
    await act(async () =>
      editor.applyEdits([
        {
          range: { start: { line: 0, character: 1 }, end: { line: 0, character: 1 } },
          newText: "C",
        },
      ]),
    );
    expect(lease.getSnapshot().draftSource).toBe("BC");
    await act(async () => {
      await lease.flushNow();
    });
    expect(write).toHaveBeenCalledWith(
      expect.objectContaining({ source: "BC", expectedRevision: "rB" }),
    );
    lease.release();
  });

  it("does not dismiss a detached source editor during a rename hold", async () => {
    const registry = new MarkdownPersistenceRegistry({
      createTransport: () => ({
        write: async () => ({ revision: "rA" }),
        read: async () => ({ source: "A", revision: "rA" }),
        classifyFailure: () => "terminal",
        subscribe: () => () => {},
        project: () => {},
      }),
    });
    const lease = registry.acquire(target, {
      relativePath: target.relativePath,
      contents: "A",
      revision: "rA",
      byteLength: 1,
      truncated: false,
    })!;
    let attached!: () => void;
    let receipt = new Promise<void>((resolve) => {
      attached = resolve;
    });
    mocks.attached.mockImplementation(() => attached());
    await act(async () =>
      root.render(
        <MarkdownSourceSurface
          persistence={lease}
          {...target}
          composerDraftTarget={threadRef}
          resolvedTheme="light"
          revealRequestId={0}
          wordWrap={false}
          onPostRender={() => {}}
        />,
      ),
    );
    await act(async () => receipt);
    const editor = mocks.editors.at(-1)!;
    const failures: unknown[] = [];
    const setSelections = editor.setSelections.bind(editor);
    vi.spyOn(editor, "setSelections").mockImplementation((selections) => {
      try {
        setSelections(selections);
      } catch (error) {
        failures.push(error);
      }
    });
    let releaseHold!: () => void;
    await act(async () => {
      releaseHold = lease.holdForRename()!;
    });
    expect(releaseHold).toBeTypeOf("function");
    expect(editor.getFile()).toBeUndefined();
    await act(async () => {
      document.body.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
    });
    expect(failures).toEqual([]);
    receipt = new Promise<void>((resolve) => {
      attached = resolve;
    });
    await act(async () => releaseHold());
    await act(async () => receipt);
    expect(editor.getText()).toBe("A");
    lease.release();
  });
});
