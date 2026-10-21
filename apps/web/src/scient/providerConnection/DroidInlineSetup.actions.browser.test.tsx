import { render as _fixtureRender, type Screen, act } from "../../../test/render";
import { ProviderDriverKind, ProviderInstanceId, type ServerProvider } from "@t3tools/contracts";

import { describe, expect, it, vi } from "vite-plus/test";

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
  signInKey: {
    environmentId: "environment-test",
    instanceId: "sign-in-test",
  } as ProviderLifecycleController["signInKey"],
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
  async function _setupFixture0(_fixture: _Fixture) {
    refresh.mockReset();
    startConnection.mockReset();
    planRuntime.mockReset();
    _fixture.host = document.createElement("div");
    document.body.append(_fixture.host);
    _fixture.root0 = _fixture.stack.use(
      await _fixtureRender(null, { container: _fixture.host, router: false }),
    );
  }
  async function _cleanupFixture1(_fixture: _Fixture) {
    await act(async () => await _fixture.root0.unmount());
    _fixture.host.remove();
    vi.unstubAllGlobals();
  }

  const mount = async (_fixture: _Fixture, provider: ServerProvider) =>
    await act(
      async () =>
        await _fixture.root0.rerender(
          <DroidInlineSetup controller={controller} displayName="Droid" provider={provider} />,
        ),
    );
  const checkAgain = (_fixture: _Fixture) =>
    [..._fixture.host.querySelectorAll("button")].find(
      (button) => button.getAttribute("aria-label") === "Check Droid again",
    );

  it("runs one status check when a failed start is retried", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    let settle: (provider: ServerProvider) => void = () => undefined;
    refresh.mockReturnValue(new Promise<ServerProvider>((resolve) => (settle = resolve)));
    await mount(_fixture, failed);

    await act(async () => checkAgain(_fixture)!.click());
    expect(refresh).toHaveBeenCalledTimes(1);
    // Busy while the check runs: a second click cannot start another Droid session.
    expect(checkAgain(_fixture)!.disabled).toBe(true);
    expect(_fixture.host.textContent).toContain("Droid couldn’t start");

    await act(async () => settle(failed));
    expect(checkAgain(_fixture)!.disabled).toBe(false);
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("checks the account once from the sign-in state, without starting a sign-in", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    const signedOut: ServerProvider = {
      ...failed,
      status: "warning",
      auth: { status: "unauthenticated", required: true },
      message: "Droid is installed. Sign in with your existing Factory subscription.",
      connection: { ...failed.connection!, methods: ["droid_device_pairing"] },
    };
    refresh.mockResolvedValue(signedOut);
    await mount(_fixture, signedOut);
    expect(_fixture.host.textContent).toContain("Sign in required");

    await act(async () => checkAgain(_fixture)!.click());
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(startConnection).not.toHaveBeenCalled();
    // Still signed out: the sign-in state stays, ready for another check.
    expect(_fixture.host.textContent).toContain("Sign in required");
    expect(checkAgain(_fixture)!.disabled).toBe(false);

    // A check that could not run is not a sign-in that did not finish.
    refresh.mockRejectedValue(new Error("The provider service is unavailable. Try again."));
    await act(async () => checkAgain(_fixture)!.click());
    expect(_fixture.host.textContent).toContain("The provider service is unavailable. Try again.");
    expect(_fixture.host.textContent).toContain("Sign in required");
    expect(_fixture.host.textContent).not.toContain("Droid sign-in didn’t finish");
  });

  it("retries a Scient-managed Droid's start with one check, without a runtime download", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

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
    await mount(_fixture, managed);
    expect(_fixture.host.textContent).toContain("Droid needs repair");

    await act(async () => checkAgain(_fixture)!.click());
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(planRuntime).not.toHaveBeenCalled();
    // Still failing: Repair stays available beside another try.
    expect(_fixture.host.textContent).toContain("Repair Droid");
    expect(checkAgain(_fixture)!.disabled).toBe(false);
  });

  it("says when the check itself could not run", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    refresh.mockRejectedValue(new Error("The provider service is unavailable. Try again."));
    await mount(_fixture, failed);

    await act(async () => checkAgain(_fixture)!.click());
    expect(_fixture.host.textContent).toContain("The provider service is unavailable. Try again.");
    expect(checkAgain(_fixture)!.disabled).toBe(false);
  });
});

function _createFixture() {
  const stack = new AsyncDisposableStack();
  const cleanup = new AsyncDisposableStack();
  return {
    host: undefined! as HTMLDivElement,
    stack,
    cleanup,
    root0: undefined! as Screen,
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
