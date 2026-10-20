import { RegistryContext } from "@effect/atom-react";
import {
  type AssetCreateUrlResult,
  AuthFilesystemReadScope,
  EnvironmentId,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { AtomRegistry } from "effect/reactivity";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

const mint = vi.hoisted(() => vi.fn<() => Promise<AssetCreateUrlResult>>());
const access = vi.hoisted(() => ({ ready: true }));
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
  const family = Atom.family((_key: string) =>
    Atom.make(Effect.tryPromise(() => mint())).pipe(Atom.keepAlive),
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
  return {
    ...actual,
    environmentFileLinkResolution: Atom.family(
      (target: Parameters<typeof actual.environmentFileLinkResolution>[0]) =>
        Atom.make(Effect.succeed({ _tag: "literal" as const, path: target.input.path })),
    ),
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
  readPreparedConnection: (() => ({ httpBaseUrl: "https://host.test" })) as never,
  usePreparedConnection: (() => ({
    _tag: "Some",
    value: { httpBaseUrl: "https://host.test" },
  })) as never,
}));

import ChatMarkdown from "./ChatMarkdown";

const roots: Root[] = [];
let registry: AtomRegistry.AtomRegistry;

const imageUrl = (version: string) =>
  `data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>#${version}`;
const assetResult = (version: string): AssetCreateUrlResult => ({
  relativeUrl: imageUrl(version),
  expiresAt: 1,
});

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  registry = AtomRegistry.make();
  access.ready = true;
  mint.mockReset().mockResolvedValue(assetResult("updated"));
});
afterEach(async () => {
  for (const root of roots.splice(0)) await act(async () => root.unmount());
  registry.dispose();
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});

function createTestRoot() {
  const container = document.body.appendChild(document.createElement("div"));
  const root = createRoot(container);
  roots.push(root);
  return {
    container,
    render: (children: ReactNode) =>
      act(async () => {
        root.render(
          <RegistryContext.Provider value={registry}>{children}</RegistryContext.Provider>,
        );
      }),
  };
}

it("opens host media through server authorization before the client grant loads", async () => {
  access.ready = false;
  mint.mockResolvedValue({ relativeUrl: "/api/assets/image.png", expiresAt: 1 });
  const onImageExpand = vi.fn();
  const { container, render } = createTestRoot();
  await render(
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
  const link = container.querySelector<HTMLAnchorElement>('a[href="/tmp/image.png"]');
  expect(link).not.toBeNull();
  await act(async () => link!.click());
  await vi.waitFor(() =>
    expect(onImageExpand).toHaveBeenCalledWith(
      expect.objectContaining({
        images: [expect.objectContaining({ src: "https://host.test/api/assets/image.png" })],
      }),
    ),
  );
});

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

it.each(imageLayouts)(
  "unversioned %s images keep their cached URL across reopening",
  async (layout) => {
    const { container, render } = createTestRoot();
    await render(markdown(undefined, layout));
    expect(renderedImage(container)).toBe(imageUrl("updated"));
    mint.mockResolvedValue(assetResult("changed"));

    await render(markdown(undefined, layout));
    await render(null);
    await render(markdown(undefined, layout));

    expect(renderedImage(container)).toBe(imageUrl("updated"));
    expect(mint).toHaveBeenCalledTimes(1);
  },
);

it.each(imageLayouts.flatMap((layout) => ["URL", "failure"].map((cached) => ({ layout, cached }))))(
  "reopening a $layout image with no workspace mutation replaces its cached $cached",
  async ({ cached, layout }) => {
    if (cached === "failure") mint.mockRejectedValueOnce(new Error("Image missing"));
    else mint.mockResolvedValueOnce(assetResult("stale"));
    const { container, render } = createTestRoot();
    await render(markdown(null, layout));
    expect(renderedImage(container)).toBe(cached === "URL" ? imageUrl("stale") : undefined);
    await render(null);

    mint.mockResolvedValue(assetResult("updated"));
    await render(markdown(null, layout));

    expect(renderedImage(container)).toBe(imageUrl("updated"));
    expect(mint).toHaveBeenCalledTimes(2);
  },
);

it.each(
  imageLayouts.flatMap((layout) => ["initial", "refresh"].map((request) => ({ layout, request }))),
)(
  "shows the latest workspace edit for $layout images after a pending $request request",
  async ({ request, layout }) => {
    let resolvePending!: (value: AssetCreateUrlResult) => void;
    const pending = new Promise<AssetCreateUrlResult>((resolve) => {
      resolvePending = resolve;
    });
    const { container, render } = createTestRoot();
    if (request === "refresh") {
      await render(markdown("m0", layout));
      expect(renderedImage(container)).toBe(imageUrl("updated"));
    }

    mint.mockReturnValueOnce(pending).mockResolvedValue(assetResult("latest"));
    await render(markdown("m1", layout));
    const callsBeforeEdits = mint.mock.calls.length;
    await render(markdown("m2", layout));
    await render(markdown("m3", layout));
    expect(mint).toHaveBeenCalledTimes(callsBeforeEdits);

    await act(async () => {
      resolvePending(assetResult("before-edits"));
      await pending;
    });

    expect(renderedImage(container)).toBe(imageUrl("latest"));
    expect(mint).toHaveBeenCalledTimes(callsBeforeEdits + 1);
    await render(markdown("m3", layout));
    expect(mint).toHaveBeenCalledTimes(callsBeforeEdits + 1);
  },
);

it("replaces a decoded file image when its workspace revision changes", async () => {
  const { container, render } = createTestRoot();
  await render(markdown("m0", "file"));
  const image = container.querySelector<HTMLImageElement>('img[alt="Diagram"]')!;
  await act(() => image.dispatchEvent(new Event("load")));
  mint.mockResolvedValue(assetResult("latest"));

  await render(markdown("m1", "file"));

  expect(renderedImage(container)).toBe(imageUrl("latest"));
  expect(mint).toHaveBeenCalledTimes(2);
});
