import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  EnvironmentId,
  PreviewTabId,
  ThreadId,
  type PreviewSessionSnapshot,
} from "@t3tools/contracts";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
  useParams,
} from "@tanstack/react-router";
import { useLayoutEffect, useSyncExternalStore } from "react";
import { expect, it, vi } from "vite-plus/test";

import { act, fakeTimers, render } from "../../../test/render";
import { useActiveThreadRef } from "../../hooks/useActiveThreadRef";
import { usePreviewMiniPlayerStore } from "../../previewMiniPlayerStore";
import {
  beginPreviewSessionClose,
  reconcilePreviewServerSessions,
  resetPreviewStateForTests,
} from "../../previewStateStore";
import { useRightPanelStore } from "../../rightPanelStore";
import {
  useChatSurfaceDepartureGuards,
  type ChatSurfaceDepartureGuards,
} from "../../scient/fileSurfaces/useChatSurfaceSaveGuards";
import { createTestCheckpointStore } from "../../scient/markdownEditor/persistence/markdownDraftCheckpointTestkit";
import { MarkdownPersistenceRegistry } from "../../scient/markdownEditor/persistence/markdownPersistenceRegistry";
import type { MarkdownPersistenceTransport } from "../../scient/markdownEditor/persistence/markdownPersistenceTransport";
import { createMarkdownPersistenceGuards } from "../../scient/markdownEditor/persistence/useMarkdownPersistenceGuards";
import { startAgentOpenedPreviews } from "./agentOpenedPreviews";

const notices = vi.hoisted(() => ({ add: vi.fn(() => "departure-notice"), close: vi.fn() }));
vi.mock("../../components/ui/toast", () => ({ toastManager: notices }));
vi.mock("../../state/entities", () => ({ readEnvironmentSupportsServerBrowser: () => true }));
vi.mock("../../hooks/useSettings", () => ({
  getClientSettings: () => ({ browserAutoShowFloatingPreview: false }),
}));
// Reload transport is unrelated; the real chat, surface and route departure hooks stay mounted.
vi.mock("../../lib/desktopReload", () => ({ useDesktopReloadGuard: () => {} }));

const ref = scopeThreadRef(EnvironmentId.make("env-a"), ThreadId.make("thread-a"));
const otherEnvironment = scopeThreadRef(EnvironmentId.make("env-b"), ref.threadId);
const otherThread = scopeThreadRef(ref.environmentId, ThreadId.make("thread-b"));
const fileId = "file:notes.md";

function session(tabId = "tab-a", id = "baseline", reveal = true): PreviewSessionSnapshot {
  return {
    threadId: ref.threadId,
    tabId: PreviewTabId.make(tabId),
    runtime: "server",
    navStatus: { _tag: "Idle" },
    canGoBack: false,
    canGoForward: false,
    reveal,
    revealRequest: { id, force: true },
    updatedAt: "2026-10-26T00:00:00Z",
  };
}

async function setup() {
  const stack = new AsyncDisposableStack();
  try {
    notices.add.mockClear();
    notices.close.mockClear();
    const oldPanel = useRightPanelStore.getState();
    const oldPlayer = usePreviewMiniPlayerStore.getState();
    stack.defer(() => {
      resetPreviewStateForTests();
      useRightPanelStore.setState(oldPanel, true);
      usePreviewMiniPlayerStore.setState(oldPlayer, true);
    });
    stack.use(fakeTimers());
    resetPreviewStateForTests();
    useRightPanelStore.setState({ byThreadKey: {} });
    usePreviewMiniPlayerStore.setState({ byThreadKey: {} });
    let revision = 0;
    const update = (
      sessions: readonly PreviewSessionSnapshot[],
      threadRef = ref,
      serverEpoch = "epoch-a",
    ) => {
      reconcilePreviewServerSessions(threadRef, {
        sessions: sessions.map((value) => ({ ...value, threadId: threadRef.threadId })),
        serverEpoch,
        revision: ++revision,
      });
    };
    for (const threadRef of [ref, otherEnvironment, otherThread]) {
      update([session()], threadRef);
      useRightPanelStore.getState().openBrowser(threadRef, "tab-a");
      useRightPanelStore.getState().openFile(threadRef, "notes.md");
    }
    const writeStarted = Promise.withResolvers<void>();
    const receipt = Promise.withResolvers<{ revision: string }>();
    const target = {
      environmentId: ref.environmentId,
      cwd: "/synthetic",
      relativePath: "notes.md",
    };
    const write = vi.fn(() => {
      writeStarted.resolve();
      return receipt.promise;
    });
    const transport: MarkdownPersistenceTransport = {
      write,
      read: async () => ({ source: "A", revision: "rA" }),
      classifyFailure: (error) =>
        error === "target_changed" ? "target_changed" : "recovery_required",
      subscribe: () => () => {},
      project: () => {},
    };
    const registry = new MarkdownPersistenceRegistry({
      checkpointStore: createTestCheckpointStore(),
      createTransport: () => transport,
      cleanLimit: 0,
    });
    const lease = registry.acquire(target, {
      relativePath: "notes.md",
      contents: "A",
      revision: "rA",
      byteLength: 1,
      truncated: false,
    })!;
    stack.defer(() => lease.release());
    const attention = vi.fn();
    let departure: ChatSurfaceDepartureGuards | undefined;
    function Harness() {
      const params = useParams({ strict: false });
      const activeThreadRef = useActiveThreadRef({
        environmentId: EnvironmentId.make(params.environmentId!),
        id: ThreadId.make(params.threadId!),
      });
      const files = useSyncExternalStore(registry.subscribe, registry.getSnapshot);
      const activeSurfaceId = useRightPanelStore(
        (state) => state.byThreadKey[scopedThreadKey(activeThreadRef!)]?.activeSurfaceId ?? null,
      );
      const guards = createMarkdownPersistenceGuards({
        files,
        registry,
        scope: { kind: "surface", environmentId: activeThreadRef!.environmentId, cwd: target.cwd },
        genericPendingIds: new Set(),
        onAttention: attention,
      });
      const currentDeparture = useChatSurfaceDepartureGuards({
        activeThreadRef,
        activeSurfaceId,
        pendingFileSurfaceIds: guards.pendingSurfaceIds,
        markdownDepartureOptions: guards.departureOptions,
        environmentId: activeThreadRef!.environmentId,
        cwd: target.cwd,
        pendingFileSurfaceIdsByProject: new Map(),
        handleMarkdownAttention: attention,
      });
      useLayoutEffect(() => {
        departure = currentDeparture;
      });
      return <p>{activeSurfaceId}</p>;
    }
    const root = createRootRoute({ component: Outlet });
    const route = createRoute({
      getParentRoute: () => root,
      path: "/$environmentId/$threadId",
      component: Harness,
    });
    const router = createRouter({
      routeTree: root.addChildren([
        route,
        createRoute({
          getParentRoute: () => root,
          path: "/outside",
          component: () => <p>Outside chat</p>,
        }),
      ]),
      history: createMemoryHistory({ initialEntries: ["/env-a/thread-a"] }),
      defaultPendingMinMs: 0,
      disableGlobalCatchBoundary: true,
    });
    await router.load();
    stack.use(
      await render(<RouterProvider router={router} />, {
        router: false, // The fixture owns the router used by the actual chat departure adapter.
      }),
    );
    const flush = stack.use(vi.spyOn(registry, "flushTarget"));
    const stop = startAgentOpenedPreviews();
    stack.defer(stop);
    const active = (threadRef = ref) =>
      useRightPanelStore.getState().byThreadKey[scopedThreadKey(threadRef)]?.activeSurfaceId;
    const player = () =>
      usePreviewMiniPlayerStore.getState().byThreadKey[scopedThreadKey(ref)]?.content;
    return {
      update,
      lease,
      write,
      attention,
      router,
      stop,
      active,
      player,
      async dirty() {
        await act(() => {
          expect(lease.change("B", lease.getSnapshot().editVersion)).toBe(true);
        });
      },
      async reveal(id = "forced") {
        await act(() => update([session("tab-a", id)]));
      },
      async waitForWrite() {
        await writeStarted.promise;
        expect(write).toHaveBeenCalledOnce();
      },
      async confirm() {
        const completion = flush.mock.results.at(-1)?.value;
        expect(completion).toBeDefined();
        await act(async () => {
          receipt.resolve({ revision: "rB" });
          expect(await completion).toBe(true);
        });
      },
      async refuse(reason: "target_changed" | "recovery_required") {
        const completion = flush.mock.results.at(-1)?.value;
        expect(completion).toBeDefined();
        await act(async () => {
          receipt.reject(reason);
          expect(await completion).toBe(false);
        });
      },
      async userSwitch() {
        await act(() =>
          departure!.runAfterPendingFileSave("diff", () =>
            useRightPanelStore.getState().open(ref, "diff"),
          ),
        );
      },
      async [Symbol.asyncDispose]() {
        await stack.disposeAsync();
      },
    };
  } catch (error) {
    await stack.disposeAsync();
    throw error;
  }
}

it("keeps the file active until the controlled write confirms, then reveals exactly its browser", async () => {
  await using app = await setup();
  await app.dirty();
  await app.reveal();
  await app.waitForWrite();
  expect(app.active()).toBe(fileId);
  expect(app.lease.getSnapshot().pending).toBe(true);
  expect(app.player()).toBeUndefined();
  await app.confirm();
  expect(app.lease.getSnapshot().pending).toBe(false);
  expect(app.active()).toBe("browser:tab-a");
  expect(app.player()).toBeUndefined();
  expect(app.write).toHaveBeenCalledOnce();
});

it("reads the actual active surface when a reveal arrives before React commits a tab switch", async () => {
  await using app = await setup();
  await act(() => useRightPanelStore.getState().open(ref, "diff"));
  await app.dirty();
  await act(() => {
    useRightPanelStore.getState().activateSurface(ref, fileId);
    app.update([session("tab-a", "same-turn")]);
    expect(app.active()).toBe(fileId);
  });
  await app.waitForWrite();
  await app.confirm();
  expect(app.active()).toBe("browser:tab-a");
});

it.each(["target_changed", "recovery_required"] as const)(
  "keeps %s attention in the file and refuses another reveal",
  async (reason) => {
    await using app = await setup();
    await app.dirty();
    await app.reveal();
    await app.waitForWrite();
    await app.refuse(reason);
    expect(app.lease.getSnapshot()).toMatchObject({
      pending: true,
      attention: reason,
      draftSource: "B",
    });
    expect(app.active()).toBe(fileId);
    expect(app.attention).toHaveBeenCalledWith(fileId);
    await app.reveal("new-forced-request");
    expect(app.active()).toBe(fileId);
    expect(app.write).toHaveBeenCalledOnce();
  },
);

it.each([
  "hidden",
  "removed",
  "suppressed",
  "new-server",
  "replaced-panel",
  "new-floating-tab",
  "route-roundtrip",
  "environment",
  "user-switch",
  "service-stop",
  "unmount",
] as const)("does not complete a reveal superseded by %s while saving", async (change) => {
  await using app = await setup();
  await app.dirty();
  await app.reveal();
  await app.waitForWrite();
  expect(app.active()).toBe(fileId);
  await act(async () => {
    switch (change) {
      case "hidden":
        app.update([session("tab-a", "hidden", false)]);
        break;
      case "removed":
        app.update([]);
        break;
      case "suppressed":
        beginPreviewSessionClose(ref, PreviewTabId.make("tab-a"));
        break;
      case "new-server":
        app.update([session("tab-a", "forced")], ref, "epoch-b");
        break;
      case "replaced-panel":
        useRightPanelStore.getState().closeSurface(ref, "browser:tab-a");
        useRightPanelStore.getState().openBrowser(ref, "tab-a");
        useRightPanelStore.getState().activateSurface(ref, fileId);
        break;
      case "new-floating-tab":
        app.update([session("tab-a", "forced"), session("tab-new", "newer")]);
        break;
      case "route-roundtrip":
        await app.router.navigate({ href: "/env-a/thread-b" });
        await app.router.navigate({ href: "/env-a/thread-a" });
        break;
      case "environment":
        await app.router.navigate({ href: "/env-b/thread-a" });
        break;
      case "user-switch":
        await app.userSwitch();
        break;
      case "service-stop":
        app.stop();
        break;
      case "unmount":
        await app.router.navigate({ href: "/outside" });
        break;
    }
  });
  await app.confirm();
  expect(app.active()).toBe(change === "user-switch" ? "diff" : fileId);
  expect(app.active(otherEnvironment)).toBe(fileId);
  if (change === "new-floating-tab")
    expect(app.player()).toMatchObject({ kind: "browser", tabId: "tab-new" });
});

it("allows a new request for the same browser to replace an older pending request", async () => {
  await using app = await setup();
  await app.dirty();
  await app.reveal("older");
  await app.waitForWrite();
  await app.reveal("newer");
  expect(app.active()).toBe(fileId);
  await app.confirm();
  expect(app.active()).toBe("browser:tab-a");
  expect(app.write).toHaveBeenCalledOnce();
});

it("reveals a clean existing tab without issuing a write", async () => {
  await using app = await setup();
  await app.reveal();
  expect(app.active()).toBe("browser:tab-a");
  expect(app.write).not.toHaveBeenCalled();
});

it.each([otherEnvironment, otherThread])(
  "records background presentation for $environmentId/$threadId without leaving the active dirty file",
  async (backgroundRef) => {
    await using app = await setup();
    await app.dirty();
    await act(() => app.update([session("tab-a", "background")], backgroundRef));
    expect(app.active(backgroundRef)).toBe("browser:tab-a");
    expect(app.active()).toBe(fileId);
    expect(app.write).not.toHaveBeenCalled();
  },
);

it("floats a new tab without displacing or flushing the pending editor", async () => {
  await using app = await setup();
  await app.dirty();
  await act(() => app.update([session("tab-a"), session("tab-new", "forced-new")]));
  expect(app.player()).toMatchObject({ kind: "browser", tabId: "tab-new" });
  expect(app.active()).toBe(fileId);
  expect(app.write).not.toHaveBeenCalled();
});
