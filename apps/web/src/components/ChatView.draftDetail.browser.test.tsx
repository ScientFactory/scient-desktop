import { createMemoryHistory } from "@tanstack/react-router";
import { ThreadId } from "@t3tools/contracts";
import { DEFAULT_CLIENT_SETTINGS } from "@t3tools/contracts/settings";
import type * as Context from "effect/Context";
import { expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

import { AppRoot } from "~/AppRoot";
// The route loads ChatView lazily, and its first transform (React Compiler over ~4k lines)
// takes 6-11s; importing it here keeps that out of the test's timeout.
import "~/components/ChatView";
import { DraftId, useComposerDraftStore } from "~/composerDraftStore";
import { __setClientSettingsForTests } from "~/hooks/useSettings";
import { getRouter } from "~/router";
import {
  ENVIRONMENT_ID,
  PROJECT_ID,
  installFakeEnvironment,
  requestedThreadSubscriptions,
  threadWithHistory,
  type FakeDriver,
} from "../../test/fakeEnvironment";
import { act, render } from "../../test/render";

// The socket is the only fake layer; see test/appScenarios.renders.tsx.
vi.mock("../../../../packages/client-runtime/src/connection/driver.ts", async (importOriginal) => {
  const [actual, { fakeDriver }, Layer] = await Promise.all([
    importOriginal<{ readonly ConnectionDriver: Context.Key<unknown, FakeDriver> }>(),
    import("../../test/fakeEnvironment"),
    import("effect/Layer"),
  ]);
  return { ...actual, layer: Layer.succeed(actual.ConnectionDriver, fakeDriver) };
});

vi.mock(import("~/rpc/requestLatencyState"), async (original) => ({
  ...(await original()),
  trackRpcRequestSent: () => {},
}));

// A load of a draft's reserved thread before the server creates it answers 404, which reads as
// deleted and leaves the thread unloaded until a retry up to 30 seconds later.
it("an open new-thread draft does not load its reserved thread before the server lists it", async () => {
  const existing = threadWithHistory("thread-existing", 1);
  using _environment = installFakeEnvironment([existing]);
  const fetched: string[] = [];
  const fakeFetch = globalThis.fetch;
  globalThis.fetch = (input, init) => {
    fetched.push(
      new URL(input instanceof Request ? input.url : String(input), location.href).pathname,
    );
    return fakeFetch(input, init);
  };
  using _restoreFetch = { [Symbol.dispose]: () => (globalThis.fetch = fakeFetch) };
  __setClientSettingsForTests({
    ...DEFAULT_CLIENT_SETTINGS,
    onboardingCompletedAt: "2026-01-01T00:00:00.000Z",
  });
  const draftId = DraftId.make("draft-reserved");
  const reservedThreadId = ThreadId.make("thread-reserved");
  const drafts = useComposerDraftStore.getState();
  using _restoreDrafts = {
    [Symbol.dispose]: () => useComposerDraftStore.setState(drafts, true),
  };
  drafts.setProjectDraftThreadId(
    { environmentId: ENVIRONMENT_ID, projectId: PROJECT_ID },
    draftId,
    {
      threadId: reservedThreadId,
    },
  );
  // Open a listed thread first, so the shell has the project before the draft route mounts.
  const router = getRouter(
    createMemoryHistory({ initialEntries: [`/${ENVIRONMENT_ID}/${existing.id}`] }),
  );
  await router.load();
  await using _app = await render(<AppRoot router={router} />, {
    // AppRoot brings its own router.
    router: false,
  });
  await expect.element(page.getByText("Answer 0 for thread-existing.")).toBeVisible();
  await act(() => router.navigate({ to: "/draft/$draftId", params: { draftId } }));
  await vi.waitFor(() => expect(router.state.location.pathname).toBe(`/draft/${draftId}`));
  await expect.element(page.getByTestId("composer-editor")).toBeVisible();

  // Any load starts as the composer mounts; give a stray one time to reach the transport.
  const settled = Promise.withResolvers<void>();
  setTimeout(settled.resolve, 500);
  await settled.promise;
  expect(requestedThreadSubscriptions()).not.toContain(reservedThreadId);
  expect(fetched.filter((path) => path.includes(`/threads/${reservedThreadId}`))).toEqual([]);
});
