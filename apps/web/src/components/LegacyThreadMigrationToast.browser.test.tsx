import { render as _fixtureRender, type Screen } from "../../test/render";
import "../index.css";

import { expect, it, vi } from "vite-plus/test";
import { page } from "vitest/browser";
import type { ServerLifecycleLegacyThreadMigrationPayload } from "@t3tools/contracts";

const state = vi.hoisted(() => ({
  migration: null as ServerLifecycleLegacyThreadMigrationPayload | null,
}));
vi.mock("@effect/atom-react", () => ({ useAtomValue: () => state.migration }));
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

import { LegacyThreadMigrationToast } from "./LegacyThreadMigrationToast";
import { ToastProvider } from "./ui/toast";

async function _cleanupFixture0(_fixture: _Fixture) {
  await _fixture.root0?.unmount();
  _fixture.host?.remove();
  _fixture.root0 = undefined;
  _fixture.host = undefined;
  state.migration = null;
}

async function render(_fixture: _Fixture, migration: ServerLifecycleLegacyThreadMigrationPayload) {
  state.migration = migration;
  await _fixture.root0!.rerender(
    <>
      <ToastProvider />
      <LegacyThreadMigrationToast />
    </>,
  );
}

it("keeps a failed restoration visible and removes it after verified completion", async () => {
  await using _fixture = _createFixture();
  _fixture.cleanup.defer(() => _cleanupFixture0(_fixture));

  await page.viewport(1000, 650);
  _fixture.host = document.createElement("div");
  document.body.append(_fixture.host);
  _fixture.root0 = _fixture.stack.use(
    await _fixtureRender(null, { container: _fixture.host, router: false }),
  );
  await render(_fixture, { status: "running", totalThreadCount: 2 });
  await expect.element(page.getByText("Restoring your threads…")).toBeVisible();
  await render(_fixture, { status: "complete", totalThreadCount: 2 });
  await expect.element(page.getByText("Restoring your threads…")).not.toBeInTheDocument();
  const directory = import.meta.env.VITE_SCIENT_MIGRATION_SCREENSHOTS;
  // The old failure path used this complete state, leaving no notice.
  if (directory) await page.screenshot({ path: `${directory}/before-failure.png` });
  await render(_fixture, {
    status: "running",
    failed: true,
    totalThreadCount: 2,
    pendingThreadCount: 1,
  });
  await expect.element(page.getByText("Thread restoration needs attention")).toBeVisible();
  await expect.element(page.getByText(/1 thread still needs restoration/)).toBeVisible();
  if (directory) await page.screenshot({ path: `${directory}/after-failure.png` });
  await render(_fixture, { status: "complete", totalThreadCount: 2, pendingThreadCount: 0 });
  await expect
    .element(page.getByText("Thread restoration needs attention"))
    .not.toBeInTheDocument();
});

function _createFixture() {
  const stack = new AsyncDisposableStack();
  const cleanup = new AsyncDisposableStack();
  return {
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
