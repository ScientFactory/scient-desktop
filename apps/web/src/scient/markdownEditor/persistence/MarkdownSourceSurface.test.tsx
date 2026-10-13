// @vitest-environment happy-dom
import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { EditStateManager, type Editor } from "@pierre/diffs/edit";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

type ObservedEditor = Pick<
  Editor<"file", unknown, undefined>,
  | "applyEdits"
  | "getText"
  | "getFile"
  | "canUndo"
  | "undo"
  | "redo"
  | "setSelections"
  | "prepareExternalEdits"
  | "isComposing"
>;
const mocks = vi.hoisted(() => ({
  editors: [] as ObservedEditor[],
  addReviewComment: vi.fn(),
  removeReviewComment: vi.fn(),
  attached: vi.fn(),
  lateChanges: [] as Array<(source: string) => void>,
}));

vi.mock("@pierre/diffs/edit", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@pierre/diffs/edit")>();
  return {
    ...actual,
    Editor: class<LAnnotation> extends actual.Editor<"file", LAnnotation, undefined> {
      constructor(
        type: "file",
        options?: import("@pierre/diffs/edit").EditorOptions<"file", LAnnotation, undefined>,
        editStateKey?: string,
      ) {
        super(
          type,
          {
            ...options,
            onAttach: (editor, instance) => {
              options?.onAttach?.(editor, instance);
              mocks.attached(editor);
            },
          },
          editStateKey,
        );
        mocks.editors.push(this);
        mocks.lateChanges.push((source) =>
          options?.onChange?.({
            changes: [],
            file: { name: "source.md", contents: source },
            editor: this,
          }),
        );
      }
    },
  };
});

vi.mock("@pierre/diffs/react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@pierre/diffs/react")>();
  const { useRef } = await import("react");
  return {
    ...actual,
    File: function <LAnnotation, Caret>(
      props: React.ComponentProps<typeof actual.File<LAnnotation, Caret>>,
    ) {
      const attachedEditor = useRef<
        import("@pierre/diffs/edit").Editor<"file", LAnnotation, Caret> | undefined
      >(undefined);
      mocks.lateChanges.push((source) => {
        const editor = attachedEditor.current;
        if (editor === undefined)
          throw new Error("The native file must attach before reporting a change.");
        props.onEditChange?.({
          changes: [],
          file: { name: "source.md", contents: source },
          editor,
        });
      });
      return (
        <actual.File
          {...props}
          editorOptions={{
            ...props.editorOptions,
            onAttach: (editor, instance) => {
              attachedEditor.current = editor;
              props.editorOptions?.onAttach?.(editor, instance);
            },
          }}
        />
      );
    },
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
import { ScientMarkdownPersistenceNotice } from "../ui/ScientMarkdownPersistenceNotice";

describe("Markdown source persistence integration", () => {
  it("blocks an independently open Source editor while rich input is pending and provides a return action", async () => {
    const source = "# Result [@smith]\n\nTail\n";
    const write = vi.fn(async () => ({ revision: "r1" }));
    const registry = new MarkdownPersistenceRegistry({
      createTransport: () => ({
        write,
        read: async () => ({ source, revision: "r0" }),
        classifyFailure: () => "terminal",
        subscribe: () => () => {},
        project: () => {},
      }),
    });
    const richLease = registry.acquire(target, {
      relativePath: target.relativePath,
      contents: source,
      revision: "r0",
      byteLength: source.length,
      truncated: false,
    })!;
    const sourceLease = registry.acquire(target, null)!;
    const mount = vi.spyOn(ScientMarkdownEditorView.prototype, "mount");
    const returnToRich = vi.fn();
    let attached!: () => void;
    const receipt = new Promise<void>((resolve) => {
      attached = resolve;
    });
    mocks.attached.mockImplementation(() => attached());
    await act(async () =>
      root.render(
        <>
          <ScientMarkdownWorkspaceSurface persistence={richLease} ariaLabel="Rich" />
          <ScientMarkdownPersistenceNotice
            persistence={sourceLease}
            onReturnToRich={returnToRich}
          />
          <MarkdownSourceSurface
            persistence={sourceLease}
            {...target}
            composerDraftTarget={threadRef}
            resolvedTheme="light"
            revealRequestId={0}
            wordWrap={false}
            onPostRender={() => {}}
          />
        </>,
      ),
    );
    await act(async () => receipt);
    const rich = (mount.mock.instances as unknown as ScientMarkdownEditorView[]).find(
      (controller) => controller.view?.dom.isConnected,
    )!;
    let position = -1;
    rich.view!.state.doc.descendants((node, from) => {
      if (node.type.name === "citation") position = from;
    });
    await act(async () =>
      rich.view!.dispatch(
        rich.view!.state.tr.setNodeAttribute(position, "source", "@smith\n@jones"),
      ),
    );
    const shadow = container.querySelector("diffs-container")!.shadowRoot!;
    expect(shadow.querySelector('[data-content][contenteditable="true"]')).toBeNull();
    expect(container.textContent).toContain("Finish the pending edit in Rich");
    const button = [...container.querySelectorAll("button")].find(
      (candidate) => candidate.textContent === "Return to Rich",
    )!;
    await act(async () => button.click());
    expect(returnToRich).toHaveBeenCalledOnce();
    await act(async () => mocks.lateChanges.at(-1)!("Unsafe source replacement"));
    expect(sourceLease.getSnapshot().draftSource).toBe(source);
    expect(write).not.toHaveBeenCalled();
    await act(async () => rich.executeKeyboardCommand("markdown.undo"));
    expect(sourceLease.getPendingInput()).toBeNull();
    expect(container.textContent).not.toContain("Finish the pending edit in Rich");
    richLease.release();
    sourceLease.release();
  });
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
    EditStateManager.clearAll();
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    mocks.editors.length = 0;
    mocks.lateChanges.length = 0;
    mocks.attached.mockReset();
    // SCIENT-FORK: `@types/three` pulls `@webgpu/types`, which adds a WebGPU
    // `getContext` overload. Cast to the mocked method's return type so the
    // 2D-context double satisfies every overload.
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
      font: "12px monospace",
      measureText: (text: string) => ({ width: text.length * 8 }),
    } as unknown as ReturnType<HTMLCanvasElement["getContext"]>);
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

  async function attachNativeHistoryFixture(source: string) {
    const registry = new MarkdownPersistenceRegistry({
      createTransport: () => ({
        write: async (intent) => ({ revision: `revision:${intent.source}` }),
        read: async () => ({ source, revision: "r0" }),
        classifyFailure: () => "terminal",
        subscribe: () => () => {},
        project: () => {},
      }),
    });
    const lease = registry.acquire(target, {
      relativePath: target.relativePath,
      contents: source,
      revision: "r0",
      byteLength: new TextEncoder().encode(source).byteLength,
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
    return { lease, editor: mocks.editors.at(-1)! };
  }

  it.each([
    { boundary: "before", offset: 1, source: "ACB" },
    { boundary: "after", offset: 2, source: "ABC" },
  ])(
    "keeps native local insertion order with an external insertion $boundary its boundary",
    async ({ offset, source }) => {
      const { lease, editor } = await attachNativeHistoryFixture("A");
      await act(async () =>
        editor.applyEdits([
          {
            range: { start: { line: 0, character: 1 }, end: { line: 0, character: 1 } },
            newText: "B",
          },
        ]),
      );
      const prepared = editor.prepareExternalEdits("AB", [
        { start: offset, end: offset, text: "C" },
      ]);
      expect(prepared).not.toBeNull();
      await act(async () => prepared!());
      expect(editor.getText()).toBe(source);
      await act(async () => editor.undo());
      expect(editor.getText()).toBe("AC");
      expect(lease.getSnapshot().draftSource).toBe("AC");
      await act(async () => editor.redo());
      expect(editor.getText()).toBe(source);
      expect(lease.getSnapshot().draftSource).toBe(source);
      lease.release();
    },
  );

  it("keeps reciprocal offsets across multiple native local and external edits", async () => {
    const { lease, editor } = await attachNativeHistoryFixture("AD");
    await act(async () =>
      editor.applyEdits([
        {
          range: { start: { line: 0, character: 1 }, end: { line: 0, character: 1 } },
          newText: "B",
        },
        {
          range: { start: { line: 0, character: 2 }, end: { line: 0, character: 2 } },
          newText: "E",
        },
      ]),
    );
    expect(editor.getText()).toBe("ABDE");
    const prepared = editor.prepareExternalEdits("ABDE", [
      { start: 0, end: 0, text: "Z" },
      { start: 4, end: 4, text: "Y" },
    ]);
    expect(prepared).not.toBeNull();
    await act(async () => prepared!());
    expect(editor.getText()).toBe("ZABDEY");
    await act(async () => editor.undo());
    expect(editor.getText()).toBe("ZADY");
    expect(lease.getSnapshot().draftSource).toBe("ZADY");
    await act(async () => editor.redo());
    expect(editor.getText()).toBe("ZABDEY");
    expect(lease.getSnapshot().draftSource).toBe("ZABDEY");
    lease.release();
  });

  it("declines intersecting native history atomically without mutating source or undo", async () => {
    const { lease, editor } = await attachNativeHistoryFixture("A");
    await act(async () =>
      editor.applyEdits([
        {
          range: { start: { line: 0, character: 1 }, end: { line: 0, character: 1 } },
          newText: "B",
        },
      ]),
    );
    const snapshot = lease.getSnapshot();
    expect(editor.prepareExternalEdits("AB", [{ start: 1, end: 2, text: "C" }])).toBeNull();
    expect(editor.getText()).toBe("AB");
    expect(lease.getSnapshot()).toBe(snapshot);
    expect(editor.canUndo).toBe(true);
    await act(async () => editor.undo());
    expect(editor.getText()).toBe("A");
    await act(async () => editor.redo());
    expect(editor.getText()).toBe("AB");
    lease.release();
  });

  it("refuses native external preparation and a captured commit while composing", async () => {
    const { lease, editor } = await attachNativeHistoryFixture("A");
    await act(async () =>
      editor.applyEdits([
        {
          range: { start: { line: 0, character: 1 }, end: { line: 0, character: 1 } },
          newText: "B",
        },
      ]),
    );
    const edit = [{ start: 2, end: 2, text: "C" }];
    const prepared = editor.prepareExternalEdits("AB", edit);
    expect(prepared).not.toBeNull();
    const snapshot = lease.getSnapshot();
    const content = container
      .querySelector("diffs-container")!
      .shadowRoot!.querySelector<HTMLElement>('[data-content][contenteditable="true"]')!;
    await act(async () => {
      content.dispatchEvent(
        new CompositionEvent("compositionstart", {
          bubbles: true,
          composed: true,
          data: "",
        }),
      );
    });
    expect(editor.isComposing).toBe(true);
    expect(editor.prepareExternalEdits("AB", edit)).toBeNull();
    expect(() => prepared!()).toThrow("External editor update became stale");
    expect(editor.getText()).toBe("AB");
    expect(lease.getSnapshot()).toBe(snapshot);
    await act(async () => {
      content.dispatchEvent(
        new CompositionEvent("compositionend", {
          bubbles: true,
          composed: true,
          data: "",
        }),
      );
    });
    expect(editor.isComposing).toBe(false);
    const resumed = editor.prepareExternalEdits("AB", edit);
    expect(resumed).not.toBeNull();
    await act(async () => resumed!());
    await act(async () => editor.undo());
    expect(editor.getText()).toBe("AC");
    await act(async () => editor.redo());
    expect(editor.getText()).toBe("ABC");
    lease.release();
  });

  it("refuses a prepared native commit after a newer local edit without disturbing its history", async () => {
    const { lease, editor } = await attachNativeHistoryFixture("A");
    await act(async () =>
      editor.applyEdits([
        {
          range: { start: { line: 0, character: 1 }, end: { line: 0, character: 1 } },
          newText: "B",
        },
      ]),
    );
    const prepared = editor.prepareExternalEdits("AB", [{ start: 2, end: 2, text: "C" }]);
    expect(prepared).not.toBeNull();
    // A nonadjacent insertion starts a distinct native history group. Appending
    // X beside B would intentionally coalesce both typed insertions into one.
    await act(async () =>
      editor.applyEdits([
        {
          range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
          newText: "X",
        },
      ]),
    );
    const snapshot = lease.getSnapshot();
    const document = EditStateManager.get(
      "file",
      // A document session's source state belongs to the document.
      `scient-document:${lease.documentId}`,
    )!.document;
    const history = structuredClone(document.history);
    expect(history.undoStack).toHaveLength(2);
    expect(() => prepared!()).toThrow("External editor update became stale");
    expect(editor.getText()).toBe("XAB");
    expect(lease.getSnapshot()).toBe(snapshot);
    expect(document.history).toEqual(history);
    await act(async () => editor.undo());
    expect(editor.getText()).toBe("AB");
    await act(async () => editor.redo());
    expect(editor.getText()).toBe("XAB");
    lease.release();
  });

  it("pauses a native restoration if the authoritative lease advances during preparation", async () => {
    const mount = vi.spyOn(ScientMarkdownEditorView.prototype, "mount");
    const { lease, editor } = await attachNativeHistoryFixture("A");
    await act(async () =>
      editor.applyEdits([
        {
          range: { start: { line: 0, character: 1 }, end: { line: 0, character: 1 } },
          newText: "B",
        },
      ]),
    );
    await act(async () =>
      root.render(
        <ScientMarkdownWorkspaceSurface persistence={lease} ariaLabel="Rich lease currentness" />,
      ),
    );
    const rich = (mount.mock.instances as unknown as ScientMarkdownEditorView[]).find(
      (controller) => controller.view?.dom.isConnected,
    )!;
    await act(async () => rich.replaceUserSource("ABC"));
    const { Editor } = await import("@pierre/diffs/edit");
    const nativePrepare = Editor.prototype.prepareExternalEdits;
    let preparedReceipt = false;
    let advancedLease = false;
    vi.spyOn(Editor.prototype, "prepareExternalEdits").mockImplementation(function (
      this: InstanceType<typeof Editor>,
      source,
      edits,
    ) {
      const prepared = nativePrepare.call(this, source, edits);
      if (source === "AB") {
        preparedReceipt = prepared !== null;
        advancedLease = lease.change("ABCX", lease.getSnapshot().editVersion);
      }
      return prepared;
    });
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
    expect(preparedReceipt).toBe(true);
    expect(advancedLease).toBe(true);
    const snapshot = lease.getSnapshot();
    expect(snapshot.draftSource).toBe("ABCX");
    const retained = EditStateManager.get(
      "file",
      // A document session's source state belongs to the document.
      `scient-document:${lease.documentId}`,
    );
    expect(retained?.document.getText()).toBe("AB");
    expect(retained?.document.canUndo).toBe(true);
    expect(mocks.editors.at(-1)!.getFile()).toBeUndefined();
    const shadow = container.querySelector("diffs-container")!.shadowRoot!;
    expect(shadow.querySelector('[data-content][contenteditable="true"]')).toBeNull();
    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      "Source editing is paused",
    );
    await act(async () => mocks.lateChanges.at(-1)!("ABx"));
    expect(lease.getSnapshot()).toBe(snapshot);
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
    expect(lease.getSnapshot().draftSource).toBe("ABC");
    const retained = EditStateManager.get(
      "file",
      // A document session's source state belongs to the document.
      `scient-document:${lease.documentId}`,
    );
    expect(retained?.document.getText()).toBe("AB");
    receipt = new Promise<void>((resolve) => {
      attached = resolve;
    });
    await act(async () => root.render(sourceView()));
    await act(async () => receipt);
    const returnedEditor = mocks.editors.at(-1)!;
    expect(mocks.attached.mock.lastCall?.[0]).toBe(returnedEditor);
    expect(sourceEditor.getFile()).toBeUndefined();
    expect(returnedEditor.getText()).toBe("ABC");
    expect(returnedEditor.canUndo).toBe(true);
    await act(async () => returnedEditor.undo());
    expect(returnedEditor.getText()).toBe("AC");
    expect(lease.getSnapshot().draftSource).toBe("AC");
    await act(async () => returnedEditor.redo());
    expect(returnedEditor.getText()).toBe("ABC");
    expect(lease.getSnapshot().draftSource).toBe("ABC");
    await act(async () => staleChange("late stale source after return"));
    expect(lease.getSnapshot().draftSource).toBe("ABC");
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

  it.each([false, true])(
    "pauses a declined overlapping source restoration without losing undo or lease ancestry (saved: %s)",
    async (saved) => {
      const mount = vi.spyOn(ScientMarkdownEditorView.prototype, "mount");
      const write = vi.fn(async (intent: { source: string; expectedRevision: string }) => ({
        revision: `revision:${intent.source}`,
      }));
      const registry = new MarkdownPersistenceRegistry({
        createTransport: () => ({
          write,
          read: async () => ({ source: "A", revision: "r0" }),
          classifyFailure: () => "terminal",
          subscribe: () => () => {},
          project: () => {},
        }),
      });
      const lease = registry.acquire(target, {
        relativePath: target.relativePath,
        contents: "A",
        revision: "r0",
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
      await act(async () =>
        mocks.editors.at(-1)!.applyEdits([
          {
            range: { start: { line: 0, character: 1 }, end: { line: 0, character: 1 } },
            newText: "B",
          },
        ]),
      );
      if (saved)
        await act(async () => {
          expect(await lease.flushNow()).toBe(true);
        });
      await act(async () =>
        root.render(
          <ScientMarkdownWorkspaceSurface
            persistence={lease}
            ariaLabel="Rich overlapping source"
          />,
        ),
      );
      const rich = (mount.mock.instances as unknown as ScientMarkdownEditorView[]).find(
        (controller) => controller.view?.dom.isConnected,
      )!;
      await act(async () => rich.replaceUserSource("AC"));
      if (saved)
        await act(async () => {
          expect(await lease.flushNow()).toBe(true);
        });
      const editVersion = lease.getSnapshot().editVersion;
      const written = write.mock.calls.length;
      receipt = new Promise<void>((resolve) => {
        attached = resolve;
      });
      await act(async () => root.render(sourceView()));
      await act(async () => receipt);
      const retained = EditStateManager.get(
        "file",
        // A document session's source state belongs to the document.
        `scient-document:${lease.documentId}`,
      );
      expect(retained?.document.getText()).toBe("AB");
      expect(retained?.document.canUndo).toBe(true);
      expect(mocks.editors.at(-1)!.getFile()).toBeUndefined();
      const shadow = container.querySelector("diffs-container")!.shadowRoot!;
      expect(shadow.querySelector('[data-content][contenteditable="true"]')).toBeNull();
      expect(shadow.querySelector('[data-content] [data-line="1"]')?.textContent).toBe("AC");
      expect(container.querySelector('[role="alert"]')?.textContent).toContain(
        "Source editing is paused",
      );
      await act(async () => mocks.lateChanges.at(-1)!("ABx"));
      expect(lease.getSnapshot().draftSource).toBe("AC");
      expect(lease.getSnapshot().editVersion).toBe(editVersion);
      expect(write).toHaveBeenCalledTimes(written);
      await act(async () => {
        expect(await lease.flushNow()).toBe(true);
      });
      expect(write).toHaveBeenLastCalledWith(
        expect.objectContaining({
          source: "AC",
          expectedRevision: saved ? "revision:AB" : "r0",
        }),
      );
      lease.release();
    },
  );

  it("rebases a dormant native source editor at whole Unicode and CRLF boundaries without losing local undo", async () => {
    const initial = "A😀\r\nTail";
    const changed = "AB😁\nTail";
    const mount = vi.spyOn(ScientMarkdownEditorView.prototype, "mount");
    const prepare = vi.spyOn(
      (await import("@pierre/diffs/edit")).Editor.prototype,
      "prepareExternalEdits",
    );
    const write = vi.fn(async (intent: { source: string; expectedRevision: string }) => ({
      revision: `revision:${intent.source}`,
    }));
    const registry = new MarkdownPersistenceRegistry({
      createTransport: () => ({
        write,
        read: async () => ({ source: initial, revision: "r0" }),
        classifyFailure: () => "terminal",
        subscribe: () => () => {},
        project: () => {},
      }),
    });
    const lease = registry.acquire(target, {
      relativePath: target.relativePath,
      contents: initial,
      revision: "r0",
      byteLength: new TextEncoder().encode(initial).byteLength,
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
    await act(async () =>
      sourceEditor.applyEdits([
        {
          range: { start: { line: 0, character: 1 }, end: { line: 0, character: 1 } },
          newText: "B",
        },
      ]),
    );
    await act(async () => {
      expect(await lease.flushNow()).toBe(true);
    });
    await act(async () =>
      root.render(<ScientMarkdownWorkspaceSurface persistence={lease} ariaLabel="Rich Unicode" />),
    );
    const rich = (mount.mock.instances as unknown as ScientMarkdownEditorView[]).find(
      (controller) => controller.view?.dom.isConnected,
    )!;
    await act(async () => rich.replaceUserSource(changed));
    await act(async () => {
      expect(await lease.flushNow()).toBe(true);
    });
    expect(lease.getSnapshot().draftSource).toBe(changed);
    receipt = new Promise<void>((resolve) => {
      attached = resolve;
    });
    await act(async () => root.render(sourceView()));
    await act(async () => receipt);
    const returnedEditor = mocks.editors.at(-1)!;
    expect(mocks.attached.mock.lastCall?.[0]).toBe(returnedEditor);
    expect(returnedEditor.getText()).toBe(changed);
    expect(prepare).toHaveBeenLastCalledWith("AB😀\r\nTail", [{ start: 2, end: 6, text: "😁\n" }]);
    await act(async () => returnedEditor.undo());
    expect(returnedEditor.getText()).toBe("A😁\nTail");
    expect(lease.getSnapshot().draftSource).toBe("A😁\nTail");
    await act(async () => returnedEditor.redo());
    expect(lease.getSnapshot().draftSource).toBe(changed);
    expect(write).toHaveBeenLastCalledWith(
      expect.objectContaining({ source: changed, expectedRevision: "revision:AB😀\r\nTail" }),
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

  it("keeps the caret on live source rows after replacing and regrowing a document", async () => {
    const source = "first\nsecond\nthird\nfourth";
    const registry = new MarkdownPersistenceRegistry({
      createTransport: () => ({
        write: async () => ({ revision: "saved" }),
        read: async () => ({ source, revision: "initial" }),
        classifyFailure: () => "terminal",
        subscribe: () => () => {},
        project: () => {},
      }),
    });
    const lease = registry.acquire(target, {
      relativePath: target.relativePath,
      contents: source,
      revision: "initial",
      byteLength: source.length,
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
    const selection = window.getSelection()!;
    const setBaseAndExtent = selection.setBaseAndExtent.bind(selection);
    const liveAnchors: boolean[] = [];
    let phase = "initial-selection";
    const detachedAnchors: Array<{
      phase: string;
      anchorConnected: boolean;
      focusConnected: boolean;
      source: string;
      stack: string | undefined;
    }> = [];
    vi.spyOn(selection, "setBaseAndExtent").mockImplementation(
      (anchor, anchorOffset, focus, focusOffset) => {
        liveAnchors.push(anchor.isConnected && focus.isConnected);
        if (!anchor.isConnected || !focus.isConnected)
          detachedAnchors.push({
            phase,
            anchorConnected: anchor.isConnected,
            focusConnected: focus.isConnected,
            source: editor.getText(),
            stack: new Error("Detached source selection").stack,
          });
        setBaseAndExtent(anchor, anchorOffset, focus, focusOffset);
      },
    );
    const end = { line: 3, character: 6 };
    await act(async () => {
      editor.setSelections([{ start: end, end, direction: "none" }]);
      phase = "replace-document";
      editor.applyEdits([{ range: { start: { line: 0, character: 0 }, end }, newText: "x" }]);
      phase = "regrow-document";
      editor.applyEdits([
        {
          range: { start: { line: 0, character: 1 }, end: { line: 0, character: 1 } },
          newText: "\ny\nz\nw",
        },
      ]);
    });
    expect(editor.getText()).toBe("x\ny\nz\nw");
    expect(liveAnchors.length).toBeGreaterThan(0);
    if (detachedAnchors.length > 0)
      console.error("Detached source selection before fixture cleanup", detachedAnchors);
    expect(liveAnchors.every(Boolean)).toBe(true);
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
    const returnedEditor = mocks.editors.at(-1)!;
    expect(returnedEditor.getText()).toBe("A");
    expect(editor.getFile()).toBeUndefined();
    expect(lease.getSnapshot().draftSource).toBe("A");
    lease.release();
  });
});
