import "../../index.css";

import type { DesktopUpdateState } from "@t3tools/contracts";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vitest/browser";

import { SidebarNewThreadRow } from "../../scient/sidebar/SidebarNewThreadRow";
import { SidebarFooter, SidebarProvider } from "../ui/sidebar";
import { TooltipProvider } from "../ui/tooltip";
import { SidebarUtilityMenu } from "./SidebarChrome";

const fixture = vi.hoisted(() => ({
  updateState: null as DesktopUpdateState | null,
  navigate: vi.fn(),
  importConversation: vi.fn(),
}));
vi.mock("../../env", () => ({ isElectron: true }));
vi.mock("../../state/desktopUpdate", () => ({
  useDesktopUpdateState: () => fixture.updateState,
}));
vi.mock("../../state/environments", async (original) => ({
  ...(await original<typeof import("../../state/environments")>()),
  useEnvironments: () => ({
    environments: [{ serverConfig: { environment: { capabilities: { pullRequests: true } } } }],
  }),
}));
vi.mock("@tanstack/react-router", async (original) => ({
  ...(await original<typeof import("@tanstack/react-router")>()),
  useNavigate: () => fixture.navigate,
  useLocation: () => false,
}));
vi.mock("../../scient/conversationImport/requests", () => ({
  requestConversationImport: fixture.importConversation,
}));

let host: HTMLDivElement | undefined;
let root: Root | undefined;
afterEach(() => {
  root?.unmount();
  host?.remove();
  vi.clearAllMocks();
});

const updateState: DesktopUpdateState = {
  enabled: true,
  status: "downloaded",
  channel: "latest",
  currentVersion: "0.6.20",
  availableVersion: "0.6.21",
  downloadedVersion: "0.6.21",
  hostArch: "arm64",
  appArch: "arm64",
  runningUnderArm64Translation: false,
  releaseNotes: [],
  omittedReleaseCount: 0,
  downloadPercent: null,
  checkedAt: null,
  message: null,
  errorContext: null,
  canRetry: false,
};

async function mountFooter(width: number, state: DesktopUpdateState) {
  fixture.updateState = state;
  host = document.createElement("div");
  Object.assign(host.style, { width: `${width}px`, margin: "20px", background: "white" });
  document.body.append(host);
  root = createRoot(host);
  root.render(
    <SidebarProvider className="min-h-0">
      <TooltipProvider>
        <SidebarFooter className="w-full">
          <SidebarUtilityMenu />
        </SidebarFooter>
      </TooltipProvider>
    </SidebarProvider>,
  );
  await expect.poll(() => host!.querySelectorAll("button").length).toBeGreaterThan(3);
}

it.each(["available", "downloading", "downloaded", "error"] as const)(
  "keeps %s updates inside the minimum sidebar and preserves overflow actions",
  async (status) => {
    await mountFooter(216, {
      ...updateState,
      status,
      ...(status === "downloading" ? { downloadPercent: 57 } : {}),
      ...(status === "error" ? { errorContext: "install", canRetry: true } : {}),
    });
    const more = page.getByRole("button", { name: "More sidebar actions", includeHidden: true });
    await expect.element(more).toBeVisible();
    await expect
      .element(page.getByRole("button", { name: "Import conversation", includeHidden: true }))
      .not.toBeVisible();
    await expect
      .element(page.getByRole("button", { name: "Usage", exact: true, includeHidden: true }))
      .not.toBeVisible();
    const footer = host!
      .querySelector<HTMLElement>('[data-sidebar="footer"]')!
      .getBoundingClientRect();
    const buttons = [...host!.querySelectorAll("button")].filter(
      (button) => button.getClientRects().length,
    );
    let previousRight = footer.left;
    for (const button of buttons) {
      const rect = button.getBoundingClientRect();
      expect(rect.left).toBeGreaterThanOrEqual(previousRight);
      expect(rect.right).toBeLessThanOrEqual(footer.right);
      previousRight = rect.right;
    }
    await more.click();
    await expect.element(page.getByRole("menuitem", { name: "Import conversation" })).toBeVisible();
    if (status === "downloaded" && import.meta.env.VITE_SCIENT_SIDEBAR_SCREENSHOTS) {
      await page.screenshot({
        path: `${import.meta.env.VITE_SCIENT_SIDEBAR_SCREENSHOTS}/restart-menu.png`,
      });
    }
    await page.getByRole("menuitem", { name: "Usage", exact: true }).click();
    expect(fixture.navigate).toHaveBeenCalledWith({ to: "/usage" });
    await more.click();
    await page.getByRole("menuitem", { name: "Import conversation" }).click();
    expect(fixture.importConversation).toHaveBeenCalledOnce();

    host!.style.width = "280px";
    await expect.element(more).not.toBeVisible();
    await expect
      .element(page.getByRole("button", { name: "Import conversation", includeHidden: true }))
      .toBeVisible();
    await expect
      .element(page.getByRole("button", { name: "Usage", exact: true, includeHidden: true }))
      .toBeVisible();
    if (status === "downloaded" && import.meta.env.VITE_SCIENT_SIDEBAR_SCREENSHOTS) {
      await page.screenshot({
        path: `${import.meta.env.VITE_SCIENT_SIDEBAR_SCREENSHOTS}/restart-wide.png`,
        element: host!,
      });
    }
  },
);

it("keeps all four utilities equally spaced and inset while updates are idle", async () => {
  await mountFooter(216, {
    ...updateState,
    status: "idle",
    downloadedVersion: null,
    availableVersion: null,
  });
  await expect
    .element(page.getByRole("button", { name: "More sidebar actions", includeHidden: true }))
    .not.toBeVisible();
  const buttons = [
    ...host!.querySelectorAll<HTMLButtonElement>('[data-sidebar="menu-button"]'),
  ].filter((button) => button.getClientRects().length);
  expect(buttons).toHaveLength(4);
  const rects = buttons.map((button) => button.getBoundingClientRect());
  expect(rects[0]!.left - host!.getBoundingClientRect().left).toBe(12);
  expect(rects.slice(1).map((rect, index) => rect.left - rects[index]!.right)).toEqual([4, 4, 4]);
});

it("shows a compact current-project tooltip with its keyboard shortcut", async () => {
  host = document.createElement("div");
  Object.assign(host.style, { width: "280px", margin: "20px" });
  document.body.append(host);
  root = createRoot(host);
  root.render(
    <SidebarProvider className="min-h-0">
      <TooltipProvider delay={0}>
        <SidebarNewThreadRow
          onNewThread={() => {}}
          shortcutLabel="⇧⌘O"
          inProjectShortcutLabel="⇧⌘N"
          showInProjectHint
        />
      </TooltipProvider>
    </SidebarProvider>,
  );
  await userEvent.hover(page.getByRole("button", { name: "New thread", exact: true }));
  await expect.poll(() => document.querySelector('[data-slot="tooltip-popup"]')).not.toBeNull();
  const tooltip = document.querySelector<HTMLElement>('[data-slot="tooltip-popup"]')!;
  expect(tooltip.textContent).toBe("New thread (⇧⌘O)In current project (⇧⌘N)");
  expect(tooltip.getBoundingClientRect().width).toBeLessThan(230);
  if (import.meta.env.VITE_SCIENT_SIDEBAR_SCREENSHOTS) {
    await page.screenshot({
      path: `${import.meta.env.VITE_SCIENT_SIDEBAR_SCREENSHOTS}/new-thread-tooltip.png`,
    });
  }
});
