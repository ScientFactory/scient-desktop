import {
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderManagedRuntimeAction,
  type ServerProvider,
} from "@t3tools/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";

vi.mock("./useProviderLifecycleController", () => ({
  useProviderLifecycleController: () => ({}),
}));

import {
  ProviderSettingsLifecycleAction,
  resolveProviderSettingsPrimaryAction,
} from "./ProviderSettingsLifecycleAction";
import { providerSettingsLifecyclePresentation } from "./providerSettingsLifecyclePresentation";

function provider(input: {
  readonly driver?:
    | "codex"
    | "claudeAgent"
    | "antigravity"
    | "cursor"
    | "droid"
    | "grok"
    | "opencode";
  readonly source: "scient_managed" | "system" | "missing";
  readonly authenticated?: boolean;
  readonly enabled?: boolean;
  readonly actions?: ReadonlyArray<ProviderManagedRuntimeAction>;
}): ServerProvider {
  const driver = input.driver ?? "codex";
  const authenticated = input.authenticated ?? true;
  return {
    instanceId: ProviderInstanceId.make(driver),
    driver: ProviderDriverKind.make(driver),
    displayName:
      driver === "claudeAgent" ? "Claude" : driver.charAt(0).toUpperCase() + driver.slice(1),
    enabled: input.enabled ?? true,
    installed: input.source !== "missing",
    version: input.source === "missing" ? null : "0.147.0",
    status: input.enabled === false ? "disabled" : authenticated ? "ready" : "warning",
    auth: authenticated
      ? { status: "authenticated", required: true, label: "Subscription" }
      : { status: "unauthenticated", required: true },
    checkedAt: "2026-08-23T08:00:00.000Z",
    models: authenticated
      ? [{ slug: "default", name: "Default", isCustom: false, capabilities: null }]
      : [],
    slashCommands: [],
    skills: [],
    connection: {
      methods: driver === "codex" ? ["codex_browser"] : ["claude_subscription"],
      canDisconnect: authenticated,
      operation: null,
      runtime: {
        source: input.source,
        supportTier: "fully_assisted",
        target: "darwin-arm64",
        actions:
          input.actions ??
          (input.source === "scient_managed"
            ? ["repair", "remove"]
            : input.source === "missing"
              ? ["install"]
              : []),
        managedVersion: input.source === "scient_managed" ? "0.147.0" : null,
        previousManagedVersion: null,
        operation: null,
        message: input.source === "missing" ? "Install available." : "Provider is ready.",
      },
    },
  };
}

function render(
  value: ServerProvider,
  options: {
    readonly externalUpdateRunning?: boolean;
    readonly onRunExternalUpdate?: () => void;
  } = {},
): string {
  return renderToStaticMarkup(
    <ProviderSettingsLifecycleAction
      displayName={value.displayName ?? "Provider"}
      environmentId={EnvironmentId.make("local")}
      externalUpdateRunning={options.externalUpdateRunning}
      onManage={vi.fn()}
      onRunExternalUpdate={options.onRunExternalUpdate}
      provider={value}
    />,
  );
}

describe("ProviderSettingsLifecycleAction", () => {
  it("uses one shared component for healthy, missing, disabled, and update states", () => {
    const manage = render(provider({ source: "system" }));
    const install = render(provider({ source: "missing" }));

    expect(manage).toContain(">Manage<");
    expect(manage).toContain("lucide-settings-2");
    expect(manage).toContain("border-transparent");
    expect(manage).toContain("text-muted-foreground");
    expect(manage).not.toContain("text-primary");
    expect(install).toContain(">Install<");
    expect(install).toContain("lucide-download");
    expect(install).toContain("text-primary");
    const disabled = render(provider({ source: "system", enabled: false }));
    expect(disabled).toContain(">Manage<");
    expect(disabled).toContain("lucide-settings-2");
    expect(
      render(provider({ source: "scient_managed", actions: ["update", "repair", "remove"] })),
    ).toContain(">Update<");
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
    const value = provider({ driver, source: "missing", enabled: false });
    const presentation = providerSettingsLifecyclePresentation(value, displayName);

    expect(
      resolveProviderSettingsPrimaryAction({
        provider: value,
        presentation,
        canRunExternalUpdate: false,
      }),
    ).toEqual({ kind: "open", runtimeAction: null });
    expect(render(value)).toContain(">Manage<");
    expect(render(value)).not.toContain(">Enable<");
  });

  it("renders a compact status while the enabled provider probe settles", () => {
    const markup = render({
      ...provider({ source: "system" }),
      installed: false,
      probePending: true,
    });

    expect(markup).toContain("lucide-loader");
    expect(markup).toContain('role="status"');
    expect(markup).toContain(">Checking<");
    expect(markup).toContain("Codex status");
    expect(markup).not.toContain(">Install<");
    expect(markup).not.toContain(">Sign in<");
    expect(markup).not.toContain(">Manage<");
  });

  it("keeps Codex browser sign-in direct and routes provider choosers through the dialog", () => {
    const codex = provider({ source: "system", authenticated: false });
    const claude = provider({
      driver: "claudeAgent",
      source: "system",
      authenticated: false,
    });

    expect(
      resolveProviderSettingsPrimaryAction({
        provider: codex,
        presentation: providerSettingsLifecyclePresentation(codex, "Codex"),
        canRunExternalUpdate: false,
      }),
    ).toEqual({ kind: "codex-browser-sign-in" });
    expect(
      resolveProviderSettingsPrimaryAction({
        provider: claude,
        presentation: providerSettingsLifecyclePresentation(claude, "Claude"),
        canRunExternalUpdate: false,
      }),
    ).toEqual({ kind: "open", runtimeAction: null });
  });

  it("routes reviewed runtime actions to the dialog and only runs qualified external updates", () => {
    const missing = provider({ source: "missing" });
    const external = {
      ...provider({ source: "system" }),
      versionAdvisory: {
        status: "behind_latest" as const,
        currentVersion: "0.147.0",
        latestVersion: "0.148.0",
        updateCommand: "npm update -g @openai/codex",
        canUpdate: true,
        checkedAt: "2026-08-23T08:00:00.000Z",
        message: "Update available.",
      },
    };

    expect(
      resolveProviderSettingsPrimaryAction({
        provider: missing,
        presentation: providerSettingsLifecyclePresentation(missing, "Codex"),
        canRunExternalUpdate: false,
      }),
    ).toEqual({ kind: "open", runtimeAction: "install" });
    const managedUpdate = provider({
      source: "scient_managed",
      actions: ["update", "repair", "remove"],
    });
    expect(
      resolveProviderSettingsPrimaryAction({
        provider: managedUpdate,
        presentation: providerSettingsLifecyclePresentation(managedUpdate, "Codex"),
        canRunExternalUpdate: false,
      }),
    ).toEqual({ kind: "managed-update" });
    expect(
      resolveProviderSettingsPrimaryAction({
        provider: external,
        presentation: providerSettingsLifecyclePresentation(external, "Codex"),
        canRunExternalUpdate: true,
      }),
    ).toEqual({ kind: "external-update" });
    expect(
      resolveProviderSettingsPrimaryAction({
        provider: external,
        presentation: providerSettingsLifecyclePresentation(external, "Codex"),
        canRunExternalUpdate: false,
      }),
    ).toEqual({ kind: "open", runtimeAction: null });
  });

  it("keeps management available beside system and Scient-managed updates", () => {
    const externalUpdate = {
      ...provider({ source: "system", actions: ["install"] }),
      versionAdvisory: {
        status: "behind_latest" as const,
        currentVersion: "0.147.0",
        latestVersion: "0.148.0",
        updateCommand: "brew upgrade codex",
        canUpdate: true,
        checkedAt: "2026-08-23T08:00:00.000Z",
        message: "Update available.",
      },
    };
    const managedUpdate = provider({
      source: "scient_managed",
      actions: ["update", "repair", "remove"],
    });

    for (const markup of [
      render(externalUpdate, { onRunExternalUpdate: vi.fn() }),
      render(managedUpdate),
    ]) {
      expect(markup).toContain(">Update</button>");
      expect(markup).toContain('aria-label="Manage Codex"');
      expect(markup).toContain("lucide-settings-2");
      expect(markup).not.toContain(">Manage</button>");
    }

    const updatingMarkup = render(externalUpdate, {
      externalUpdateRunning: true,
      onRunExternalUpdate: vi.fn(),
    });
    expect(updatingMarkup).toContain(">Updating</button>");
    const manageButtonEnd = updatingMarkup.indexOf('aria-label="Manage Codex"');
    const manageButtonStart = updatingMarkup.lastIndexOf("<button", manageButtonEnd);
    const manageButtonClose = updatingMarkup.indexOf("</button>", manageButtonEnd);
    expect(updatingMarkup.slice(manageButtonStart, manageButtonClose)).not.toMatch(
      /\sdisabled(?:=|[\s>])/,
    );
  });
});
