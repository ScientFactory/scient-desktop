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
  it("keeps the Droid mark mounted across composer lifecycle states", () => {
    const snapshots = [
      { ...provider, enabled: false },
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

    for (const snapshot of snapshots) {
      expect(render(snapshot)).toContain('data-droid-provider-mark="true"');
    }
  });

  it("offers the capability-advertised Factory pairing action", () => {
    const markup = render(provider);

    expect(markup).toContain("Sign in required");
    expect(markup).toContain("Sign in with Factory");
    expect(markup).toContain("Scient never sees your password");
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
});
