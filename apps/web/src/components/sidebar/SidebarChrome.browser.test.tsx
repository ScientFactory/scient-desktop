import "../../index.css";

import { EnvironmentId, type DesktopUpdateState } from "@t3tools/contracts";
import { PrimaryConnectionTarget } from "@t3tools/client-runtime/connection";
import * as Option from "effect/Option";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vitest/browser";

import { AppAtomRegistryProvider } from "../../rpc/atomRegistry";
import { SidebarNewThreadRow } from "../../scient/sidebar/SidebarNewThreadRow";
import { SidebarFooter, SidebarProvider } from "../ui/sidebar";
import { TooltipProvider } from "../ui/tooltip";
import { SidebarUtilityMenu } from "./SidebarChrome";
import { setUpdateEverythingRun, waitForUpdateRestart } from "./updateEverythingRun";
import type { useUpdateEverything } from "./useUpdateEverything";

const fixture = vi.hoisted(() => ({
  updateState: null as DesktopUpdateState | null,
  /** Replaces the remote half of the update button when set. */
  everything: null as ReturnType<typeof useUpdateEverything> | null,
  navigate: vi.fn(),
  preload: vi.fn(() => Promise.resolve([])),
  importConversation: vi.fn(),
  environments: [] as Array<{
    environmentId: EnvironmentId;
    label: string;
    connection: { phase: "connected"; error: null; traceId: null };
    entry: {
      target: PrimaryConnectionTarget;
      enabled: boolean;
      profile: Option.Option<never>;
    };
    serverConfig: {
      environment: {
        environmentId: EnvironmentId;
        label: string;
        platform: { os: "linux"; arch: "x64" };
        serverVersion: string;
        capabilities: { repositoryIdentity: boolean; pullRequests: boolean };
      };
      settings: { continueThreadsAfterServerUpdate: boolean };
      providers: readonly never[];
    };
  }>,
}));
vi.mock("../../env", () => ({ isElectron: true }));
vi.mock("../../state/desktopUpdate", () => ({
  useDesktopUpdateState: () => fixture.updateState,
}));
vi.mock("./useUpdateEverything", async (original) => {
  const actual = await original<typeof import("./useUpdateEverything")>();
  return {
    useUpdateEverything: (localUpdateVersion: string | null) => {
      const real = actual.useUpdateEverything(localUpdateVersion);
      return fixture.everything ?? real;
    },
  };
});
vi.mock("../../state/environments", async (original) => ({
  ...(await original<typeof import("../../state/environments")>()),
  useEnvironments: () => ({
    environments: fixture.environments,
  }),
  usePullRequestsSupported: () => true,
}));
vi.mock("@tanstack/react-router", async (original) => ({
  ...(await original<typeof import("@tanstack/react-router")>()),
  useNavigate: () => fixture.navigate,
  useRouter: () => ({ preloadRoute: fixture.preload }),
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
  fixture.everything = null;
  setUpdateEverythingRun(() => null);
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
  const environmentId = EnvironmentId.make("sidebar-geometry-primary");
  fixture.environments = [
    {
      environmentId,
      label: "This app",
      connection: { phase: "connected", error: null, traceId: null },
      entry: {
        target: new PrimaryConnectionTarget({
          environmentId,
          label: "This app",
          httpBaseUrl: "http://localhost:5733",
          wsBaseUrl: "ws://localhost:5733",
        }),
        enabled: true,
        profile: Option.none(),
      },
      serverConfig: {
        environment: {
          environmentId,
          label: "This app",
          platform: { os: "linux", arch: "x64" },
          serverVersion: state.currentVersion,
          capabilities: { repositoryIdentity: true, pullRequests: true },
        },
        settings: { continueThreadsAfterServerUpdate: false },
        providers: [],
      },
    },
  ];
  host = document.createElement("div");
  Object.assign(host.style, { width: `${width}px`, margin: "20px", background: "white" });
  document.body.append(host);
  root = createRoot(host);
  // The app root's registry carries the shared update-run state the pill reads.
  root.render(
    <AppAtomRegistryProvider>
      <SidebarProvider className="min-h-0">
        <TooltipProvider>
          <SidebarFooter className="w-full">
            <SidebarUtilityMenu />
          </SidebarFooter>
        </TooltipProvider>
      </SidebarProvider>
    </AppAtomRegistryProvider>,
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

const idleUpdateState: DesktopUpdateState = {
  ...updateState,
  status: "idle",
  downloadedVersion: null,
  availableVersion: null,
};

// SCIENT-FORK:START — other machines and providers have their own 20px circle and card.
const alvin = EnvironmentId.make("sidebar-geometry-alvin");
const alvinServer = {
  environmentId: alvin,
  serverLabel: "alvin",
  selfUpdate: "boot-service" as const,
  targetVersion: "0.6.21",
};

function everythingFixture(): ReturnType<typeof useUpdateEverything> {
  return {
    hasUpdates: true,
    summary: "Update 1 server",
    lines: ["alvin: server to 0.6.21"],
    restarts: [],
    skipped: [],
    otherServers: [
      {
        environmentId: alvin,
        label: "alvin",
        app: false,
        fromVersion: "0.6.20",
        toVersion: "0.6.21",
        target: alvinServer,
      },
    ],
    // The pass stays in progress, so the circle keeps showing it.
    run: () => {
      setUpdateEverythingRun(() => ({
        localVersion: null,
        phase: "providers",
        restartAt: null,
        machines: [
          {
            environmentId: alvin,
            label: "alvin",
            updatesProviders: false,
            server: alvinServer,
            handedOffVersion: null,
            startedAt: Date.now(),
            result: null,
            failure: null,
            providerFailure: null,
          },
        ],
      }));
      return new Promise<void>(() => {});
    },
  };
}

function expectFooterInOrder() {
  const footer = host!
    .querySelector<HTMLElement>('[data-sidebar="footer"]')!
    .getBoundingClientRect();
  let previousRight = footer.left;
  for (const visible of [...host!.querySelectorAll("button")].filter(
    (candidate) => candidate.getClientRects().length,
  )) {
    const bounds = visible.getBoundingClientRect();
    expect(bounds.left).toBeGreaterThanOrEqual(previousRight);
    expect(bounds.right).toBeLessThanOrEqual(footer.right);
    // Labels never truncate; the circle's progress ring is drawn around it on purpose.
    if (!visible.matches("[data-other-updates]")) {
      expect(visible.scrollWidth).toBeLessThanOrEqual(visible.clientWidth);
    }
    previousRight = bounds.right;
  }
}

it.each([
  ["idle", "Check for updates"],
  ["downloaded", "Restart"],
] as const)(
  "keeps the other-updates circle at 20px beside the %s app control",
  async (status, appLabel) => {
    fixture.everything = everythingFixture();
    await mountFooter(216, status === "idle" ? idleUpdateState : updateState);
    const circle = page.getByRole("button", { name: "Other updates available" });
    await expect.element(circle).toBeVisible();
    const app = page.getByRole("button", { name: new RegExp(`^${appLabel}`) });
    await expect.element(app).toBeVisible();

    const bounds = (circle.element() as HTMLElement).getBoundingClientRect();
    expect([bounds.width, bounds.height]).toEqual([20, 20]);
    const appBounds = (app.element() as HTMLElement).getBoundingClientRect();
    expect(appBounds.left - bounds.right).toBe(6);
    expect(
      Math.abs(appBounds.top + appBounds.height / 2 - (bounds.top + bounds.height / 2)),
    ).toBeLessThanOrEqual(0.5);
    expectFooterInOrder();
    if (import.meta.env.VITE_SCIENT_SIDEBAR_SCREENSHOTS) {
      await page.screenshot({
        path: `${import.meta.env.VITE_SCIENT_SIDEBAR_SCREENSHOTS}/other-updates-${status}.png`,
        element: host!,
      });
    }
  },
);

it("lists other updates with text actions and updates them without a confirmation", async () => {
  fixture.everything = everythingFixture();
  await mountFooter(216, idleUpdateState);
  await page.getByRole("button", { name: "Other updates available" }).click();
  const updateAll = page.getByRole("button", { name: "Update all" });
  await expect.element(updateAll).toBeVisible();
  const row = document.querySelector<HTMLElement>("[data-other-update-row]")!;
  expect(row.textContent).toContain("alvin server");
  expect(row.textContent).toContain("0.6.20 → 0.6.21");

  const rowUpdate = page.getByRole("button", { name: "Update", exact: true });
  for (const action of [rowUpdate, updateAll]) {
    const style = getComputedStyle(action.element());
    expect(style.borderTopWidth).toBe("0px");
    expect(style.backgroundColor).toBe("rgba(0, 0, 0, 0)");
    expect(style.textDecorationLine).toBe("underline");
  }
  expect(Number(getComputedStyle(updateAll.element()).fontWeight)).toBeGreaterThanOrEqual(600);
  expect(Number(getComputedStyle(rowUpdate.element()).fontWeight)).toBeLessThan(600);
  if (import.meta.env.VITE_SCIENT_SIDEBAR_SCREENSHOTS) {
    await page.screenshot({
      path: `${import.meta.env.VITE_SCIENT_SIDEBAR_SCREENSHOTS}/other-updates-card.png`,
    });
  }

  await updateAll.click();
  expect(document.querySelector('[role="alertdialog"]')).toBeNull();
  const updating = page.getByRole("button", { name: "Other updates in progress" });
  await expect.element(updating).toBeVisible();
  const bounds = (updating.element() as HTMLElement).getBoundingClientRect();
  expect([bounds.width, bounds.height]).toEqual([20, 20]);
  // The ring spins, so measure its drawn size rather than its rotated bounding box.
  const ring = (updating.element() as HTMLElement).querySelector("svg")!;
  expect(getComputedStyle(ring).width).toBe("24px");
  const app = page.getByRole("button", { name: /^Check for updates/ }).element();
  expect(bounds.left + bounds.width / 2 + 12).toBeLessThan(app.getBoundingClientRect().left);
  await expect.poll(() => row.isConnected && row.textContent).toContain("queued");
  expectFooterInOrder();
});

it.each(["Later", "Restart"] as const)(
  "counts down above the Restart pill, and %s decides the restart",
  async (choice) => {
    await mountFooter(216, updateState);
    // Room above the footer for the countdown, which otherwise flips below the pill.
    host!.style.marginTop = "120px";
    window.scrollTo(0, 0);
    setUpdateEverythingRun(() => ({
      localVersion: "0.6.21",
      phase: "servers",
      restartAt: null,
      machines: [],
    }));
    const decision = waitForUpdateRestart(5_000);
    const later = page.getByRole("button", { name: "Later" });
    await expect.element(later).toBeVisible();
    const countdown = document.querySelector<HTMLElement>("[data-update-countdown]")!;
    expect(countdown.textContent).toMatch(/^Restart in [45]sLater$/);
    const style = getComputedStyle(later.element());
    expect(style.borderTopWidth).toBe("0px");
    expect(style.textDecorationLine).toBe("underline");

    const pill = page.getByRole("button", { name: /^Restart/ });
    await expect.element(pill).toBeVisible();
    expect(pill.element().getAttribute("aria-disabled")).toBeNull();
    await expect
      .poll(
        () =>
          countdown.getBoundingClientRect().bottom <=
          (pill.element() as HTMLElement).getBoundingClientRect().top,
      )
      .toBe(true);
    if (import.meta.env.VITE_SCIENT_SIDEBAR_SCREENSHOTS && choice === "Later") {
      await page.screenshot({
        path: `${import.meta.env.VITE_SCIENT_SIDEBAR_SCREENSHOTS}/restart-countdown.png`,
      });
    }
    await (choice === "Later" ? later : pill).click();
    await expect(decision).resolves.toBe(choice === "Restart");
  },
);
// SCIENT-FORK:END

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
