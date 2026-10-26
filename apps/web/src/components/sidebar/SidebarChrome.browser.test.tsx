import { render as _fixtureRender, type Screen, act, fakeTimers } from "../../../test/render";
import "../../index.css";

import { EnvironmentId, type DesktopUpdateState } from "@t3tools/contracts";
import { PrimaryConnectionTarget } from "@t3tools/client-runtime/connection";
import * as Option from "effect/Option";

import { expect, it, vi } from "vite-plus/test";
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
  /** Threads on the remote machine the circle's server update would restart. */
  remoteThreads: [] as Array<{
    activeRunId: string | null;
    activityRunStatus?: string | null;
    status: string;
  }>,
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
vi.mock("../../state/desktopUpdate", async (original) => ({
  ...(await original<typeof import("../../state/desktopUpdate")>()),
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
  useLocation: () => false,
}));
vi.mock("../../state/threads", async (original) => {
  const actual = await original<typeof import("../../state/threads")>();
  const { Atom } = await import("effect/reactivity");
  const remoteThreads = Atom.make(() => fixture.remoteThreads);
  return {
    ...actual,
    environmentThreadShells: {
      ...actual.environmentThreadShells,
      environmentThreadsAtom: (environmentId: string) =>
        environmentId === "sidebar-geometry-alvin"
          ? remoteThreads
          : actual.environmentThreadShells.environmentThreadsAtom(environmentId as never),
    },
  };
});
vi.mock("../../scient/conversationImport/requests", () => ({
  requestConversationImport: fixture.importConversation,
}));

async function _cleanupFixture0(_fixture: _Fixture) {
  await _fixture.root0?.unmount();
  _fixture.host?.remove();
  fixture.everything = null;
  fixture.remoteThreads = [];
  setUpdateEverythingRun(() => null);
  vi.clearAllMocks();
}

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

async function mountFooter(_fixture: _Fixture, width: number, state: DesktopUpdateState) {
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
    // A remote machine for the circle's server rows.
    {
      environmentId: EnvironmentId.make("sidebar-geometry-alvin"),
      label: "alvin",
      connection: { phase: "connected", error: null, traceId: null },
      entry: {
        target: new PrimaryConnectionTarget({
          environmentId: EnvironmentId.make("sidebar-geometry-alvin"),
          label: "alvin",
          httpBaseUrl: "http://localhost:5734",
          wsBaseUrl: "ws://localhost:5734",
        }),
        enabled: true,
        profile: Option.none(),
      },
      serverConfig: {
        environment: {
          environmentId: EnvironmentId.make("sidebar-geometry-alvin"),
          label: "alvin",
          platform: { os: "linux", arch: "x64" },
          serverVersion: state.currentVersion,
          capabilities: { repositoryIdentity: true, pullRequests: true },
        },
        settings: { continueThreadsAfterServerUpdate: false },
        providers: [],
      },
    },
  ];
  _fixture.host = document.createElement("div");
  Object.assign(_fixture.host.style, { width: `${width}px`, margin: "20px", background: "white" });
  document.body.append(_fixture.host);
  _fixture.root0 = _fixture.stack.use(
    await _fixtureRender(null, { container: _fixture.host, router: false }),
  );
  // The app root's registry carries the shared update-run state the pill reads.
  await _fixture.root0.rerender(
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
  await expect.poll(() => _fixture.host!.querySelectorAll("button").length).toBeGreaterThan(3);
}

// regression: ebcf7ec294 feat(web): show other machines' and providers' updates in a sidebar circle
it("lists other updates with text actions and updates them without a confirmation", async () => {
  await using _fixture = _createFixture();
  _fixture.cleanup.defer(() => _cleanupFixture0(_fixture));

  fixture.everything = everythingFixture();
  await mountFooter(_fixture, 216, idleUpdateState);
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
  // Hover is visible on the light card, and still subtle.
  await userEvent.hover(updateAll);
  await expect
    .poll(() => getComputedStyle(updateAll.element()).backgroundColor)
    .not.toBe("rgba(0, 0, 0, 0)");
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
  expectFooterInOrder(_fixture);
});

// regression: 4b9f781edc fix(sidebar): keep update controls within narrow layouts
it.each(["downloading", "downloaded"] as const)(
  "keeps %s updates inside the minimum sidebar and preserves overflow actions",
  async (status) => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture0(_fixture));

    await mountFooter(_fixture, 216, {
      ...updateState,
      status,
      ...(status === "downloading" ? { downloadPercent: 57 } : {}),
    });
    const more = page.getByRole("button", { name: "More sidebar actions", includeHidden: true });
    await expect.element(more).toBeVisible();
    await expect
      .element(page.getByRole("button", { name: "Import conversation", includeHidden: true }))
      .not.toBeVisible();
    await expect
      .element(page.getByRole("button", { name: "Usage", exact: true, includeHidden: true }))
      .not.toBeVisible();
    const footer = _fixture
      .host!.querySelector<HTMLElement>('[data-sidebar="footer"]')!
      .getBoundingClientRect();
    const buttons = [..._fixture.host!.querySelectorAll("button")].filter(
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

    _fixture.host!.style.width = "280px";
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
        element: _fixture.host!,
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
            startedAt: 0,
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

it("lists other updates and updates them without a confirmation", async () => {
  await using _fixture = _createFixture();
  _fixture.cleanup.defer(() => _cleanupFixture0(_fixture));

  fixture.everything = everythingFixture();
  await mountFooter(_fixture, 216, idleUpdateState);
  await page.getByRole("button", { name: "Other updates available" }).click();
  const updateAll = page.getByRole("button", { name: "Update all" });
  await expect.element(updateAll).toBeVisible();
  const row = document.querySelector<HTMLElement>("[data-other-update-row]")!;
  expect(row.textContent).toContain("alvin server");
  expect(row.textContent).toContain("0.6.20 → 0.6.21");

  if (import.meta.env.VITE_SCIENT_SIDEBAR_SCREENSHOTS) {
    await page.screenshot({
      path: `${import.meta.env.VITE_SCIENT_SIDEBAR_SCREENSHOTS}/other-updates-card.png`,
    });
  }

  await updateAll.click();
  expect(document.querySelector('[role="alertdialog"]')).toBeNull();
  const updating = page.getByRole("button", { name: "Other updates in progress" });
  await expect.element(updating).toBeVisible();
  await expect.poll(() => row.isConnected && row.textContent).toContain("queued");
});

it("asks once inline before Update all stops running threads", async () => {
  await using _fixture = _createFixture();
  _fixture.cleanup.defer(() => _cleanupFixture0(_fixture));

  fixture.everything = everythingFixture();
  fixture.remoteThreads = [
    // A running turn with a follow-up queued behind it, and one on an older server.
    { activeRunId: "run-1", activityRunStatus: "running", status: "queued" },
    { activeRunId: null, status: "running" },
    { activeRunId: null, activityRunStatus: null, status: "idle" },
  ];
  await mountFooter(_fixture, 216, idleUpdateState);
  await page.getByRole("button", { name: "Other updates available" }).click();
  const updateAll = page.getByRole("button", { name: "Update all" });
  await updateAll.click();
  await expect.element(page.getByText("Stops 2 running threads")).toBeVisible();
  // The question is announced and describes the button before the second press.
  const ask = page.getByText("Stops 2 running threads").element();
  expect(ask.getAttribute("aria-live")).toBe("polite");
  expect(updateAll.element().getAttribute("aria-describedby")).toBe(ask.id);
  // Asking does not start anything.
  expect(document.querySelector('[data-other-updates="updating"]')).toBeNull();
  if (import.meta.env.VITE_SCIENT_SIDEBAR_SCREENSHOTS) {
    await page.screenshot({
      path: `${import.meta.env.VITE_SCIENT_SIDEBAR_SCREENSHOTS}/other-updates-ask.png`,
    });
  }
  await updateAll.click();
  await expect
    .element(page.getByRole("button", { name: "Other updates in progress" }))
    .toBeVisible();
  expect(document.querySelector('[role="alertdialog"]')).toBeNull();
});

// regression: 31508a1e79 fix(web): put a card row's thread question on its own line
it("asks on a row's own line before its Update stops running threads", async () => {
  await using _fixture = _createFixture();
  _fixture.cleanup.defer(() => _cleanupFixture0(_fixture));

  const fixtureValue = everythingFixture();
  fixture.everything = {
    ...fixtureValue,
    otherServers: fixtureValue.otherServers.map((server) => ({ ...server, label: "lab-gpu" })),
  };
  fixture.remoteThreads = [
    { activeRunId: "run-1", activityRunStatus: "running", status: "running" },
    { activeRunId: "run-2", activityRunStatus: "running", status: "queued" },
    { activeRunId: null, status: "running" },
  ];
  await mountFooter(_fixture, 216, idleUpdateState);
  await page.getByRole("button", { name: "Other updates available" }).click();
  const rowUpdate = page.getByRole("button", { name: "Update", exact: true });
  await rowUpdate.click();
  await expect.element(page.getByText("Stops 3 running threads")).toBeVisible();

  const card = document.querySelector<HTMLElement>('[data-slot="popover-popup"]')!;
  const row = card.querySelector<HTMLElement>("[data-other-update-row]")!;
  const ask = page.getByText("Stops 3 running threads").element();
  // The question has its own line under the row, and still describes the button.
  expect(row.contains(ask)).toBe(true);
  expect(ask.getBoundingClientRect().top).toBeGreaterThanOrEqual(
    (rowUpdate.element() as HTMLElement).getBoundingClientRect().bottom,
  );
  expect(rowUpdate.element().getAttribute("aria-describedby")).toBe(ask.id);
  expect(ask.getAttribute("aria-live")).toBe("polite");

  if (import.meta.env.VITE_SCIENT_SIDEBAR_SCREENSHOTS) {
    await page.screenshot({
      path: `${import.meta.env.VITE_SCIENT_SIDEBAR_SCREENSHOTS}/other-updates-row-ask.png`,
    });
  }
});

it.each(["Later", "Restart"] as const)(
  "counts down above the Restart pill, and %s decides the restart",
  async (choice) => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture0(_fixture));

    await mountFooter(_fixture, 216, updateState);
    // Room above the footer for the countdown, which otherwise flips below the pill.
    _fixture.host!.style.marginTop = "120px";
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

const availableUpdateState: DesktopUpdateState = {
  ...updateState,
  status: "available",
  downloadedVersion: null,
};

function countedEverythingFixture() {
  const value = everythingFixture();
  const run = vi.fn(value.run);
  return { value: { ...value, run }, run };
}

it("starts a pass that downloads this app at once when it stops no threads", async () => {
  await using _fixture = _createFixture();
  _fixture.cleanup.defer(() => _cleanupFixture0(_fixture));

  const { value, run } = countedEverythingFixture();
  fixture.everything = value;
  await mountFooter(_fixture, 216, availableUpdateState);
  await page.getByRole("button", { name: /^Update: / }).click();
  await expect.poll(() => run.mock.calls.length).toBe(1);
  expect(run.mock.calls[0]![0].admitServer).toBeTypeOf("function");
  expect(document.querySelector("[data-update-ask]")).toBeNull();
  expect(document.querySelector('[role="alertdialog"]')).toBeNull();
});

it("asks above the pill before a pass that downloads this app stops running threads", async () => {
  await using _fixture = _createFixture();
  _fixture.cleanup.defer(() => _cleanupFixture0(_fixture));

  const { value, run } = countedEverythingFixture();
  fixture.everything = value;
  fixture.remoteThreads = [
    { activeRunId: "run-1", activityRunStatus: "running", status: "queued" },
    { activeRunId: null, status: "running" },
  ];
  await mountFooter(_fixture, 216, availableUpdateState);
  // Room above the footer for the card, which otherwise flips below the pill.
  _fixture.host!.style.marginTop = "120px";
  window.scrollTo(0, 0);
  const pill = page.getByRole("button", { name: /^Update: / });
  await pill.click();
  const cancel = page.getByRole("button", { name: "Cancel" });
  await expect.element(cancel).toBeVisible();
  const ask = document.querySelector<HTMLElement>("[data-update-ask]")!;
  expect(ask.textContent).toBe("Stops 2 running threadsCancelUpdate");
  expect(document.querySelector('[role="alertdialog"]')).toBeNull();
  // A small card above the pill, focused on Cancel and named by its question.
  await expect
    .poll(
      () =>
        ask.getBoundingClientRect().bottom <=
        (pill.element() as HTMLElement).getBoundingClientRect().top,
    )
    .toBe(true);
  await expect.poll(() => document.activeElement).toBe(cancel.element());
  const card = ask.closest<HTMLElement>("[aria-labelledby]")!;
  expect(document.getElementById(card.getAttribute("aria-labelledby")!)?.textContent).toBe(
    "Stops 2 running threads",
  );
  const update = page.getByRole("button", { name: "Update", exact: true });
  expect(run).not.toHaveBeenCalled();
  if (import.meta.env.VITE_SCIENT_SIDEBAR_SCREENSHOTS) {
    await page.screenshot({
      path: `${import.meta.env.VITE_SCIENT_SIDEBAR_SCREENSHOTS}/update-everything-ask.png`,
    });
  }

  await cancel.click();
  await expect.poll(() => document.querySelector("[data-update-ask]")).toBeNull();
  expect(run).not.toHaveBeenCalled();

  // Pressing the pill again cancels rather than asking again.
  await pill.click();
  await expect.element(cancel).toBeVisible();
  await pill.click();
  await expect.poll(() => document.querySelector("[data-update-ask]")).toBeNull();

  // Escape cancels and returns focus to the pill.
  await pill.click();
  await expect.poll(() => document.activeElement).toBe(cancel.element());
  await userEvent.keyboard("{Escape}");
  await expect.poll(() => document.querySelector("[data-update-ask]")).toBeNull();
  await expect.poll(() => document.activeElement).toBe(pill.element());

  // A question ends when Update stops running the pass, and does not come back on its own.
  await pill.click();
  await expect.element(cancel).toBeVisible();
  {
    using _clock = fakeTimers();
    await act(() =>
      setUpdateEverythingRun(() => ({
        localVersion: null,
        phase: "providers",
        restartAt: null,
        machines: [],
      })),
    );
    await vi.waitFor(() => expect(document.querySelector("[data-update-ask]")).toBeNull());
    await act(async () => {
      setUpdateEverythingRun(() => null);
      await vi.advanceTimersByTimeAsync(200);
    });
    expect(document.querySelector("[data-update-ask]")).toBeNull();
    expect(run).not.toHaveBeenCalled();
  }

  await pill.click();
  await update.click();
  await expect.poll(() => run.mock.calls.length).toBe(1);
  await expect.poll(() => document.querySelector("[data-update-ask]")).toBeNull();
  // The servers restart while they stop no more threads than the user agreed to.
  expect(run.mock.calls[0]![0].admitServer!(alvinServer as never)).toBe(true);
});
// SCIENT-FORK:END

// regression: 4b9f781edc fix(sidebar): keep update controls within narrow layouts
it("keeps all four utilities equally spaced and inset while updates are idle", async () => {
  await using _fixture = _createFixture();
  _fixture.cleanup.defer(() => _cleanupFixture0(_fixture));

  await mountFooter(_fixture, 216, {
    ...updateState,
    status: "idle",
    downloadedVersion: null,
    availableVersion: null,
  });
  await expect
    .element(page.getByRole("button", { name: "More sidebar actions", includeHidden: true }))
    .not.toBeVisible();
  const buttons = [
    ..._fixture.host!.querySelectorAll<HTMLButtonElement>('[data-sidebar="menu-button"]'),
  ].filter((button) => button.getClientRects().length);
  expect(buttons).toHaveLength(4);
  const rects = buttons.map((button) => button.getBoundingClientRect());
  expect(rects[0]!.left - _fixture.host!.getBoundingClientRect().left).toBe(12);
  expect(rects.slice(1).map((rect, index) => rect.left - rects[index]!.right)).toEqual([4, 4, 4]);
});

// regression: 4b9f781edc fix(sidebar): keep update controls within narrow layouts
it("shows a compact current-project tooltip with its keyboard shortcut", async () => {
  await using _fixture = _createFixture();
  _fixture.cleanup.defer(() => _cleanupFixture0(_fixture));

  _fixture.host = document.createElement("div");
  Object.assign(_fixture.host.style, { width: "280px", margin: "20px" });
  document.body.append(_fixture.host);
  _fixture.root0 = _fixture.stack.use(
    await _fixtureRender(null, { container: _fixture.host, router: false }),
  );
  await _fixture.root0.rerender(
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

function expectFooterInOrder(_fixture: _Fixture) {
  const footer = _fixture
    .host!.querySelector<HTMLElement>('[data-sidebar="footer"]')!
    .getBoundingClientRect();
  let previousRight = footer.left;
  for (const visible of [..._fixture.host!.querySelectorAll("button")].filter(
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
