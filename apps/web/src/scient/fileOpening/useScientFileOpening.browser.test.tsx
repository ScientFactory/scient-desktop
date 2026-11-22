import { RegistryContext } from "@effect/atom-react";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { AsyncResult, AtomRegistry } from "effect/reactivity";
import { expect, it, vi } from "vite-plus/test";

import { act, render } from "../../../test/render";
import { useScientFileOpening } from "./useScientFileOpening";

const state = vi.hoisted(() => ({
  mints: 0,
  openedUrls: [] as string[],
  opens: [] as Array<() => boolean>,
}));

vi.mock(import("~/browser/previewRuntime"), async (original) => ({
  ...(await original()),
  isPreviewAvailableFor: () => true,
}));
vi.mock(import("~/state/environments"), async (original) => ({
  ...(await original()),
  useEnvironmentHttpBaseUrl: () => "http://environment.test",
}));
vi.mock(import("~/state/assets"), async (original) => {
  const actual = await original();
  const { Atom } = await import("effect/reactivity");
  const Effect = await import("effect/Effect");
  // Like the real query family, a minted URL stays cached until the atom is refreshed.
  const createUrl = Atom.family((_key: string) =>
    Atom.make(
      Effect.sync(() => ({
        relativeUrl: `/api/assets/mint-${++state.mints}/report.html`,
        expiresAt: Number.MAX_SAFE_INTEGER,
      })),
    ).pipe(Atom.keepAlive),
  );
  return {
    ...actual,
    assetEnvironment: {
      ...actual.assetEnvironment,
      createUrl: ((target: { input: { resource: { path: string } } }) =>
        createUrl(target.input.resource.path)) as never,
    },
  };
});
vi.mock(import("~/browser/openFileInPreview"), async (original) => {
  const actual = await original();
  return {
    ...actual,
    openFileInPreview: (async (input: Parameters<typeof actual.openFileInPreview>[0]) => {
      if (input.isCurrent) state.opens.push(input.isCurrent);
      const result = await input.createAssetUrl({
        environmentId: input.threadRef.environmentId,
        input: {
          resource: {
            _tag: "media-file",
            threadId: input.threadRef.threadId,
            path: input.filePath,
          },
        },
      });
      if (result._tag === "Success") state.openedUrls.push(result.value.relativeUrl);
      return AsyncResult.success(undefined);
    }) as never,
  };
});

const threadRef = {
  environmentId: EnvironmentId.make("files-environment"),
  threadId: ThreadId.make("files-thread"),
};

function disposableRegistry() {
  const value = AtomRegistry.make();
  return { value, [Symbol.dispose]: () => value.dispose() };
}

function OpenFromFiles(props: { readonly onReady: (open: (path: string) => void) => void }) {
  props.onReady(
    useScientFileOpening({ threadRef, workspaceRoot: "/project", openSource: () => undefined }),
  );
  return null;
}

it("opens an HTML file from Files at a new URL each time, so an edited file is not served from cache", async () => {
  using registry = disposableRegistry();
  let open: ((path: string) => void) | undefined;
  await using _screen = await render(
    <RegistryContext.Provider value={registry.value}>
      <OpenFromFiles onReady={(next) => (open = next)} />
    </RegistryContext.Provider>,
  );

  await act(() => open!("site/report.html"));
  await vi.waitFor(() => expect(state.openedUrls).toHaveLength(1));
  await act(() => open!("site/report.html"));
  await vi.waitFor(() => expect(state.openedUrls).toHaveLength(2));

  expect(state.openedUrls[1], "the second open reused the first signed URL").not.toBe(
    state.openedUrls[0],
  );
});

it("lets only the latest open from Files take the preview", async () => {
  using registry = disposableRegistry();
  let open: ((path: string) => void) | undefined;
  await using _screen = await render(
    <RegistryContext.Provider value={registry.value}>
      <OpenFromFiles onReady={(next) => (open = next)} />
    </RegistryContext.Provider>,
  );
  state.opens.length = 0;

  await act(() => open!("site/a.html"));
  await act(() => open!("site/b.html"));
  await vi.waitFor(() => expect(state.opens).toHaveLength(2));

  // A slower first open must not focus its tab or fall back to source after the second.
  expect(state.opens[0]!()).toBe(false);
  expect(state.opens[1]!()).toBe(true);
});
