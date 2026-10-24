import { PrimaryConnectionTarget } from "@t3tools/client-runtime/connection";
import { RegistryContext } from "@effect/atom-react";
import {
  AuthFilesystemReadScope,
  AssetAccessError,
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

const threadRef = {
  environmentId: EnvironmentId.make("media-environment"),
  threadId: ThreadId.make("media-thread"),
};

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

// regression: 479dfd46d1 fix(upstream): compose workspace image refresh with Scient cards
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

// regression: 479dfd46d1 fix(upstream): compose workspace image refresh with Scient cards
// Each layout renders through its own component and both cached outcomes share one policy,
// so every layout and every outcome keeps one row.
it.each([
  { layout: "standalone", cached: "URL" },
  { layout: "inline", cached: "failure" },
  { layout: "file", cached: "URL" },
] as const)(
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

// regression: 479dfd46d1 fix(upstream): compose workspace image refresh with Scient cards
it.each([
  { layout: "standalone", request: "initial" },
  { layout: "inline", request: "refresh" },
  { layout: "file", request: "refresh" },
] as const)(
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
