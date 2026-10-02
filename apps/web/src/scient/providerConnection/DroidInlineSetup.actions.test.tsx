// @vitest-environment happy-dom
import { ProviderDriverKind, ProviderInstanceId, type ServerProvider } from "@t3tools/contracts";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { DroidInlineSetup } from "./DroidInlineSetup";
import type { ProviderLifecycleController } from "./useProviderLifecycleController";

const refresh = vi.fn();
const startConnection = vi.fn();
const planRuntime = vi.fn();
const controller = {
  startConnection,
  cancelConnection: vi.fn(),
  submitAuthorizationCode: vi.fn(),
  disconnect: vi.fn(),
  openAuthorizationPage: vi.fn(),
  planRuntime,
  startRuntime: vi.fn(),
  cancelRuntime: vi.fn(),
  updateExternalRuntime: vi.fn(),
  refresh,
} satisfies ProviderLifecycleController;

const failed: ServerProvider = {
  instanceId: ProviderInstanceId.make("droid"),
  driver: ProviderDriverKind.make("droid"),
  displayName: "Droid",
  enabled: true,
  installed: true,
  version: "0.230.0",
  status: "error",
  auth: { status: "unknown" },
  message:
    "Droid CLI is installed but ACP startup failed: Droid exited with code 3 before it was ready.",
  checkedAt: "2026-10-01T08:00:00.000Z",
  models: [],
  slashCommands: [],
  skills: [],
  connection: {
    methods: [],
    canDisconnect: false,
    operation: null,
    runtime: {
      source: "system",
      supportTier: "fully_assisted",
      target: "darwin-arm64",
      actions: [],
      managedVersion: null,
      previousManagedVersion: null,
      operation: null,
      message: "Scient is using the healthy Droid runtime already installed on this computer.",
    },
  },
};

describe("DroidInlineSetup status checks", () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    refresh.mockReset();
    startConnection.mockReset();
    planRuntime.mockReset();
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
  });
  afterEach(async () => {
    await act(() => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
  });

  const mount = (provider: ServerProvider) =>
    act(() =>
      root.render(
        <DroidInlineSetup controller={controller} displayName="Droid" provider={provider} />,
      ),
    );
  const checkAgain = () =>
    [...host.querySelectorAll("button")].find(
      (button) => button.getAttribute("aria-label") === "Check Droid again",
    );

  it("runs one status check when a failed start is retried", async () => {
    let settle: (provider: ServerProvider) => void = () => undefined;
    refresh.mockReturnValue(new Promise<ServerProvider>((resolve) => (settle = resolve)));
    await mount(failed);

    await act(async () => checkAgain()!.click());
    expect(refresh).toHaveBeenCalledTimes(1);
    // Busy while the check runs: a second click cannot start another Droid session.
    expect(checkAgain()!.disabled).toBe(true);
    expect(host.textContent).toContain("Droid couldn’t start");

    await act(async () => settle(failed));
    expect(checkAgain()!.disabled).toBe(false);
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("checks the account once from the sign-in state, without starting a sign-in", async () => {
    const signedOut: ServerProvider = {
      ...failed,
      status: "warning",
      auth: { status: "unauthenticated", required: true },
      message: "Droid is installed. Sign in with your existing Factory subscription.",
      connection: { ...failed.connection!, methods: ["droid_device_pairing"] },
    };
    refresh.mockResolvedValue(signedOut);
    await mount(signedOut);
    expect(host.textContent).toContain("Sign in required");

    await act(async () => checkAgain()!.click());
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(startConnection).not.toHaveBeenCalled();
    // Still signed out: the sign-in state stays, ready for another check.
    expect(host.textContent).toContain("Sign in required");
    expect(checkAgain()!.disabled).toBe(false);

    // A check that could not run is not a sign-in that did not finish.
    refresh.mockRejectedValue(new Error("The provider service is unavailable. Try again."));
    await act(async () => checkAgain()!.click());
    expect(host.textContent).toContain("The provider service is unavailable. Try again.");
    expect(host.textContent).toContain("Sign in required");
    expect(host.textContent).not.toContain("Droid sign-in didn’t finish");
  });

  it("retries a Scient-managed Droid's start with one check, without a runtime download", async () => {
    const managed: ServerProvider = {
      ...failed,
      connection: {
        ...failed.connection!,
        runtime: {
          ...failed.connection!.runtime!,
          source: "scient_managed",
          actions: ["repair", "remove"],
          managedVersion: "0.230.0",
        },
      },
    };
    refresh.mockResolvedValue(managed);
    await mount(managed);
    expect(host.textContent).toContain("Droid needs repair");

    await act(async () => checkAgain()!.click());
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(planRuntime).not.toHaveBeenCalled();
    // Still failing: Repair stays available beside another try.
    expect(host.textContent).toContain("Repair Droid");
    expect(checkAgain()!.disabled).toBe(false);
  });

  it("says when the check itself could not run", async () => {
    refresh.mockRejectedValue(new Error("The provider service is unavailable. Try again."));
    await mount(failed);

    await act(async () => checkAgain()!.click());
    expect(host.textContent).toContain("The provider service is unavailable. Try again.");
    expect(checkAgain()!.disabled).toBe(false);
  });
});
