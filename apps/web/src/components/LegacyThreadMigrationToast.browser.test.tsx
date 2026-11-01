import { render as _fixtureRender, type Screen, act } from "../../test/render";
import "../index.css";

import { expect, it, vi } from "vite-plus/test";
import { page } from "vitest/browser";
import type { ServerLifecycleLegacyThreadMigrationPayload } from "@t3tools/contracts";
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
  useRouter,
} from "@tanstack/react-router";
import { useEffect } from "react";

const state = vi.hoisted(() => ({
  subscriptions: 0,
  migration: null as ServerLifecycleLegacyThreadMigrationPayload | null,
  listener: null as ((value: ServerLifecycleLegacyThreadMigrationPayload | null) => void) | null,
}));
vi.mock("../rpc/atomRegistry", () => ({
  appAtomRegistry: {
    subscribe: (_atom: unknown, listener: typeof state.listener) => {
      state.subscriptions++;
      state.listener = listener;
      listener?.(state.migration);
      return () => {
        state.listener = null;
      };
    },
  },
}));
vi.mock("../state/server", () => ({ primaryServerLegacyThreadMigrationAtom: {} }));
vi.mock("@tanstack/react-router", async (_actualRouter) => ({
  ...(await _actualRouter<typeof import("@tanstack/react-router")>()),
  useParams: () => null,
}));
vi.mock("~/composerDraftStore", async () => {
  const Schema = await import("effect/Schema");
  return {
    DraftId: Schema.String.pipe(Schema.brand("DraftId")),
    useComposerDraftStore: () => null,
  };
});

import { startLegacyThreadMigrationToast } from "./LegacyThreadMigrationToast";
import { AppToastProviders, ToastProvider, toastManager } from "./ui/toast";

async function _cleanupFixture0(_fixture: _Fixture) {
  await act(() => _fixture.stop?.());
  await _fixture.root0?.unmount();
  _fixture.host?.remove();
  _fixture.root0 = undefined;
  _fixture.host = undefined;
  state.migration = null;
}

async function publish(_fixture: _Fixture, migration: ServerLifecycleLegacyThreadMigrationPayload) {
  await act(() => {
    state.migration = migration;
    if (!_fixture.stop) _fixture.stop = startLegacyThreadMigrationToast();
    else state.listener?.(migration);
  });
}

it("keeps a failed restoration visible and removes it after verified completion", async () => {
  await using _fixture = _createFixture();
  _fixture.cleanup.defer(() => _cleanupFixture0(_fixture));

  await page.viewport(1000, 650);
  _fixture.host = document.createElement("div");
  document.body.append(_fixture.host);
  _fixture.root0 = _fixture.stack.use(
    await _fixtureRender(<ToastProvider />, { container: _fixture.host, router: false }),
  );
  await publish(_fixture, { status: "running", totalThreadCount: 2 });
  await expect.element(page.getByText("Restoring your threads…")).toBeVisible();
  await publish(_fixture, { status: "complete", totalThreadCount: 2 });
  await expect.element(page.getByText("Restoring your threads…")).not.toBeInTheDocument();
  const directory = import.meta.env.VITE_SCIENT_MIGRATION_SCREENSHOTS;
  // The old failure path used this complete state, leaving no notice.
  if (directory) await page.screenshot({ path: `${directory}/before-failure.png` });
  await publish(_fixture, {
    status: "running",
    failed: true,
    totalThreadCount: 2,
    pendingThreadCount: 1,
  });
  await expect.element(page.getByText("Thread restoration needs attention")).toBeVisible();
  await expect.element(page.getByText(/1 thread still needs restoration/)).toBeVisible();
  if (directory) await page.screenshot({ path: `${directory}/after-failure.png` });
  await publish(_fixture, { status: "complete", totalThreadCount: 2, pendingThreadCount: 0 });
  await expect
    .element(page.getByText("Thread restoration needs attention"))
    .not.toBeInTheDocument();
});

const recoveryCases: ReadonlyArray<{
  migration: ServerLifecycleLegacyThreadMigrationPayload;
  title: string;
}> = [
  { migration: { status: "running", totalThreadCount: 2 }, title: "Restoring your threads…" },
  {
    migration: { status: "running", failed: true, totalThreadCount: 2, pendingThreadCount: 1 },
    title: "Thread restoration needs attention",
  },
  {
    migration: { status: "running", failed: true, totalThreadCount: 2 },
    title: "Thread restoration needs attention",
  },
];

it.each(recoveryCases)(
  "retains the same $migration notice across root error and recovery without another emission",
  async ({ migration, title }) => {
    await using fixture = _createFixture();
    fixture.cleanup.defer(() => _cleanupFixture0(fixture));
    state.migration = null;
    const subscriptionsBefore = state.subscriptions;
    let failing = false;
    let mounts = 0;
    let unmounts = 0;
    function NormalRoute() {
      useEffect(() => {
        mounts++;
        return () => {
          unmounts++;
        };
      }, []);
      return <p>Normal route</p>;
    }
    function ErrorRoute() {
      const router = useRouter();
      return (
        <button
          onClick={() => {
            failing = false;
            void router.invalidate();
          }}
        >
          Retry route
        </button>
      );
    }
    // The production root uses this same shell outside TanStack's recovery boundary.
    const router = createRouter({
      history: createMemoryHistory({ initialEntries: ["/"] }),
      routeTree: createRootRoute({
        shellComponent: AppToastProviders,
        beforeLoad: () => {
          if (failing) throw new Error("Recoverable route failure");
        },
        component: NormalRoute,
        errorComponent: ErrorRoute,
      }),
    });
    await router.load();
    // Start the one service before its provider, as main/appInit do.
    await publish(fixture, migration);
    fixture.root0 = fixture.stack.use(
      await _fixtureRender(<RouterProvider router={router} />, {
        router: false, // This fixture owns the real error/recovery router.
      }),
    );
    using add = vi.spyOn(toastManager, "add");
    await expect.element(page.getByText(title, { exact: true })).toBeVisible();
    const originalNotice = page.getByText(title, { exact: true }).element();
    if (migration.failed && migration.pendingThreadCount === undefined) {
      await expect.element(page.getByText(/Restoration could not be verified/)).toBeVisible();
    }
    const completedNotice = toastManager.add({
      type: "success",
      title: "Already completed",
      timeout: 0,
    });
    await expect.element(page.getByText("Already completed")).toBeInTheDocument();
    await act(() => toastManager.close(completedNotice));
    await expect.element(page.getByText("Already completed")).not.toBeInTheDocument();
    add.mockClear();

    await act(async () => {
      failing = true;
      await router.invalidate();
    });
    await expect.element(page.getByRole("button", { name: "Retry route" })).toBeVisible();
    expect(unmounts).toBe(1);
    await expect.element(page.getByText(title, { exact: true })).toBeVisible();
    expect(page.getByText(title, { exact: true }).element()).toBe(originalNotice);
    await publish(fixture, { ...migration });
    await page.getByRole("button", { name: "Retry route" }).click();
    await expect.element(page.getByText("Normal route")).toBeVisible();
    expect(mounts).toBe(2);
    await expect.element(page.getByText(title, { exact: true })).toBeVisible();
    expect(page.getByText(title, { exact: true }).element()).toBe(originalNotice);
    expect(add).not.toHaveBeenCalled();
    await expect.element(page.getByText("Already completed")).not.toBeInTheDocument();

    await publish(fixture, { status: "complete", totalThreadCount: 2, pendingThreadCount: 0 });
    await expect.element(page.getByText(title, { exact: true })).not.toBeInTheDocument();
    await act(async () => {
      failing = true;
      await router.invalidate();
    });
    await expect.element(page.getByRole("button", { name: "Retry route" })).toBeVisible();
    await page.getByRole("button", { name: "Retry route" }).click();
    await expect.element(page.getByText("Normal route")).toBeVisible();
    await expect.element(page.getByText(title, { exact: true })).not.toBeInTheDocument();
    expect(add).not.toHaveBeenCalled();
    expect(state.subscriptions).toBe(subscriptionsBefore + 1);
  },
);

function _createFixture() {
  const stack = new AsyncDisposableStack();
  const cleanup = new AsyncDisposableStack();
  return {
    stop: undefined as (() => void) | undefined,
    host: undefined! as HTMLDivElement | undefined,
    stack,
    cleanup,
    root0: undefined! as Screen | undefined,
    async [Symbol.asyncDispose]() {
      try {
        await cleanup.disposeAsync();
      } finally {
        await stack.disposeAsync();
      }
    },
  };
}
type _Fixture = ReturnType<typeof _createFixture>;
