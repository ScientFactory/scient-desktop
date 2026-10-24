import { render as _fixtureRender } from "../../../test/render";
import type { ReactNode } from "react";
import { ProviderDriverKind, ProviderInstanceId, type ServerProvider } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import { DroidInlineSetup } from "./DroidInlineSetup";
import type { ProviderLifecycleController } from "./useProviderLifecycleController";

const controller = {
  startConnection: vi.fn(),
  cancelConnection: vi.fn(),
  submitAuthorizationCode: vi.fn(),
  disconnect: vi.fn(),
  signInKey: {
    environmentId: "environment-test",
    instanceId: "sign-in-test",
  } as ProviderLifecycleController["signInKey"],
  openAuthorizationPage: vi.fn(),
  planRuntime: vi.fn(),
  startRuntime: vi.fn(),
  cancelRuntime: vi.fn(),
  updateExternalRuntime: vi.fn(),
  refresh: vi.fn(),
} as unknown as ProviderLifecycleController;

const provider: ServerProvider = {
  instanceId: ProviderInstanceId.make("droid"),
  driver: ProviderDriverKind.make("droid"),
  displayName: "Droid",
  enabled: true,
  installed: true,
  version: "0.202.0",
  status: "warning",
  auth: { status: "unauthenticated", required: true },
  checkedAt: "2026-08-23T08:00:00.000Z",
  models: [],
  slashCommands: [],
  skills: [],
  connection: {
    methods: ["droid_device_pairing"],
    canDisconnect: false,
    operation: null,
    runtime: {
      source: "scient_managed",
      supportTier: "fully_assisted",
      target: "darwin-arm64",
      actions: ["repair", "remove"],
      managedVersion: "0.202.0",
      previousManagedVersion: null,
      operation: null,
      message: "Managed Droid is ready.",
    },
  },
};

const render = async (_fixture: _Fixture, snapshot: ServerProvider, accountAction?: ReactNode) =>
  await _renderMarkup(
    _fixture,
    <DroidInlineSetup
      accountAction={accountAction}
      controller={controller}
      displayName="Droid"
      provider={snapshot}
    />,
  );

describe("DroidInlineSetup", () => {
  it("offers the capability-advertised Factory pairing action", async () => {
    await using _fixture = _createFixture();
    vi.clearAllMocks();

    const markup = await render(_fixture, provider);

    expect(markup).toContain("Sign in required");
    expect(markup).toContain("Sign in with Factory");
    expect(markup).toContain("Scient never sees your password");
    expect(markup).toContain("border-transparent");
    expect(markup).toContain("text-primary");
    expect(markup).not.toContain("text-primary-foreground");
  });

  it("offers a quiet Check again beside sign-in, for a sign-in finished outside Scient", async () => {
    await using _fixture = _createFixture();
    vi.clearAllMocks();

    const view = document.createElement("div");
    view.innerHTML = await render(_fixture, provider);
    const buttons = [...view.querySelectorAll("button")];

    expect(buttons.map((button) => button.textContent?.trim())).toEqual([
      "Check again",
      "Sign in with Factory",
    ]);
    expect(buttons[0]!.getAttribute("aria-label")).toBe("Check Droid again");
    expect(buttons[0]!.dataset.variant).toBe("ghost-muted");
    // Sign in stays the frame's one primary action.
    expect(buttons[1]!.dataset.variant).toBe("ghost-primary");

    // Also after a sign-in attempt that did not finish here.
    view.innerHTML = await render(_fixture, {
      ...provider,
      connection: {
        ...provider.connection!,
        operation: {
          operationId: "droid-pairing",
          method: "droid_device_pairing",
          status: "failed",
          startedAt: "2026-08-23T08:00:00.000Z",
          finishedAt: "2026-08-23T08:01:00.000Z",
          message: "The sign-in window was closed.",
        },
      },
    });
    expect(view.textContent).toContain("Droid sign-in didn’t finish");
    expect(view.querySelector('button[aria-label="Check Droid again"]')).not.toBeNull();
  });

  it("represents Droid's provider-opened browser flow without inventing a URL or code", async () => {
    await using _fixture = _createFixture();
    vi.clearAllMocks();

    const markup = await render(_fixture, {
      ...provider,
      connection: {
        ...provider.connection!,
        operation: {
          operationId: "droid-pairing",
          method: "droid_device_pairing",
          status: "waiting_for_browser",
          startedAt: "2026-08-23T08:00:00.000Z",
          finishedAt: null,
          message: "Finish signing in securely in your browser.",
        },
      },
    });

    expect(markup).toContain("Finish sign in");
    expect(markup).toContain("browser opened by Droid");
    expect(markup).toContain("Cancel sign in");
    expect(markup).not.toContain("Reopen");
    expect(markup).not.toContain("authorization code");
  });

  it("keeps managed runtime recovery available without requiring account sign-in", async () => {
    await using _fixture = _createFixture();
    vi.clearAllMocks();

    const markup = await render(_fixture, {
      ...provider,
      status: "error",
      auth: { status: "unknown", required: true },
      message: "Droid CLI is installed but ACP startup failed.",
    });

    expect(markup).toContain("Droid needs repair");
    expect(markup).toContain("Repair Droid");
    expect(markup).not.toContain("Sign in with Factory");
  });

  describe("a status check that failed on a system installation", () => {
    const failed: ServerProvider = {
      ...provider,
      status: "error",
      auth: { status: "unknown" },
      message:
        "Droid CLI is installed but ACP startup failed: Droid exited with code 3 before it was ready.",
      connection: {
        ...provider.connection!,
        // No account capabilities were read, so no sign-in method is offered.
        methods: [],
        runtime: {
          ...provider.connection!.runtime!,
          source: "system",
          actions: [],
          managedVersion: null,
        },
      },
    };

    it("shows the runtime failure with its real error and a retry, not a sign-in state", async () => {
      await using _fixture = _createFixture();
      vi.clearAllMocks();

      const markup = await render(_fixture, failed);

      expect(markup).toContain("Droid couldn’t start");
      expect(markup).toContain("Droid exited with code 3 before it was ready.");
      expect(markup).toContain('role="alert"');
      expect(markup).toContain('aria-label="Check Droid again"');
      expect(markup).toContain("Try again");
      expect(markup).not.toContain("Assisted sign in unavailable");
      expect(markup).not.toContain("Sign in");
      expect(markup).not.toContain("Factory subscription");
    });

    it("offers the installation's own update beside the retry", async () => {
      await using _fixture = _createFixture();
      vi.clearAllMocks();

      const markup = await render(_fixture, {
        ...failed,
        version: "0.202.0",
        versionAdvisory: {
          status: "behind_latest",
          currentVersion: "0.202.0",
          latestVersion: "0.230.0",
          updateCommand: "droid update",
          canUpdate: true,
          canInstallVersion: false,
          checkedAt: failed.checkedAt,
          message: "Droid 0.230.0 is available.",
        },
      });

      expect(markup).toContain("Droid couldn’t start");
      expect(markup).toContain('aria-label="Update Droid"');
      expect(markup).toContain('aria-label="Check Droid again"');
    });

    it("offers a retry before Repair when a Scient-managed Droid did not start", async () => {
      await using _fixture = _createFixture();
      vi.clearAllMocks();

      const view = document.createElement("div");
      view.innerHTML = await render(_fixture, {
        ...failed,
        connection: {
          ...failed.connection!,
          runtime: {
            ...failed.connection!.runtime!,
            source: "scient_managed",
            actions: ["repair", "remove"],
            managedVersion: "0.202.0",
          },
        },
      });
      const buttons = [...view.querySelectorAll("button")].filter(
        (button) => !button.closest("details"),
      );

      expect(view.textContent).toContain("Droid needs repair");
      // The reason is shown: a start that failed once may not need a download.
      expect(view.textContent).toContain("Droid exited with code 3 before it was ready.");
      expect(buttons.map((button) => button.textContent?.trim())).toEqual([
        "Try again",
        "Repair Droid",
      ]);
      expect(buttons[0]!.getAttribute("aria-label")).toBe("Check Droid again");
      expect(buttons[0]!.dataset.variant).toBe("ghost-muted");
      expect(buttons[1]!.dataset.variant).toBe("ghost-primary");
    });
  });

  it("does not suggest a subscription sign-in when Factory rejected FACTORY_API_KEY", async () => {
    await using _fixture = _createFixture();
    vi.clearAllMocks();

    const message =
      "Factory rejected FACTORY_API_KEY: 401 Invalid API key. Correct the key in Droid's environment, then check again.";
    const markup = await render(_fixture, {
      ...provider,
      auth: { status: "unauthenticated", required: true, type: "apiKey" },
      message,
      // The key is the environment's: Scient offers no sign-in that would replace it.
      connection: { ...provider.connection!, methods: [] },
    });

    expect(markup).toContain("Factory rejected the API key");
    expect(markup).toContain("401 Invalid API key");
    expect(markup).toContain('aria-label="Check Droid again"');
    expect(markup).not.toContain("Assisted sign in unavailable");
    expect(markup).not.toContain("Sign in with Factory");
    expect(markup).not.toContain("Factory subscription");
  });

  it("shows account actions only for a connected snapshot", async () => {
    await using _fixture = _createFixture();
    vi.clearAllMocks();

    const markup = await render(
      _fixture,
      {
        ...provider,
        status: "ready",
        auth: { status: "authenticated", required: true, label: "Factory account" },
        models: [
          {
            slug: "auto",
            name: "Auto",
            isCustom: false,
            capabilities: null,
          },
        ],
      },
      <button type="button">Sign out</button>,
    );

    expect(markup).toContain("Droid is ready");
    expect(markup).toContain("Factory account");
    expect(markup).toContain("Sign out");
  });
});

function _createFixture() {
  const stack = new AsyncDisposableStack();
  return { stack, [Symbol.asyncDispose]: () => stack.disposeAsync() };
}
type _Fixture = ReturnType<typeof _createFixture>;

async function _renderMarkup(_fixture: _Fixture, ui: ReactNode): Promise<string> {
  const screen = _fixture.stack.use(await _fixtureRender(ui, { router: false }));
  return screen.container.innerHTML;
}
