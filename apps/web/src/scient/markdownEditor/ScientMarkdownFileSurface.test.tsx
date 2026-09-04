// @vitest-environment happy-dom

import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { act, StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const mocks = vi.hoisted(() => ({
  anchoredAdd: vi.fn(),
  anchoredClose: vi.fn(),
  createAssetUrl: vi.fn(),
  copyText: vi.fn(),
  listDirectory: vi.fn(),
  openExternal: vi.fn(),
  setRecentWikiLinks: vi.fn(),
  toastAdd: vi.fn(),
  workspaceProps: null as Record<string, unknown> | null,
  writeFile: vi.fn(),
  listDirectoryCommand: Symbol("list-directory"),
  writeFileCommand: Symbol("write-file"),
}));

vi.mock("~/components/files/projectFilesQueryState", () => ({
  confirmProjectFileQueryData: vi.fn(),
  refreshProjectEntriesQuery: vi.fn(),
  setProjectFileQueryData: vi.fn(),
  useProjectEntriesQuery: () => ({
    data: { entries: [], truncated: false },
    error: null,
    isPending: false,
    refresh: vi.fn(),
  }),
}));
vi.mock("~/components/ui/toast", () => ({
  anchoredToastManager: { add: mocks.anchoredAdd, close: mocks.anchoredClose },
  toastManager: { add: mocks.toastAdd },
}));
vi.mock("~/hooks/useLocalStorage", () => ({
  useLocalStorage: () => [[], mocks.setRecentWikiLinks],
}));
vi.mock("~/hooks/useCopyToClipboard", () => ({
  writeTextToClipboard: mocks.copyText,
}));
vi.mock("~/localApi", () => ({
  readLocalApi: () => ({ shell: { openExternal: mocks.openExternal } }),
}));
vi.mock("~/state/assets", () => ({ assetEnvironment: { createUrl: Symbol("create-url") } }));
vi.mock("~/state/environments", () => ({ useEnvironmentHttpBaseUrl: () => null }));
vi.mock("~/state/projects", () => ({
  projectEnvironment: {
    listDirectory: mocks.listDirectoryCommand,
    writeFile: mocks.writeFileCommand,
  },
}));
vi.mock("~/state/use-atom-command", () => ({
  useAtomCommand: (command: symbol) =>
    command === mocks.listDirectoryCommand ? mocks.listDirectory : mocks.writeFile,
}));
vi.mock("~/state/use-atom-query-runner", () => ({
  useAtomQueryRunner: () => mocks.createAssetUrl,
}));
vi.mock("./ScientMarkdownWorkspaceSurface", () => ({
  ScientMarkdownWorkspaceSurface: (props: Record<string, unknown>) => {
    mocks.workspaceProps = props;
    return null;
  },
}));
vi.mock("./assets/client", () => ({ uploadMarkdownImage: vi.fn() }));

import { ScientMarkdownFileSurface } from "./ScientMarkdownFileSurface";

const environmentId = EnvironmentId.make("environment-1");
const threadRef = {
  environmentId,
  threadId: ThreadId.make("thread-1"),
};

function deferred<A>() {
  let resolve!: (value: A) => void;
  const promise = new Promise<A>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

interface LinkCopyRequest {
  readonly format: "link" | "full-path";
  readonly value: string;
}

function success(
  ...entries: ReadonlyArray<{
    readonly kind: "file" | "directory" | "symlink";
    readonly name: string;
    readonly relativePath: string;
  }>
) {
  return {
    _tag: "Success" as const,
    value: {
      complete: true,
      entries: entries.map((entry) => ({ ...entry, readOnly: entry.kind === "symlink" })),
    },
  };
}

describe("ScientMarkdownFileSurface link navigation", () => {
  const roots: ReturnType<typeof createRoot>[] = [];

  beforeEach(() => {
    let toast = 0;
    mocks.anchoredAdd.mockReset().mockImplementation(() => `link-toast-${++toast}`);
    mocks.anchoredClose.mockReset();
    mocks.createAssetUrl.mockReset();
    mocks.copyText.mockReset().mockResolvedValue(true);
    mocks.listDirectory.mockReset();
    mocks.openExternal.mockReset().mockResolvedValue(undefined);
    mocks.setRecentWikiLinks.mockReset();
    mocks.toastAdd.mockReset();
    mocks.workspaceProps = null;
    mocks.writeFile.mockReset();
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  });

  afterEach(async () => {
    while (roots.length > 0) {
      const root = roots.pop();
      if (root) await act(() => root.unmount());
    }
    document.body.replaceChildren();
    vi.unstubAllGlobals();
  });

  async function mount(relativePath = "notes/current.md") {
    const onOpenFile = vi.fn();
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    roots.push(root);
    await act(() =>
      root.render(
        <StrictMode>
          <ScientMarkdownFileSurface
            environmentId={environmentId}
            cwd="/workspace"
            relativePath={relativePath}
            threadRef={threadRef}
            contents="Body"
            revision="r0"
            resolvedTheme="light"
            authoritativeSnapshot={{ source: "Body", revision: "r0" }}
            onOpenFile={onOpenFile}
            onPendingChange={vi.fn()}
            onSaveConfirmed={vi.fn()}
            onSaveFailure={vi.fn()}
            onExternalConflict={vi.fn()}
          />
        </StrictMode>,
      ),
    );
    return { host, onOpenFile, root };
  }

  function attachedAnchor(): HTMLAnchorElement {
    const anchor = document.createElement("a");
    document.body.append(anchor);
    return anchor;
  }

  function openLink(target: string, anchor: HTMLElement): void {
    const callback = mocks.workspaceProps?.onOpenLink as
      | ((target: string, anchor: HTMLElement) => void)
      | undefined;
    expect(callback).toBeTypeOf("function");
    callback?.(target, anchor);
  }

  function openWikiLink(target: string, anchor: HTMLElement): void {
    const callback = mocks.workspaceProps?.onOpenWikiLink as
      | ((target: string, anchor: HTMLElement) => void)
      | undefined;
    expect(callback).toBeTypeOf("function");
    callback?.(target, anchor);
  }

  function localHeadingOpened(): void {
    const callback = mocks.workspaceProps?.onLocalHeadingOpened as (() => void) | undefined;
    expect(callback).toBeTypeOf("function");
    callback?.();
  }

  function resolveLinkFullPath(kind: "link" | "wiki-link", target: string): string | null {
    const callback = mocks.workspaceProps?.resolveLinkFullPath as
      | ((kind: "link" | "wiki-link", target: string) => string | null)
      | undefined;
    expect(callback).toBeTypeOf("function");
    return callback?.(kind, target) ?? null;
  }

  function copyLink(request: LinkCopyRequest, anchor: HTMLElement): void {
    const callback = mocks.workspaceProps?.onCopyLink as
      | ((request: LinkCopyRequest, anchor: HTMLElement) => void)
      | undefined;
    expect(callback).toBeTypeOf("function");
    callback?.(request, anchor);
  }

  it("opens an exactly verified workspace file and preserves binary and symlink targets", async () => {
    const { onOpenFile } = await mount();
    const anchor = attachedAnchor();
    mocks.listDirectory
      .mockResolvedValueOnce(
        success({ kind: "file", name: "guide.pdf", relativePath: "guide.pdf" }),
      )
      .mockResolvedValueOnce(
        success({
          kind: "symlink",
          name: "Protocol.md",
          relativePath: "notes/Methods/Protocol.md",
        }),
      );

    openLink("../guide.pdf#page=2", anchor);
    await vi.waitFor(() => expect(onOpenFile).toHaveBeenCalledWith("guide.pdf"));
    expect(mocks.listDirectory).toHaveBeenNthCalledWith(1, {
      environmentId,
      input: { cwd: "/workspace", relativeDirectory: "", view: "with-internals" },
    });

    openWikiLink("Methods/Protocol#setup", anchor);
    await vi.waitFor(() =>
      expect(onOpenFile).toHaveBeenLastCalledWith("notes/Methods/Protocol.md"),
    );
    expect(mocks.listDirectory).toHaveBeenNthCalledWith(2, {
      environmentId,
      input: {
        cwd: "/workspace",
        relativeDirectory: "notes/Methods",
        view: "with-internals",
      },
    });
    expect(mocks.anchoredAdd).not.toHaveBeenCalled();
  });

  it("keeps the current file and anchors compact feedback for missing and malformed links", async () => {
    const { onOpenFile } = await mount();
    const anchor = attachedAnchor();
    mocks.listDirectory.mockResolvedValue(success());

    openWikiLink("Missing note", anchor);
    await vi.waitFor(() =>
      expect(mocks.anchoredAdd).toHaveBeenCalledWith({
        data: { tooltipStyle: true },
        positionerProps: { anchor, side: "top" },
        timeout: 1_800,
        title: "Linked file isn't available.",
      }),
    );
    expect(onOpenFile).not.toHaveBeenCalled();

    openLink("/outside.md", anchor);
    expect(mocks.anchoredClose).toHaveBeenCalledWith("link-toast-1");
    expect(mocks.anchoredAdd).toHaveBeenLastCalledWith(
      expect.objectContaining({
        positionerProps: { anchor, side: "top" },
        title: "This link isn't available.",
      }),
    );
    expect(mocks.listDirectory).toHaveBeenCalledOnce();
  });

  it("reports a missing local heading without checking or opening a directory", async () => {
    const { onOpenFile } = await mount();
    const anchor = attachedAnchor();

    openLink("#missing-section", anchor);

    expect(mocks.anchoredAdd).toHaveBeenCalledWith(
      expect.objectContaining({
        positionerProps: { anchor, side: "top" },
        title: "Linked section wasn't found.",
      }),
    );
    expect(mocks.listDirectory).not.toHaveBeenCalled();
    expect(onOpenFile).not.toHaveBeenCalled();
  });

  it("distinguishes an unavailable target from a failed availability check", async () => {
    const { onOpenFile } = await mount();
    const anchor = attachedAnchor();
    mocks.listDirectory.mockResolvedValue({
      _tag: "Failure",
      cause: new Error("connection unavailable"),
    });

    openLink("other.md", anchor);

    await vi.waitFor(() =>
      expect(mocks.anchoredAdd).toHaveBeenCalledWith(
        expect.objectContaining({
          positionerProps: { anchor, side: "top" },
          title: "Couldn't check this link.",
        }),
      ),
    );
    expect(onOpenFile).not.toHaveBeenCalled();
  });

  it("ignores a late check after unmount instead of opening or orphaning feedback", async () => {
    const pending = deferred<ReturnType<typeof success>>();
    mocks.listDirectory.mockReturnValue(pending.promise);
    const { onOpenFile, root } = await mount();
    const anchor = attachedAnchor();

    openLink("other.md", anchor);
    await act(() => root.unmount());
    roots.splice(roots.indexOf(root), 1);
    pending.resolve(success());
    await pending.promise;
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(onOpenFile).not.toHaveBeenCalled();
    expect(mocks.anchoredAdd).not.toHaveBeenCalled();
  });

  it("keeps only the latest overlapping navigation request", async () => {
    const first = deferred<ReturnType<typeof success>>();
    const second = deferred<ReturnType<typeof success>>();
    mocks.listDirectory.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const { onOpenFile } = await mount();
    const firstAnchor = attachedAnchor();
    const secondAnchor = attachedAnchor();

    openLink("first.md", firstAnchor);
    openLink("second.md", secondAnchor);
    second.resolve(success({ kind: "file", name: "second.md", relativePath: "notes/second.md" }));
    await vi.waitFor(() => expect(onOpenFile).toHaveBeenCalledExactlyOnceWith("notes/second.md"));
    first.resolve(success());
    await first.promise;
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(onOpenFile).toHaveBeenCalledOnce();
    expect(mocks.anchoredAdd).not.toHaveBeenCalled();
  });

  it("cancels a pending file open when a same-document heading opens", async () => {
    const pending = deferred<ReturnType<typeof success>>();
    mocks.listDirectory.mockReturnValue(pending.promise);
    const { onOpenFile } = await mount();
    const anchor = attachedAnchor();

    openLink("other.md", anchor);
    localHeadingOpened();
    pending.resolve(success({ kind: "file", name: "other.md", relativePath: "notes/other.md" }));
    await pending.promise;
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(onOpenFile).not.toHaveBeenCalled();
    expect(mocks.anchoredAdd).not.toHaveBeenCalled();
  });

  it("leaves established external-link handling unchanged", async () => {
    const { onOpenFile } = await mount();
    const anchor = attachedAnchor();

    openLink("https://example.com/reference", anchor);

    await vi.waitFor(() =>
      expect(mocks.openExternal).toHaveBeenCalledExactlyOnceWith("https://example.com/reference"),
    );
    expect(mocks.listDirectory).not.toHaveBeenCalled();
    expect(onOpenFile).not.toHaveBeenCalled();
    expect(mocks.anchoredAdd).not.toHaveBeenCalled();
  });

  it("copies authored destinations and resolves full workspace paths without opening files", async () => {
    const { onOpenFile } = await mount();
    const anchor = attachedAnchor();

    expect(resolveLinkFullPath("link", "../guide.pdf#page=2")).toBe("/workspace/guide.pdf");
    expect(resolveLinkFullPath("wiki-link", "Methods/Protocol#setup")).toBe(
      "/workspace/notes/Methods/Protocol.md",
    );
    expect(resolveLinkFullPath("link", "#local-heading")).toBe("/workspace/notes/current.md");
    expect(resolveLinkFullPath("link", "https://example.com/reference")).toBeNull();

    copyLink({ format: "link", value: "Methods/Protocol#setup" }, anchor);
    await vi.waitFor(() =>
      expect(mocks.copyText).toHaveBeenCalledExactlyOnceWith("Methods/Protocol#setup", "link"),
    );
    expect(mocks.anchoredAdd).toHaveBeenLastCalledWith(
      expect.objectContaining({
        positionerProps: { anchor, side: "top" },
        title: "Link copied.",
      }),
    );

    copyLink(
      {
        format: "full-path",
        value: "/workspace/notes/Methods/Protocol.md",
      },
      anchor,
    );
    await vi.waitFor(() => expect(mocks.copyText).toHaveBeenCalledTimes(2));
    expect(mocks.copyText).toHaveBeenLastCalledWith(
      "/workspace/notes/Methods/Protocol.md",
      "full path",
    );
    expect(mocks.anchoredAdd).toHaveBeenLastCalledWith(
      expect.objectContaining({ title: "Full path copied." }),
    );
    expect(mocks.listDirectory).not.toHaveBeenCalled();
    expect(onOpenFile).not.toHaveBeenCalled();
  });

  it("anchors a compact failure when the clipboard cannot copy an internal path", async () => {
    await mount();
    const anchor = attachedAnchor();
    mocks.copyText.mockRejectedValueOnce(new Error("clipboard unavailable"));

    copyLink(
      {
        format: "full-path",
        value: "/workspace/notes/current.md",
      },
      anchor,
    );

    await vi.waitFor(() =>
      expect(mocks.anchoredAdd).toHaveBeenCalledWith(
        expect.objectContaining({
          positionerProps: { anchor, side: "top" },
          title: "Couldn't copy the full path.",
        }),
      ),
    );
  });
});
