import {
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderRuntimeOperation,
  type ServerProvider,
} from "@t3tools/contracts";
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

function presentingOperation(patch: Partial<ProviderRuntimeOperation>) {
  return providerSettingsLifecyclePresentation(
    provider({
      connection: {
        methods: [],
        canDisconnect: false,
        operation: null,
        runtime: {
          source: "missing",
          supportTier: "fully_assisted",
          target: "darwin-arm64",
          actions: ["install"],
          managedVersion: null,
          previousManagedVersion: null,
          message: "Working.",
          operation: {
            operationId: "runtime-1",
            action: "install",
            status: "downloading",
            startedAt: "2026-09-04T00:00:00.000Z",
            finishedAt: null,
            message: "Working.",
            ...patch,
          },
        },
      },
    }),
    "Codex",
  );
}

describe("provider settings lifecycle presentation", () => {
  it("offers installation when Codex is missing", () => {
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
              operation: null,
              message: "Install available.",
            },
          },
        }),
        "Codex",
      ),
    ).toMatchObject({
      kind: "not-installed",
      statusLabel: "Not installed",
      actionLabel: "Install",
      actionKind: "runtime",
      runtimeAction: "install",
    });
  });

  it("does not advertise installation without an explicit runtime capability", () => {
    expect(providerSettingsLifecyclePresentation(provider(), "Codex")).toMatchObject({
      kind: "not-installed",
      actionLabel: "Manage",
      actionKind: "manage",
      runtimeAction: null,
    });
  });

  it.each([
    ["codex", "Codex"],
    ["claudeAgent", "Claude"],
    ["antigravity", "Antigravity"],
    ["cursor", "Cursor"],
    ["droid", "Droid"],
    ["grok", "Grok"],
    ["opencode", "OpenCode"],
  ] as const)("routes disabled %s through its management card", (driver, displayName) => {
    expect(
      providerSettingsLifecyclePresentation(
        provider({
          driver: ProviderDriverKind.make(driver),
          displayName,
          enabled: false,
        }),
        displayName,
      ),
    ).toMatchObject({
      kind: "disabled",
      actionLabel: "Manage",
      actionKind: "manage",
    });
  });

  it.each([
    ["codex", "Codex"],
    ["claudeAgent", "Claude"],
    ["antigravity", "Antigravity"],
    ["cursor", "Cursor"],
    ["droid", "Droid"],
    ["grok", "Grok"],
  ] as const)(
    "suppresses provisional lifecycle actions while %s is being checked",
    (driver, displayName) => {
      expect(
        providerSettingsLifecyclePresentation(
          provider({
            driver: ProviderDriverKind.make(driver),
            displayName,
            probePending: true,
            connection: {
              methods: [],
              canDisconnect: false,
              operation: null,
              runtime: {
                source: "system",
                supportTier: "fully_assisted",
                target: "darwin-arm64",
                actions: ["install"],
                managedVersion: null,
                previousManagedVersion: null,
                operation: null,
                message: "System runtime detected.",
              },
            },
          }),
          displayName,
        ),
      ).toEqual({
        kind: "checking",
        statusLabel: null,
        detail: null,
        actionKind: null,
        actionLabel: null,
        runtimeAction: null,
        busy: true,
      });
    },
  );

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

  it("prioritizes a server-advertised managed update", () => {
    expect(
      providerSettingsLifecyclePresentation(
        provider({
          installed: true,
          status: "ready",
          auth: { status: "authenticated", required: true, label: "ChatGPT" },
          models: [{ slug: "gpt-5", name: "GPT-5", isCustom: false, capabilities: null }],
          connection: {
            methods: ["codex_browser"],
            canDisconnect: true,
            operation: null,
            runtime: {
              source: "scient_managed",
              supportTier: "fully_assisted",
              target: "darwin-arm64",
              actions: ["update", "repair", "remove"],
              managedVersion: "0.147.0",
              previousManagedVersion: null,
              operation: null,
              message: "Update available.",
            },
          },
        }),
        "Codex",
      ),
    ).toMatchObject({
      kind: "attention",
      actionLabel: "Update",
      actionKind: "runtime",
      runtimeAction: "update",
    });
  });

  it("keeps external updates distinct from managed runtime plans", () => {
    expect(
      providerSettingsLifecyclePresentation(
        provider({
          installed: true,
          status: "ready",
          auth: { status: "authenticated", required: true, label: "ChatGPT" },
          models: [{ slug: "gpt-5", name: "GPT-5", isCustom: false, capabilities: null }],
          versionAdvisory: {
            status: "behind_latest",
            currentVersion: "0.147.0",
            latestVersion: "0.148.0",
            updateCommand: "npm update -g @openai/codex",
            canUpdate: true,
            checkedAt: "2026-08-23T08:00:00.000Z",
            message: "Update available.",
          },
        }),
        "Codex",
      ),
    ).toMatchObject({
      actionLabel: "Update",
      actionKind: "external-update",
      runtimeAction: null,
    });
  });

  it("never offers the external updater for an active Scient-managed runtime", () => {
    expect(
      providerSettingsLifecyclePresentation(
        provider({
          installed: true,
          status: "ready",
          auth: { status: "authenticated", required: true, label: "ChatGPT" },
          models: [{ slug: "gpt-5", name: "GPT-5", isCustom: false, capabilities: null }],
          versionAdvisory: {
            status: "behind_latest",
            currentVersion: "0.147.0",
            latestVersion: "0.148.0",
            updateCommand: "npm update -g @openai/codex",
            canUpdate: true,
            checkedAt: "2026-08-23T08:00:00.000Z",
            message: "External update available.",
          },
          connection: {
            methods: ["codex_browser"],
            canDisconnect: true,
            operation: null,
            runtime: {
              source: "scient_managed",
              supportTier: "fully_assisted",
              target: "darwin-arm64",
              actions: ["repair", "remove"],
              managedVersion: "0.147.0",
              previousManagedVersion: null,
              operation: null,
              message: "Managed Codex is ready.",
            },
          },
        }),
        "Codex",
      ),
    ).toMatchObject({ kind: "ready", actionKind: "manage", actionLabel: "Manage" });
  });

  it("routes a broken managed runtime to repair before account setup", () => {
    expect(
      providerSettingsLifecyclePresentation(
        provider({
          installed: true,
          status: "error",
          auth: { status: "unknown", required: true },
          message: "Codex could not start.",
          connection: {
            methods: ["codex_browser"],
            canDisconnect: false,
            operation: null,
            runtime: {
              source: "scient_managed",
              supportTier: "fully_assisted",
              target: "darwin-arm64",
              actions: ["repair", "remove"],
              managedVersion: "0.147.0",
              previousManagedVersion: null,
              operation: null,
              message: "Managed Codex needs repair.",
            },
          },
        }),
        "Codex",
      ),
    ).toMatchObject({
      kind: "attention",
      statusLabel: "Runtime needs repair",
      actionKind: "runtime",
      runtimeAction: "repair",
    });
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
    ).toMatchObject({
      kind: "installing",
      statusLabel: "Installing",
      actionLabel: "Installing",
      actionKind: "continue",
      runtimeAction: null,
      busy: true,
    });
  });

  it.each([
    ["install", "Installing"],
    ["update", "Updating"],
    ["repair", "Repairing"],
    ["remove", "Removing"],
  ] as const)("uses one concise action label throughout %s", (action, label) => {
    for (const status of ["preparing", "downloading", "installing", "activating"] as const) {
      expect(presentingOperation({ action, status })).toMatchObject({
        actionLabel: label,
        statusLabel: label,
        runtimeAction: null,
        busy: true,
      });
    }
  });

  it.each(["verifying", "testing"] as const)(
    "shows Verifying for %s, not a leftover download percentage",
    (status) => {
      const presentation = presentingOperation({ status, downloadedBytes: 100, totalBytes: 100 });
      expect(presentation).toMatchObject({ actionLabel: "Verifying", busy: true });
      expect(presentation.downloadPercent).toBeUndefined();
    },
  );

  it.each([
    [0, 100, 0],
    [42, 100, 42],
    [999, 1000, 99],
    [100, 100, 100],
    [110, 100, 100],
    [undefined, 100, undefined],
    [42, undefined, undefined],
    [42, 0, undefined],
    [NaN, 100, undefined],
    [42, Infinity, undefined],
  ])(
    "reports only meaningful download bytes (%s / %s)",
    (downloadedBytes, totalBytes, expected) => {
      const presentation = presentingOperation({
        ...(downloadedBytes !== undefined ? { downloadedBytes } : {}),
        ...(totalBytes !== undefined ? { totalBytes } : {}),
      });
      expect(presentation.downloadPercent).toBe(expected);
      expect(presentation.busy).toBe(true);
      expect(presentation.actionLabel).toBe("Installing");
    },
  );

  it.each(["preparing", "installing", "activating", "succeeded", "failed", "cancelled"] as const)(
    "never treats download bytes as overall progress during %s",
    (status) => {
      expect(
        presentingOperation({ status, downloadedBytes: 100, totalBytes: 100 }).downloadPercent,
      ).toBeUndefined();
    },
  );

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
      actionLabel: "Failed",
      actionKind: "manage",
      runtimeAction: null,
    });
  });

  it("does not retry a failed runtime action the server no longer advertises", () => {
    expect(
      providerSettingsLifecyclePresentation(
        provider({
          installed: true,
          connection: {
            methods: ["codex_browser"],
            canDisconnect: false,
            operation: null,
            runtime: {
              source: "system",
              supportTier: "fully_assisted",
              target: "darwin-arm64",
              actions: [],
              managedVersion: null,
              previousManagedVersion: null,
              message: "System runtime is active.",
              operation: {
                operationId: "runtime-2",
                action: "repair",
                status: "failed",
                startedAt: "2026-08-09T08:00:00.000Z",
                finishedAt: "2026-08-09T08:01:00.000Z",
                message: "Repair is unavailable.",
              },
            },
          },
        }),
        "Codex",
      ),
    ).toMatchObject({
      kind: "failed",
      actionKind: "manage",
      runtimeAction: null,
    });
  });

  it("does not retry failed sign-in after the server withdraws every sign-in method", () => {
    expect(
      providerSettingsLifecyclePresentation(
        provider({
          installed: true,
          connection: {
            methods: [],
            canDisconnect: false,
            operation: {
              operationId: "connection-1",
              method: "codex_browser",
              status: "failed",
              startedAt: "2026-08-09T08:00:00.000Z",
              finishedAt: "2026-08-09T08:01:00.000Z",
              message: "Sign-in method is no longer available.",
            },
          },
        }),
        "Codex",
      ),
    ).toMatchObject({
      kind: "failed",
      actionKind: "manage",
      actionLabel: "Manage",
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
