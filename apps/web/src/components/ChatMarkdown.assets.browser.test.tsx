import { PrimaryConnectionTarget } from "@t3tools/client-runtime/connection";
import { RegistryContext } from "@effect/atom-react";
import {
  AuthFilesystemReadScope,
  AssetAccessError,
  AssetWorkspaceAssetNotFoundError,
  AssetPreviewTypeValidationError,
  type AssetCreateUrlResult,
  EnvironmentId,
  EnvironmentFilePath,
  type EnvironmentFileLinkResolution,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Cause from "effect/Cause";
import * as Schema from "effect/Schema";
import { AtomRegistry } from "effect/reactivity";
import type { ReactNode } from "react";
import { expect, it, vi } from "vite-plus/test";

import { act, render } from "../../test/render";

const mint = vi.hoisted(() => vi.fn<() => Promise<AssetCreateUrlResult>>());
const fileResolution = vi.hoisted(() =>
  vi.fn<
    (target: {
      environmentId: EnvironmentId;
      input: { path: EnvironmentFilePath };
    }) => EnvironmentFileLinkResolution
  >(),
);
const fileResolutionRequest = vi.hoisted(() => vi.fn());
const access = vi.hoisted(() => ({ ready: true }));
const remoteOpen = vi.hoisted(() => ({
  state: { mode: "local-exec" as "local-exec" | "remote-unavailable" },
  isResolved: true,
  label: "media-host",
  httpBaseUrl: "https://host.test",
}));
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
// Keep the real query runner and registry: refreshes during waiting requests are skipped.
vi.mock(import("../state/assets"), async (original) => {
  const actual = await original();
  const { Atom } = await import("effect/reactivity");
  const isAssetError = Schema.is(AssetAccessError);
  const family = Atom.family((_key: string) =>
    Atom.make(
      Effect.tryPromise({
        try: () => mint(),
        catch: (error) => (isAssetError(error) ? error : new Cause.UnknownError(error)),
      }),
    ).pipe(Atom.keepAlive),
  );
  return {
    ...actual,
    assetEnvironment: {
      ...actual.assetEnvironment,
      createUrl: (target) => family(JSON.stringify(target)),
    },
  };
});
vi.mock(import("../scient/fileOpening/environmentFileState"), async (original) => {
  const actual = await original();
  const { Atom } = await import("effect/reactivity");
  const family = Atom.family((target: Parameters<typeof actual.environmentFileLinkResolution>[0]) =>
    Atom.make(Effect.sync(() => fileResolution(target))),
  );
  return {
    ...actual,
    environmentFileLinkResolution: (
      target: Parameters<typeof actual.environmentFileLinkResolution>[0],
    ) => {
      fileResolutionRequest(target);
      return family(target);
    },
  };
});
vi.mock(import("../state/filesystem"), async (original) => ({
  ...(await original()),
  useFilesystemReadAccess: () => ({
    canReadFiles: access.ready,
    isPending: !access.ready,
    error: null,
  }),
}));
vi.mock(import("../state/session"), async (original) => ({
  ...(await original()),
  readEnvironmentScope: (_id, scope) => access.ready && scope === AuthFilesystemReadScope,
  useEnvironmentScope: (_id, scope) => access.ready && scope === AuthFilesystemReadScope,
  readPreparedConnection: (() => ({
    httpBaseUrl: "https://host.test",
    target: remoteOpen.isResolved
      ? new PrimaryConnectionTarget({
          environmentId: EnvironmentId.make("media-environment"),
          label: remoteOpen.label,
          httpBaseUrl: remoteOpen.httpBaseUrl,
          wsBaseUrl: "wss://host.test",
        })
      : undefined,
  })) as never,
  usePreparedConnection: (() => ({
    _tag: "Some",
    value: { httpBaseUrl: "https://host.test" },
  })) as never,
}));

vi.mock(import("../remoteOpen"), async (original) => ({
  ...(await original()),
  useRemoteOpenResolution: () => remoteOpen,
}));

import ChatMarkdown from "./ChatMarkdown";
import { toastManager } from "./ui/toast";
import { assetEnvironment } from "../state/assets";
import { useRightPanelStore } from "../rightPanelStore";

const imageUrl = (version: string) =>
  `data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>#${version}`;
const assetResult = (version: string): AssetCreateUrlResult => ({
  relativeUrl: imageUrl(version),
  expiresAt: 1,
});

function setup() {
  access.ready = true;
  fileResolutionRequest.mockReset();
  fileResolution.mockReset().mockImplementation((target) => ({
    _tag: "literal",
    path: target.input.path,
  }));
  mint.mockReset().mockResolvedValue(assetResult("updated"));
  remoteOpen.isResolved = true;
  remoteOpen.state.mode = "local-exec";
  remoteOpen.label = "media-host";
  remoteOpen.httpBaseUrl = "https://host.test";
  const registry = AtomRegistry.make();
  return { registry, [Symbol.dispose]: () => registry.dispose() };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function renderInRegistry(registry: AtomRegistry.AtomRegistry, ui: ReactNode) {
  const wrap = (node: ReactNode) => (
    <RegistryContext.Provider value={registry}>{node}</RegistryContext.Provider>
  );
  const screen = await render(wrap(ui));
  return Object.assign(screen, { update: (node: ReactNode) => screen.rerender(wrap(node)) });
}

it("opens host media through server authorization before the client grant loads", async () => {
  using env = setup();
  access.ready = false;
  mint.mockResolvedValue({ relativeUrl: "/api/assets/image.png", expiresAt: 1 });
  const expanded = deferred<unknown>();
  const onImageExpand = vi.fn(expanded.resolve);
  await using screen = await renderInRegistry(
    env.registry,
    <ChatMarkdown
      cwd="/repo"
      threadRef={{
        environmentId: EnvironmentId.make("media-environment"),
        threadId: ThreadId.make("media-thread"),
      }}
      text="[Open image](/tmp/image.png)"
      onImageExpand={onImageExpand}
    />,
  );
  const link = screen.container.querySelector<HTMLAnchorElement>('a[href="/tmp/image.png"]');
  expect(link).not.toBeNull();
  await act(async () => link!.click());
  expect(await expanded.promise).toMatchObject({
    images: [expect.objectContaining({ src: "https://host.test/api/assets/image.png" })],
  });
});

const threadRef = {
  environmentId: EnvironmentId.make("media-environment"),
  threadId: ThreadId.make("media-thread"),
};

it.each([
  {
    name: "a remote lookup whose host resolves while it is pending",
    checkedPath: "/home/remote/Downloads/image.png",
    description: "The file was not found on settled-host at /home/remote/Downloads/image.png.",
  },
  {
    name: "an older remote server without a checked path",
    description: "The file was not found on settled-host at ~/Downloads/image.png.",
  },
  {
    name: "a missing file on this device",
    local: true,
    checkedPath: "/home/local/Downloads/image.png",
    description: "Media file was not found.",
  },
  {
    name: "a different remote failure",
    unsupported: true,
    description: "Only images, videos, audio, HTML, and PDF files can be previewed.",
  },
])("reports the media failure for $name", async (scenario) => {
  using env = setup();
  const lookup = deferred<AssetCreateUrlResult>();
  const started = deferred<void>();
  const reported = deferred<Parameters<typeof toastManager.add>[0]>();
  mint.mockImplementation(() => {
    started.resolve();
    return lookup.promise;
  });
  using _toast = vi.spyOn(toastManager, "add").mockImplementation((toast) => {
    reported.resolve(toast);
    return "media-toast";
  });
  remoteOpen.isResolved = false;
  const content = (
    <ChatMarkdown cwd="/repo" threadRef={threadRef} text="[Open image](~/Downloads/image.png)" />
  );
  await using screen = await renderInRegistry(env.registry, content);
  const link = screen.container.querySelector<HTMLAnchorElement>('a[href="~/Downloads/image.png"]');
  expect(link).not.toBeNull();
  await act(async () => {
    link!.click();
    await started.promise;
  });

  remoteOpen.isResolved = true;
  remoteOpen.state.mode = scenario.local ? "local-exec" : "remote-unavailable";
  remoteOpen.httpBaseUrl = scenario.local ? "http://localhost:3773" : "https://host.test";
  remoteOpen.label = "settled-host";
  await screen.update(content);
  const resource = {
    _tag: "media-file" as const,
    path: "~/Downloads/image.png",
    threadId: threadRef.threadId,
  };
  await act(async () => {
    lookup.reject(
      scenario.unsupported
        ? new AssetPreviewTypeValidationError({ resource })
        : new AssetWorkspaceAssetNotFoundError({
            resource,
            ...(scenario.checkedPath ? { checkedPath: scenario.checkedPath } : {}),
          }),
    );
    await reported.promise;
  });
  expect(await reported.promise).toMatchObject({
    title: "Media unavailable",
    description: scenario.description,
  });
});

const imageLayouts = ["standalone", "inline", "file"] as const;
type ImageLayout = (typeof imageLayouts)[number];

function markdown(workspaceMutationId?: string | null, layout: ImageLayout = "standalone") {
  return (
    <ChatMarkdown
      cwd="/repo"
      imageBaseDir="/repo"
      threadRef={threadRef}
      text={
        layout === "inline" ? "Before ![Diagram](diagram.svg) after." : "![Diagram](diagram.svg)"
      }
      imageCaptions={layout === "file"}
      workspaceMutationId={workspaceMutationId}
    />
  );
}

function renderedImage(container: HTMLElement) {
  return container.querySelector<HTMLImageElement>('img[alt="Diagram"]')?.getAttribute("src");
}

it.each(imageLayouts)(
  "unversioned %s images keep their cached URL across reopening",
  async (layout) => {
    using env = setup();
    await using screen = await renderInRegistry(env.registry, markdown(undefined, layout));
    expect(renderedImage(screen.container)).toBe(imageUrl("updated"));
    mint.mockResolvedValue(assetResult("changed"));

    await screen.update(markdown(undefined, layout));
    await screen.update(null);
    await screen.update(markdown(undefined, layout));

    expect(renderedImage(screen.container)).toBe(imageUrl("updated"));
    expect(mint).toHaveBeenCalledTimes(1);
  },
);

it.each(imageLayouts.flatMap((layout) => ["URL", "failure"].map((cached) => ({ layout, cached }))))(
  "reopening a $layout image with no workspace mutation replaces its cached $cached",
  async ({ cached, layout }) => {
    using env = setup();
    if (cached === "failure") mint.mockRejectedValueOnce(new Error("Image missing"));
    else mint.mockResolvedValueOnce(assetResult("stale"));
    await using screen = await renderInRegistry(env.registry, markdown(null, layout));
    expect(renderedImage(screen.container)).toBe(cached === "URL" ? imageUrl("stale") : undefined);
    await screen.update(null);

    mint.mockResolvedValue(assetResult("updated"));
    await screen.update(markdown(null, layout));

    expect(renderedImage(screen.container)).toBe(imageUrl("updated"));
    expect(mint).toHaveBeenCalledTimes(2);
  },
);

it.each(
  imageLayouts.flatMap((layout) => ["initial", "refresh"].map((request) => ({ layout, request }))),
)(
  "shows the latest workspace edit for $layout images after a pending $request request",
  async ({ request, layout }) => {
    using env = setup();
    let resolvePending!: (value: AssetCreateUrlResult) => void;
    const pending = new Promise<AssetCreateUrlResult>((resolve) => {
      resolvePending = resolve;
    });
    await using screen = await renderInRegistry(env.registry, null);
    if (request === "refresh") {
      await screen.update(markdown("m0", layout));
      expect(renderedImage(screen.container)).toBe(imageUrl("updated"));
    }

    mint.mockReturnValueOnce(pending).mockResolvedValue(assetResult("latest"));
    await screen.update(markdown("m1", layout));
    const callsBeforeEdits = mint.mock.calls.length;
    await screen.update(markdown("m2", layout));
    await screen.update(markdown("m3", layout));
    expect(mint).toHaveBeenCalledTimes(callsBeforeEdits);

    await act(async () => {
      resolvePending(assetResult("before-edits"));
      await pending;
    });

    expect(renderedImage(screen.container)).toBe(imageUrl("latest"));
    expect(mint).toHaveBeenCalledTimes(callsBeforeEdits + 1);
    await screen.update(markdown("m3", layout));
    expect(mint).toHaveBeenCalledTimes(callsBeforeEdits + 1);
  },
);

it("replaces a decoded file image when its workspace revision changes", async () => {
  using env = setup();
  await using screen = await renderInRegistry(env.registry, markdown("m0", "file"));
  const { container } = screen;
  const image = container.querySelector<HTMLImageElement>('img[alt="Diagram"]')!;
  await act(() => image.dispatchEvent(new Event("load")));
  mint.mockResolvedValue(assetResult("latest"));

  await screen.update(markdown("m1", "file"));

  expect(renderedImage(screen.container)).toBe(imageUrl("latest"));
  expect(mint).toHaveBeenCalledTimes(2);
});

it.each([
  {
    name: "home media on its actual host",
    answer: { _tag: "literal", path: EnvironmentFilePath.make("/home/host/Downloads/image.png") },
    panelPath: null,
    mediaPath: "/home/host/Downloads/image.png",
  },
  {
    name: "home media inside the workspace",
    answer: { _tag: "literal", path: EnvironmentFilePath.make("/repo/Downloads/image.png") },
    panelPath: "Downloads/image.png",
    mediaPath: null,
  },
  {
    name: "a recovered media file",
    answer: {
      _tag: "recovered",
      path: EnvironmentFilePath.make("moved/image.png"),
      missingPath: EnvironmentFilePath.make("/home/host/Downloads/image.png"),
    },
    panelPath: "moved/image.png",
    mediaPath: null,
  },
  {
    name: "a missing media file",
    answer: {
      _tag: "none",
      missingPath: EnvironmentFilePath.make("/home/host/Downloads/image.png"),
    },
    panelPath: "/home/host/Downloads/image.png",
    mediaPath: null,
  },
] satisfies Array<{
  name: string;
  answer: EnvironmentFileLinkResolution;
  panelPath: string | null;
  mediaPath: string | null;
}>)("routes $name without client-home authority or the wrong viewer", async (scenario) => {
  using env = setup();
  const previousPanel = useRightPanelStore.getState();
  using _panel = {
    [Symbol.dispose]: () => useRightPanelStore.setState(previousPanel, true),
  };
  fileResolution.mockReturnValue(scenario.answer);
  using requests = vi.spyOn(assetEnvironment, "createUrl");
  const finished = deferred<void>();
  const originalOpen = useRightPanelStore.getState().openFile;
  using opened = vi
    .spyOn(useRightPanelStore.getState(), "openFile")
    .mockImplementation((...args) => {
      originalOpen(...args);
      finished.resolve();
    });
  const expanded = vi.fn(() => finished.resolve());
  await using screen = await renderInRegistry(
    env.registry,
    <ChatMarkdown
      cwd="/repo"
      threadRef={threadRef}
      text="[Open image](~/Downloads/image.png)"
      onImageExpand={expanded}
    />,
  );
  await act(async () => {
    screen.container.querySelector<HTMLAnchorElement>('a[href="~/Downloads/image.png"]')!.click();
    await finished.promise;
  });

  expect(fileResolutionRequest).toHaveBeenCalledExactlyOnceWith({
    environmentId: threadRef.environmentId,
    input: { workspaceRoot: "/repo", path: "~/Downloads/image.png", changedPaths: [] },
  });
  if (scenario.mediaPath) {
    expect(opened).not.toHaveBeenCalled();
    expect(expanded).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        images: [expect.objectContaining({ src: imageUrl("updated") })],
      }),
    );
    expect(requests).toHaveBeenCalledWith({
      environmentId: threadRef.environmentId,
      input: {
        resource: { _tag: "media-file", path: scenario.mediaPath, threadId: threadRef.threadId },
      },
    });
    expect(mint).toHaveBeenCalledOnce();
  } else {
    expect(opened).toHaveBeenCalledExactlyOnceWith(threadRef, scenario.panelPath);
    expect(expanded).not.toHaveBeenCalled();
    expect(mint).not.toHaveBeenCalled();
  }
});
