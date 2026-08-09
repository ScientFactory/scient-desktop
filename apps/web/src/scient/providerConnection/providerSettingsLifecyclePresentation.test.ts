import { ProviderDriverKind, ProviderInstanceId, type ServerProvider } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { providerSettingsLifecyclePresentation } from "./providerSettingsLifecyclePresentation";

const provider = (patch: Partial<ServerProvider> = {}): ServerProvider => ({
  instanceId: ProviderInstanceId.make("codex"),
  driver: ProviderDriverKind.make("codex"),
  displayName: "Codex",
  enabled: true,
  installed: false,
  version: null,
  status: "warning",
  auth: { status: "unauthenticated", required: true },
  checkedAt: "2026-08-09T08:00:00.000Z",
  models: [],
  slashCommands: [],
  skills: [],
  connection: { methods: ["codex_browser"], canDisconnect: false, operation: null },
  ...patch,
});

describe("provider settings lifecycle presentation", () => {
  it("offers installation when Codex is missing", () => {
    expect(providerSettingsLifecyclePresentation(provider(), "Codex")).toMatchObject({
      kind: "not-installed",
      statusLabel: "Not installed",
      actionLabel: "Install",
    });
  });

  it("offers sign in after installation", () => {
    expect(
      providerSettingsLifecyclePresentation(provider({ installed: true }), "Codex"),
    ).toMatchObject({ kind: "sign-in-required", actionLabel: "Sign in" });
  });

  it("reports managed installation progress without claiming readiness", () => {
    expect(
      providerSettingsLifecyclePresentation(
        provider({
          connection: {
            methods: ["codex_browser"],
            canDisconnect: false,
            operation: null,
            runtime: {
              source: "missing",
              supportTier: "fully_assisted",
              target: "darwin-arm64",
              actions: ["install"],
              managedVersion: null,
              previousManagedVersion: null,
              message: "Installing.",
              operation: {
                operationId: "runtime-1",
                action: "install",
                status: "installing",
                startedAt: "2026-08-09T08:00:00.000Z",
                finishedAt: null,
                message: "Installing Codex.",
              },
            },
          },
        }),
        "Codex",
      ),
    ).toMatchObject({ kind: "installing", statusLabel: "Installing", busy: true });
  });

  it("keeps an installation failure distinct from a missing runtime", () => {
    expect(
      providerSettingsLifecyclePresentation(
        provider({
          connection: {
            methods: ["codex_browser"],
            canDisconnect: false,
            operation: null,
            runtime: {
              source: "missing",
              supportTier: "fully_assisted",
              target: "darwin-arm64",
              actions: ["install"],
              managedVersion: null,
              previousManagedVersion: null,
              message: "Install available.",
              operation: {
                operationId: "runtime-1",
                action: "install",
                status: "failed",
                startedAt: "2026-08-09T08:00:00.000Z",
                finishedAt: "2026-08-09T08:01:00.000Z",
                message: "Verification failed.",
              },
            },
          },
        }),
        "Codex",
      ),
    ).toMatchObject({
      kind: "failed",
      statusLabel: "Setup failed",
      detail: "Verification failed.",
    });
  });

  it("shows an authenticated provider as ready and manageable", () => {
    expect(
      providerSettingsLifecyclePresentation(
        provider({ installed: true, auth: { status: "authenticated", label: "ChatGPT" } }),
        "Codex",
      ),
    ).toMatchObject({ kind: "ready", statusLabel: "Ready", actionLabel: "Manage" });
  });
});
