import "../index.css";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vite-plus/test";
import { page } from "vitest/browser";
import type { ServerLifecycleLegacyThreadMigrationPayload } from "@t3tools/contracts";

const state = vi.hoisted(() => ({
  migration: null as ServerLifecycleLegacyThreadMigrationPayload | null,
}));
vi.mock("@effect/atom-react", () => ({ useAtomValue: () => state.migration }));
vi.mock("../state/server", () => ({ primaryServerLegacyThreadMigrationAtom: {} }));
vi.mock("@tanstack/react-router", () => ({ useParams: () => null }));
vi.mock("~/composerDraftStore", async () => {
  const Schema = await import("effect/Schema");
  return {
    DraftId: Schema.String.pipe(Schema.brand("DraftId")),
    useComposerDraftStore: () => null,
  };
});

import { LegacyThreadMigrationToast } from "./LegacyThreadMigrationToast";
import { ToastProvider } from "./ui/toast";

let root: Root | undefined;
let host: HTMLDivElement | undefined;
afterEach(() => {
  root?.unmount();
  host?.remove();
  root = undefined;
  host = undefined;
  state.migration = null;
});

async function render(migration: ServerLifecycleLegacyThreadMigrationPayload) {
  state.migration = migration;
  root!.render(
    <>
      <ToastProvider />
      <LegacyThreadMigrationToast />
    </>,
  );
}

it("keeps a failed restoration visible and removes it after verified completion", async () => {
  await page.viewport(1000, 650);
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await render({ status: "running", totalThreadCount: 2 });
  await expect.element(page.getByText("Restoring your threads…")).toBeVisible();
  await render({ status: "complete", totalThreadCount: 2 });
  await expect.element(page.getByText("Restoring your threads…")).not.toBeInTheDocument();
  const directory = import.meta.env.VITE_SCIENT_MIGRATION_SCREENSHOTS;
  // The old failure path used this complete state, leaving no notice.
  if (directory) await page.screenshot({ path: `${directory}/before-failure.png` });
  await render({ status: "running", failed: true, totalThreadCount: 2, pendingThreadCount: 1 });
  await expect.element(page.getByText("Thread restoration needs attention")).toBeVisible();
  await expect.element(page.getByText(/1 thread still needs restoration/)).toBeVisible();
  await expect
    .poll(() => {
      const title = [...document.querySelectorAll<HTMLElement>('[data-slot="toast-title"]')].find(
        (element) => element.textContent === "Thread restoration needs attention",
      );
      return title?.getBoundingClientRect().right ?? Infinity;
    })
    .toBeLessThanOrEqual(window.innerWidth);
  if (directory) await page.screenshot({ path: `${directory}/after-failure.png` });
  await render({ status: "complete", totalThreadCount: 2, pendingThreadCount: 0 });
  await expect
    .element(page.getByText("Thread restoration needs attention"))
    .not.toBeInTheDocument();
});
