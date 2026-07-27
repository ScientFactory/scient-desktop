// FILE: providerUpdates.test.ts
// Purpose: Covers provider-update filtering shared by notifications and settings.
// Layer: Web utility tests
// Exports: Vitest suites for providerUpdates.ts

import type { ProviderKind, ServerProviderStatus, ServerSettings } from "@synara/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  getVisibleProviderUpdateStatuses,
  hasConfirmedProviderUpdate,
  isProviderUpdateActive,
  providerUpdateSummaryStatus,
  providerUpdateNotificationKey,
  shouldOfferProviderUpdateAction,
  shouldShowProviderUpdateStatus,
  withProviderUpdateTimeout,
} from "./providerUpdates";

afterEach(() => {
  vi.useRealTimers();
});

function providerStatus(
  provider: ProviderKind,
  overrides: Partial<ServerProviderStatus> = {},
): ServerProviderStatus {
  return {
    provider,
    status: "ready",
    available: true,
    authStatus: "authenticated",
    version: "1.0.0",
    checkedAt: "2026-06-10T10:00:00.000Z",
    versionAdvisory: {
      status: "behind_latest",
      currentVersion: "1.0.0",
      latestVersion: "1.1.0",
      updateCommand: "npm install -g provider@latest",
      canUpdate: true,
      checkedAt: "2026-06-10T10:00:00.000Z",
      message: "Update available.",
    },
    ...overrides,
  };
}

function serverSettings(overrides: Partial<ServerSettings["providers"]> = {}): ServerSettings {
  const provider = {
    enabled: true,
    binaryPath: "",
    customModels: [],
  };

  return {
    telemetryPrivacyLevel: "essential",
    enableAssistantStreaming: false,
    enableProviderUpdateChecks: true,
    defaultThreadEnvMode: "local",
    addProjectBaseDirectory: "",
    textGenerationModelSelection: { provider: "codex", model: "gpt-5.4-mini" },
    providers: {
      codex: { ...provider, binaryPath: "codex", homePath: "" },
      claudeAgent: { ...provider, binaryPath: "claude", launchArgs: "" },
      cursor: { ...provider, binaryPath: "cursor-agent", apiEndpoint: "" },
      antigravity: { ...provider, binaryPath: "agy" },
      grok: { ...provider, binaryPath: "grok" },
      droid: { ...provider, binaryPath: "droid" },
      kilo: { ...provider, binaryPath: "kilo", serverUrl: "", serverPassword: "" },
      opencode: {
        ...provider,
        binaryPath: "opencode",
        serverUrl: "",
        serverPassword: "",
        experimentalWebSockets: false,
      },
      pi: { ...provider, binaryPath: "pi", agentDir: "" },
      ...overrides,
    },
    skills: { disabled: [], scientBuiltInActivationOverrides: [] },
  };
}

describe("getVisibleProviderUpdateStatuses", () => {
  it("excludes providers hidden from Synara so unchecked providers do not nag", () => {
    const result = getVisibleProviderUpdateStatuses({
      providers: [providerStatus("codex"), providerStatus("pi")],
      hiddenProviders: ["pi"],
      serverSettings: serverSettings(),
    });

    expect(result.map((provider) => provider.provider)).toEqual(["codex"]);
  });

  it("excludes server-disabled providers", () => {
    const result = getVisibleProviderUpdateStatuses({
      providers: [providerStatus("codex"), providerStatus("pi")],
      serverSettings: serverSettings({
        pi: { enabled: false, binaryPath: "pi", agentDir: "", customModels: [] },
      }),
    });

    expect(result.map((provider) => provider.provider)).toEqual(["codex"]);
  });

  it("waits for server settings before showing provider updates", () => {
    const result = getVisibleProviderUpdateStatuses({
      providers: [providerStatus("codex")],
      serverSettings: null,
    });

    expect(result).toEqual([]);
  });

  it("excludes provider updates when automatic update checks are disabled", () => {
    const result = getVisibleProviderUpdateStatuses({
      providers: [providerStatus("codex")],
      serverSettings: { ...serverSettings(), enableProviderUpdateChecks: false },
    });

    expect(result).toEqual([]);
  });

  it("can narrow notifications to one-click updates while settings keep manual updates visible", () => {
    const manualOnly = providerStatus("pi", {
      versionAdvisory: {
        status: "behind_latest",
        currentVersion: "1.0.0",
        latestVersion: "1.1.0",
        updateCommand: null,
        canUpdate: false,
        checkedAt: "2026-06-10T10:00:00.000Z",
        message: "Update available.",
      },
    });

    expect(
      getVisibleProviderUpdateStatuses({
        providers: [providerStatus("codex"), manualOnly],
        serverSettings: serverSettings(),
      }).map((provider) => provider.provider),
    ).toEqual(["codex", "pi"]);
    expect(
      getVisibleProviderUpdateStatuses({
        providers: [providerStatus("codex"), manualOnly],
        serverSettings: serverSettings(),
        oneClickOnly: true,
      }).map((provider) => provider.provider),
    ).toEqual(["codex"]);
  });
});

describe("providerUpdateNotificationKey", () => {
  it("keys by provider/version and ignores ordering", () => {
    const left = providerUpdateNotificationKey([
      providerStatus("pi", {
        versionAdvisory: {
          ...providerStatus("pi").versionAdvisory!,
          latestVersion: "2.0.0",
        },
      }),
      providerStatus("codex"),
    ]);
    const right = providerUpdateNotificationKey([
      providerStatus("codex"),
      providerStatus("pi", {
        versionAdvisory: {
          ...providerStatus("pi").versionAdvisory!,
          latestVersion: "2.0.0",
        },
      }),
    ]);

    expect(left).toBe(right);
  });
});

describe("shouldShowProviderUpdateStatus", () => {
  it("matches the list filter for hidden and server-disabled providers", () => {
    const codex = providerStatus("codex");
    const hiddenPi = providerStatus("pi");
    const settings = serverSettings({
      codex: { enabled: false, binaryPath: "codex", homePath: "", customModels: [] },
    });

    expect(
      shouldShowProviderUpdateStatus({
        provider: codex,
        hiddenProviderSet: new Set(),
        serverSettings: settings,
      }),
    ).toBe(false);
    expect(
      shouldShowProviderUpdateStatus({
        provider: hiddenPi,
        hiddenProviders: ["pi"],
        serverSettings: serverSettings(),
      }),
    ).toBe(false);
  });
});

describe("isProviderUpdateActive", () => {
  it("only treats queued and running provider updates as active", () => {
    const queuedState = {
      status: "queued",
      startedAt: null,
      finishedAt: null,
      message: null,
      output: null,
    } satisfies NonNullable<ServerProviderStatus["updateState"]>;
    const succeededState = {
      ...queuedState,
      status: "succeeded",
    } satisfies NonNullable<ServerProviderStatus["updateState"]>;

    expect(isProviderUpdateActive(providerStatus("codex", { updateState: queuedState }))).toBe(
      true,
    );
    expect(isProviderUpdateActive(providerStatus("codex", { updateState: succeededState }))).toBe(
      false,
    );
  });
});

describe("withProviderUpdateTimeout", () => {
  it("rejects a provider request that never settles", async () => {
    vi.useFakeTimers();
    const pending = new Promise<never>(() => undefined);
    const assertion = expect(
      withProviderUpdateTimeout({
        provider: "kilo",
        request: pending,
        timeoutMs: 1_000,
      }),
    ).rejects.toThrow("Kilo update timed out after 1 second");

    await vi.advanceTimersByTimeAsync(1_000);
    await assertion;
  });

  it("clears its watchdog when the provider request finishes", async () => {
    vi.useFakeTimers();
    await expect(
      withProviderUpdateTimeout({
        provider: "antigravity",
        request: Promise.resolve("updated"),
        timeoutMs: 1_000,
      }),
    ).resolves.toBe("updated");

    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("shouldOfferProviderUpdateAction", () => {
  it("does not offer native updates when latest-version metadata is unavailable", () => {
    expect(
      shouldOfferProviderUpdateAction(
        providerStatus("antigravity", {
          versionAdvisory: {
            status: "unknown",
            currentVersion: "1.1.2",
            latestVersion: null,
            updateCommand: "agy update",
            canUpdate: true,
            checkedAt: "2026-07-15T14:00:00.000Z",
            message: null,
          },
        }),
      ),
    ).toBe(false);
  });

  it("never offers an update action when the provider executable is unavailable", () => {
    expect(
      shouldOfferProviderUpdateAction(
        providerStatus("antigravity", {
          available: false,
          status: "error",
          authStatus: "unknown",
          version: null,
          versionAdvisory: {
            status: "unknown",
            currentVersion: null,
            latestVersion: null,
            updateCommand: "agy update",
            canUpdate: true,
            checkedAt: "2026-07-21T10:00:00.000Z",
            message: null,
          },
        }),
      ),
    ).toBe(false);
  });

  it("does not route a Scient-managed runtime to Update without a confirmed newer version", () => {
    expect(
      shouldOfferProviderUpdateAction(
        providerStatus("antigravity", {
          runtime: {
            source: "managed",
            managedVersion: "1.1.4",
            canInstall: false,
            canRepair: true,
            canRollback: false,
            canRemove: true,
            message: null,
          },
          versionAdvisory: {
            status: "unknown",
            currentVersion: "1.1.4",
            latestVersion: null,
            updateCommand: null,
            canUpdate: false,
            checkedAt: "2026-07-21T10:00:00.000Z",
            message: "Updates for this runtime are managed by Scient.",
          },
        }),
      ),
    ).toBe(false);
  });

  it("routes a confirmed outdated Scient-managed Antigravity runtime through its managed flow", () => {
    expect(
      shouldOfferProviderUpdateAction(
        providerStatus("antigravity", {
          runtime: {
            source: "managed",
            managedVersion: "1.1.4",
            canInstall: false,
            canRepair: true,
            canRollback: false,
            canRemove: true,
            message: null,
          },
        }),
      ),
    ).toBe(true);
  });

  it("does not broaden managed latest-channel updates to other providers", () => {
    expect(
      shouldOfferProviderUpdateAction(
        providerStatus("grok", {
          runtime: {
            source: "managed",
            managedVersion: "0.1.0",
            canInstall: false,
            canRepair: true,
            canRollback: false,
            canRemove: true,
            message: null,
          },
          versionAdvisory: {
            status: "unknown",
            currentVersion: "0.1.0",
            latestVersion: null,
            updateCommand: null,
            canUpdate: false,
            checkedAt: "2026-07-21T10:00:00.000Z",
            message: "Updates for this runtime are managed by Scient.",
          },
        }),
      ),
    ).toBe(false);
  });
});

describe("hasConfirmedProviderUpdate", () => {
  it("requires a successful comparison with both installed and latest versions", () => {
    expect(hasConfirmedProviderUpdate(providerStatus("cursor"))).toBe(true);

    for (const versionAdvisory of [
      {
        ...providerStatus("cursor").versionAdvisory!,
        status: "current" as const,
      },
      {
        ...providerStatus("cursor").versionAdvisory!,
        status: "unknown" as const,
        latestVersion: null,
      },
      {
        ...providerStatus("cursor").versionAdvisory!,
        currentVersion: null,
      },
      {
        ...providerStatus("cursor").versionAdvisory!,
        latestVersion: null,
      },
      {
        ...providerStatus("cursor").versionAdvisory!,
        checkedAt: null,
      },
    ]) {
      expect(hasConfirmedProviderUpdate(providerStatus("cursor", { versionAdvisory }))).toBe(false);
    }
  });

  it("rejects unavailable providers even if stale cached metadata says they are behind", () => {
    expect(
      hasConfirmedProviderUpdate(
        providerStatus("cursor", {
          available: false,
          status: "error",
          authStatus: "unknown",
        }),
      ),
    ).toBe(false);
  });

  it("keeps update capability separate from confirmed update availability", () => {
    expect(
      hasConfirmedProviderUpdate(
        providerStatus("pi", {
          versionAdvisory: {
            ...providerStatus("pi").versionAdvisory!,
            canUpdate: false,
            updateCommand: null,
          },
        }),
      ),
    ).toBe(true);
  });
});

describe("providerUpdateSummaryStatus", () => {
  it("distinguishes pending, unconfirmed, current, available, manual-only, and active states", () => {
    const settings = serverSettings();
    expect(
      providerUpdateSummaryStatus({ providers: [], serverSettings: null, loading: true }),
    ).toBe("Checking provider updates…");
    expect(
      providerUpdateSummaryStatus({
        providers: [
          providerStatus("cursor", {
            versionAdvisory: {
              ...providerStatus("cursor").versionAdvisory!,
              status: "unknown",
              latestVersion: null,
            },
          }),
        ],
        serverSettings: settings,
      }),
    ).toBe("Update status not yet confirmed");
    expect(
      providerUpdateSummaryStatus({
        providers: [
          providerStatus("cursor", {
            versionAdvisory: {
              ...providerStatus("cursor").versionAdvisory!,
              status: "current",
              latestVersion: "1.0.0",
            },
          }),
        ],
        serverSettings: settings,
      }),
    ).toBe("Provider tools are current");
    expect(
      providerUpdateSummaryStatus({
        providers: [providerStatus("cursor")],
        serverSettings: settings,
      }),
    ).toBe("1 update available");
    expect(
      providerUpdateSummaryStatus({
        providers: [
          providerStatus("pi", {
            versionAdvisory: {
              ...providerStatus("pi").versionAdvisory!,
              canUpdate: false,
              updateCommand: null,
            },
          }),
        ],
        serverSettings: settings,
      }),
    ).toBe("1 update available");
    expect(
      providerUpdateSummaryStatus({
        providers: [
          providerStatus("antigravity", {
            updateState: {
              status: "running",
              startedAt: "2026-07-26T09:01:00.000Z",
              finishedAt: null,
              message: "Updating provider.",
              output: null,
            },
            versionAdvisory: {
              ...providerStatus("antigravity").versionAdvisory!,
              status: "unknown",
              latestVersion: null,
            },
          }),
        ],
        serverSettings: settings,
      }),
    ).toBe("1 update in progress");
  });
});
