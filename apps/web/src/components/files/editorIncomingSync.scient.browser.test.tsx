import { act, render } from "../../../test/render";
import "../../index.css";

import { EditStateManager, type Editor } from "@pierre/diffs/edit";
import {
  EnvironmentId,
  ProjectWriteFileError,
  ThreadId,
  type ProjectReadFileResult,
  type ProjectWriteFileInput,
  type ProjectWriteFileResult,
} from "@t3tools/contracts";
import { projectFileOperationKey } from "@t3tools/client-runtime/state/projects";
import * as Cause from "effect/Cause";
import { AsyncResult, Atom } from "effect/reactivity";
import { createContext, useContext, useLayoutEffect, useState } from "react";
import { describe, expect, it, vi } from "vite-plus/test";

const runtime = vi.hoisted(() => ({
  editor: null as Editor<"file", unknown, undefined> | null,
  project: null as null | ((contents: string) => void),
  write:
    vi.fn<
      (request: {
        input: ProjectWriteFileInput;
      }) => Promise<AsyncResult.AsyncResult<ProjectWriteFileResult, ProjectWriteFileError>>
    >(),
}));
vi.mock("@pierre/diffs/react", async (original) => {
  const actual = await original<typeof import("@pierre/diffs/react")>();
  return {
    ...actual,
    File: function <LAnnotation, Caret>(
      props: React.ComponentProps<typeof actual.File<LAnnotation, Caret>>,
    ) {
      return (
        <actual.File
          {...props}
          editorOptions={{
            ...props.editorOptions,
            onAttach: (editor, instance) => {
              props.editorOptions?.onAttach?.(editor, instance);
              runtime.editor = editor as unknown as typeof runtime.editor;
            },
          }}
        />
      );
    },
  };
});
vi.mock(import("~/state/session"), async (original) => ({
  ...(await original()),
  readEnvironmentScope: (() => true) as never,
}));
const write = (request: { input: ProjectWriteFileInput }) => runtime.write(request);
vi.mock(import("~/state/use-atom-command"), async (original) => ({
  ...(await original()),
  useAtomCommand: (() => write) as never,
}));
vi.mock(import("./projectFilesQueryState"), async (original) => ({
  ...(await original()),
  useProjectFileQuery: (() => ({ ...useContext(QueryContext)!, refresh: () => {} })) as never,
  setProjectFileQueryData: ((_environment, _cwd, _path, contents) => {
    runtime.project!(contents);
  }) as typeof import("./projectFilesQueryState").setProjectFileQueryData,
}));

import { EditableFileSurface, MarkdownSourceSurface } from "./FilePreviewPanel";
import {
  clearWorkspaceFileSessionsForTests,
  workspaceFileSessionFlush,
} from "./useFileSaveCoordinator";
import { useWorkspaceFileRefresh } from "~/scient/fileSurfaces/useWorkspaceFileRefresh";
import { MarkdownPersistenceRegistry } from "~/scient/markdownEditor/persistence/markdownPersistenceRegistry";
import { createTestCheckpointStore } from "~/scient/markdownEditor/persistence/markdownDraftCheckpointTestkit";
import { flushFolderEditors } from "~/scient/editorFlush/flushFolderEditors";
import { EditorCompositions } from "~/scient/editorFlush/editorComposition";
import { LatexDocumentInputs } from "~/scient/latex/latexDocumentInputs";
import { projectEnvironment } from "~/state/projects";
import { indexedDbMarkdownDrafts } from "~/scient/markdownEditor/persistence/markdownDraftCheckpoint";

const target = {
  environmentId: EnvironmentId.make("incoming-sync-browser"),
  cwd: "/incoming-sync-browser",
  relativePath: "remote.txt",
};
const composerDraftTarget = {
  environmentId: target.environmentId,
  threadId: ThreadId.make("sync"),
};
const base = { contents: "base remote", revision: "r0" };
const incoming = { contents: "remote edit two", revision: "r1" };
const snapshot = (file: typeof base): ProjectReadFileResult => ({
  ...file,
  relativePath: target.relativePath,
  byteLength: file.contents.length,
  truncated: false,
});
const surfaceProps = {
  ...target,
  composerDraftTarget,
  resolvedTheme: "light" as const,
  revealRequestId: 0,
  wordWrap: false,
  onPostRender: () => {},
};
const QueryContext = createContext<{
  data: ProjectReadFileResult;
  authoritativeData: ProjectReadFileResult;
} | null>(null);

async function setup() {
  EditStateManager.clearAll();
  runtime.editor = null;
  runtime.write.mockReset();
  const stack = new AsyncDisposableStack();
  stack.defer(async () => {
    clearWorkspaceFileSessionsForTests();
    const key = projectFileOperationKey(target);
    const copy = await indexedDbMarkdownDrafts.read(key);
    if (copy) await indexedDbMarkdownDrafts.replace(key, copy.token, undefined);
    EditStateManager.clearAll();
  });
  stack.use(
    vi
      .spyOn(projectEnvironment, "fileChanges")
      .mockReturnValue(Atom.make(AsyncResult.initial(false))),
  );
  let disk = snapshot(base);
  let replaceDisk!: (file: ProjectReadFileResult) => void;
  function Host() {
    const [current, setCurrent] = useState(disk);
    const [optimistic, setOptimistic] = useState<ProjectReadFileResult | null>(null);
    useLayoutEffect(() => {
      replaceDisk = (file) => {
        disk = file;
        setCurrent(file);
      };
      runtime.project = (contents) => setOptimistic({ ...disk, contents });
    }, []);
    return (
      <QueryContext
        value={{ data: optimistic ?? current, authoritativeData: optimistic ?? current }}
      >
        <Surface />
      </QueryContext>
    );
  }
  function Surface() {
    const [dirty, setDirty] = useState(false);
    const refresh = useWorkspaceFileRefresh({
      ...target,
      loadAsText: true,
      sourcePending: dirty,
      workspaceMutationId: null,
    });
    return (
      <>
        <output>{dirty ? "Unsaved" : "Saved"}</output>
        {refresh.reloadNotice && (
          <div role="alert">This file changed on disk while you were editing.</div>
        )}
        <EditableFileSurface
          {...surfaceProps}
          contents={refresh.file.data!.contents}
          initialSource={refresh.file.authoritativeData!.contents}
          revision={refresh.file.authoritativeData!.revision}
          onPendingChange={(_path, value) => setDirty(value)}
          onSaveFailure={refresh.handleSaveFailure}
          onSaveConfirmed={refresh.handleSaveConfirmed}
          onSaveResolutionApplied={refresh.handleSaveResolutionApplied}
          saveResolution={refresh.saveResolution}
        />
      </>
    );
  }
  runtime.write.mockImplementation(async ({ input }) => {
    if (input.expectedRevision !== disk.revision)
      return AsyncResult.failure(
        Cause.fail(
          new ProjectWriteFileError({
            cwd: target.cwd,
            relativePath: target.relativePath,
            failure: "revision_conflict",
            currentRevision: disk.revision,
          }),
        ),
      );
    disk = { ...disk, contents: input.contents, revision: "saved" };
    return AsyncResult.success({ relativePath: target.relativePath, revision: disk.revision });
  });
  try {
    const screen = stack.use(await render(<Host />, { router: false }));
    screen.container.style.cssText = "display:flex;flex-direction:column;width:800px;height:500px";
    await vi.waitFor(() => expect(runtime.editor?.getText()).toBe(base.contents));
    return {
      screen,
      get pending() {
        return screen.container.querySelector("output")?.textContent === "Unsaved";
      },
      get disk() {
        return disk;
      },
      replace: () => act(() => replaceDisk(snapshot(incoming))),
      [Symbol.asyncDispose]: () => stack.disposeAsync(),
    };
  } catch (error) {
    await stack.disposeAsync();
    throw error;
  }
}

describe("incoming sync in an open plain-text editor", () => {
  it("keeps a clean folder flush and incoming replacement clean without writing it back", async () => {
    await using fixture = await setup();
    await act(async () => {
      expect(await workspaceFileSessionFlush.flushWhere(() => true)).toEqual([
        { target, saved: true },
      ]);
    });
    expect(runtime.write).not.toHaveBeenCalled();
    await fixture.replace();
    await vi.waitFor(() => expect(runtime.editor?.getText()).toBe(incoming.contents));
    const flushed = await act(() => workspaceFileSessionFlush.flushWhere(() => true));
    expect(fixture.screen.container.querySelector('[role="alert"]')).toBeNull();
    expect(fixture.pending).toBe(false);
    expect(flushed).toEqual([{ target, saved: true }]);
    expect(runtime.write).not.toHaveBeenCalled();
    expect(fixture.disk.contents).toBe(incoming.contents);
  });

  it("preserves real unsaved text and reports a conflicting incoming revision without overwriting it", async () => {
    await using fixture = await setup();
    await act(() =>
      runtime.editor!.applyEdits([
        {
          range: {
            start: { line: 0, character: 0 },
            end: { line: 0, character: base.contents.length },
          },
          newText: "my local draft",
        },
      ]),
    );
    expect(fixture.pending).toBe(true);
    await fixture.replace();
    await act(async () => {
      expect((await workspaceFileSessionFlush.flushWhere(() => true))[0]?.saved).toBe(false);
    });
    await vi.waitFor(() =>
      expect(fixture.screen.container.querySelector('[role="alert"]')).not.toBeNull(),
    );
    expect(runtime.editor!.getText()).toBe("my local draft");
    expect(fixture.pending).toBe(true);
    expect(fixture.disk.contents).toBe(incoming.contents);
  });

  it("keeps an edit followed by undo before React commits the editor projection", async () => {
    await using fixture = await setup();
    await act(() => {
      runtime.editor!.applyEdits([
        {
          range: {
            start: { line: 0, character: 0 },
            end: { line: 0, character: base.contents.length },
          },
          newText: "temporary local draft",
        },
      ]);
      runtime.editor!.undo();
    });
    expect(runtime.editor!.getText()).toBe(base.contents);
    await act(async () => {
      await workspaceFileSessionFlush.flushWhere(() => true);
    });
    expect(fixture.disk.contents).toBe(base.contents);
    expect(runtime.write).toHaveBeenCalledWith(
      expect.objectContaining({
        input: expect.objectContaining({
          contents: base.contents,
          expectedRevision: base.revision,
        }),
      }),
    );
  });
});

it.each(["md", "tex"])(
  "keeps a clean %s document session following disk after a folder flush",
  async (extension) => {
    EditStateManager.clearAll();
    runtime.editor = null;
    const documentTarget = { ...target, relativePath: `paper/remote.${extension}` };
    let disk = { source: base.contents, revision: base.revision };
    const write = vi.fn(async () => ({ revision: "unexpected" }));
    const registry = new MarkdownPersistenceRegistry({
      checkpointStore: createTestCheckpointStore(),
      createTransport: () => ({
        write,
        read: async () => disk,
        classifyFailure: () => "conflict",
        subscribe: () => () => {},
        project: () => {},
      }),
    });
    const lease = registry.acquire(documentTarget, {
      ...snapshot(base),
      relativePath: documentTarget.relativePath,
    })!;
    const stack = new AsyncDisposableStack();
    stack.defer(() => lease.release());
    await using _fixture = stack;
    const screen = stack.use(
      await render(
        <MarkdownSourceSurface {...surfaceProps} {...documentTarget} persistence={lease} />,
        { router: false },
      ),
    );
    screen.container.style.cssText = "display:flex;width:800px;height:500px";
    await vi.waitFor(() => expect(runtime.editor?.getText()).toBe(base.contents));
    const result = await flushFolderEditors(
      target.environmentId,
      {
        documents: registry,
        fileSessions: {
          flushWhere: async () => [],
          sessionTargets: () => [],
          unsavedWhere: () => [],
        },
        latexInputs: new LatexDocumentInputs(),
        compositions: new EditorCompositions(),
      },
      async () => [{ status: "inside", path: documentTarget.relativePath }],
    );
    expect(result.failures).toEqual([]);
    disk = { source: incoming.contents, revision: incoming.revision };
    await act(async () => {
      expect(await lease.refresh()).toBe(true);
    });
    await vi.waitFor(() => expect(runtime.editor?.getText()).toBe(incoming.contents));
    expect(lease.getSnapshot()).toMatchObject({
      pending: false,
      conflict: null,
      draftSource: incoming.contents,
    });
    expect(write).not.toHaveBeenCalled();
  },
);
