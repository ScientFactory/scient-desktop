// @vitest-environment happy-dom
import { ProviderDriverKind, ProviderInstanceId, type ServerProvider } from "@t3tools/contracts";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";

import { DroidInlineSetup } from "./DroidInlineSetup";
import type { ProviderLifecycleController } from "./useProviderLifecycleController";

const controller = {
  startConnection: vi.fn(),
  cancelConnection: vi.fn(),
  submitAuthorizationCode: vi.fn(),
  disconnect: vi.fn(),
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

const render = (snapshot: ServerProvider, accountAction?: ReactNode) =>
  renderToStaticMarkup(
    <DroidInlineSetup
      accountAction={accountAction}
      controller={controller}
      displayName="Droid"
      provider={snapshot}
    />,
  );

describe("DroidInlineSetup", () => {
  it("uses the shared status icons instead of a separate Droid mark", () => {
    const snapshots = [
      {
        ...provider,
        installed: false,
        connection: {
          ...provider.connection!,
          runtime: {
            ...provider.connection!.runtime!,
            source: "missing" as const,
            actions: ["install" as const],
            managedVersion: null,
          },
        },
      },
      provider,
      {
        ...provider,
        status: "ready" as const,
        auth: { status: "authenticated" as const, required: true, label: "Factory account" },
        models: [{ slug: "auto", name: "Auto", isCustom: false, capabilities: null }],
      },
    ];

    const [missing, signIn, ready] = snapshots.map((snapshot) => render(snapshot));
    for (const markup of [missing!, signIn!, ready!]) {
      expect(markup).not.toContain("data-droid-provider-mark");
      expect(markup).not.toContain("[data-assisted-setup-icon=true]]:hidden");
    }
    // The Droid logo is the install and sign-in status icon; ready shows a check.
    expect(missing).toContain("lucide-shield-check");
    expect(signIn).toContain("lucide-shield-check");
    expect(ready).toContain("lucide-circle-check");
  });

  it("offers the capability-advertised Factory pairing action", () => {
    const markup = render(provider);

    expect(markup).toContain("Sign in required");
    expect(markup).toContain("Sign in with Factory");
    expect(markup).toContain("Scient never sees your password");
    expect(markup).toContain("border-transparent");
    expect(markup).toContain("text-primary");
    expect(markup).not.toContain("text-primary-foreground");
  });

  it("offers a quiet Check again beside sign-in, for a sign-in finished outside Scient", () => {
    const view = document.createElement("div");
    view.innerHTML = render(provider);
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
    view.innerHTML = render({
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

  it("represents Droid's provider-opened browser flow without inventing a URL or code", () => {
    const markup = render({
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

  it("keeps managed runtime recovery available without requiring account sign-in", () => {
    const markup = render({
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

    it("shows the runtime failure with its real error and a retry, not a sign-in state", () => {
      const markup = render(failed);

      expect(markup).toContain("Droid couldn’t start");
      expect(markup).toContain("Droid exited with code 3 before it was ready.");
      expect(markup).toContain('role="alert"');
      expect(markup).toContain('aria-label="Check Droid again"');
      expect(markup).toContain("Try again");
      expect(markup).not.toContain("Assisted sign in unavailable");
      expect(markup).not.toContain("Sign in");
      expect(markup).not.toContain("Factory subscription");
    });

    it("offers the installation's own update beside the retry", () => {
      const markup = render({
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

    it("offers a retry before Repair when a Scient-managed Droid did not start", () => {
      const view = document.createElement("div");
      view.innerHTML = render({
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

  it("does not suggest a subscription sign-in when Factory rejected FACTORY_API_KEY", () => {
    const message =
      "Factory rejected FACTORY_API_KEY: 401 Invalid API key. Correct the key in Droid's environment, then check again.";
    const markup = render({
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

  it("shows account actions only for a connected snapshot", () => {
    const markup = render(
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

  it("renders the composer's models action as the connected frame's action, and quietly elsewhere", () => {
    const renderWithModels = (snapshot: ServerProvider) =>
      renderToStaticMarkup(
        <DroidInlineSetup
          controller={controller}
          displayName="Droid"
          modelsActions={{
            primary: <button type="button">Connect models (primary)</button>,
            secondary: <button type="button">Connect models (secondary)</button>,
          }}
          provider={snapshot}
        />,
      );
    const connected = renderWithModels({
      ...provider,
      status: "ready",
      auth: { status: "authenticated", required: true, label: "Factory account" },
      models: [{ slug: "auto", name: "Auto", isCustom: false, capabilities: null }],
    });

    expect(connected.match(/data-provider-onboarding-view="assisted"/g)).toHaveLength(1);
    expect(connected).toMatch(/^<div[^>]*data-provider-onboarding-view="assisted"/);
    expect(connected).toMatch(
      /Droid is ready.*<button type="button">Connect models \(primary\)<\/button>/,
    );
    // Custom models need Droid, not a Factory account.
    expect(renderWithModels(provider)).toMatch(
      /Sign in with Factory.*<button type="button">Connect models \(secondary\)<\/button>/,
    );
    expect(renderWithModels({ ...provider, installed: false })).not.toContain("Connect models");
    expect(renderWithModels({ ...provider, probePending: true })).not.toContain("Connect models");
  });
});
