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

  it("offers installation when runtime discovery is missing even if readiness is stale", () => {
    expect(
      providerSettingsLifecyclePresentation(
        provider({
          installed: true,
          status: "ready",
          auth: { status: "authenticated", label: "ChatGPT" },
          connection: {
            methods: ["codex_browser"],
            canDisconnect: true,
            operation: null,
            runtime: {
              source: "missing",
              supportTier: "fully_assisted",
              target: "darwin-arm64",
              actions: ["install"],
              managedVersion: null,
              previousManagedVersion: "0.147.0",
              operation: null,
              message: "Install available.",
            },
          },
        }),
        "Codex",
      ),
    ).toMatchObject({ kind: "not-installed", actionLabel: "Install" });
  });

  it("offers sign in after installation", () => {
    expect(
      providerSettingsLifecyclePresentation(provider({ installed: true }), "Codex"),
    ).toMatchObject({ kind: "sign-in-required", actionLabel: "Sign in" });
  });

  it("uses concise Factory subscription guidance for Droid pairing", () => {
    expect(
      providerSettingsLifecyclePresentation(
        provider({
          driver: ProviderDriverKind.make("droid"),
          displayName: "Droid",
          installed: true,
          connection: {
            methods: ["droid_device_pairing"],
            canDisconnect: false,
            operation: null,
          },
        }),
        "Droid",
      ),
    ).toMatchObject({
      kind: "sign-in-required",
      detail: "Sign in with your existing Factory subscription.",
      actionLabel: "Sign in",
    });
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
        provider({
          installed: true,
          status: "ready",
          auth: { status: "authenticated", label: "ChatGPT" },
          models: [
            {
              slug: "gpt-5",
              name: "GPT-5",
              isCustom: false,
              capabilities: null,
            },
          ],
        }),
        "Codex",
      ),
    ).toMatchObject({ kind: "ready", statusLabel: "Ready", actionLabel: "Manage" });
  });

  it("does not let a stale sign-in operation override confirmed readiness", () => {
    expect(
      providerSettingsLifecyclePresentation(
        provider({
          installed: true,
          status: "ready",
          auth: { status: "authenticated", label: "Google account" },
          models: [
            {
              slug: "gemini-3.7-flash",
              name: "Gemini 3.7 Flash",
              isCustom: false,
              capabilities: null,
            },
          ],
          connection: {
            methods: ["antigravity_google"],
            canDisconnect: true,
            operation: {
              operationId: "stale-sign-in",
              method: "antigravity_google",
              status: "waiting_for_browser",
              startedAt: "2026-08-22T08:00:00.000Z",
              finishedAt: null,
              message: "Finish Google sign-in.",
            },
          },
        }),
        "Antigravity",
      ),
    ).toMatchObject({ kind: "ready", statusLabel: "Ready", actionLabel: "Manage" });
  });

  it("does not call a connected provider ready until it has a usable model", () => {
    expect(
      providerSettingsLifecyclePresentation(
        provider({
          installed: true,
          auth: { status: "authenticated", label: "Claude subscription" },
          message: "Claude is signed in, but model discovery failed.",
        }),
        "Claude",
      ),
    ).toMatchObject({
      kind: "attention",
      statusLabel: "Needs attention",
      detail: "Claude is signed in, but model discovery failed.",
    });
  });
});
