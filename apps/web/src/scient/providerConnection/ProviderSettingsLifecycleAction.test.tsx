import {
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderManagedRuntimeAction,
  type ProviderRuntimeOperation,
  type ProviderRuntimePlan,
  type ServerProvider,
} from "@t3tools/contracts";
import { isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { reactHookHarness as hooks } from "../../test/reactHookHarness";

const commands = vi.hoisted(() => ({ plan: vi.fn(), start: vi.fn(), toast: vi.fn() }));

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  const { reactHookHarness } = await import("../../test/reactHookHarness");
  return {
    ...actual,
    useRef: reactHookHarness.useRef,
    useState: reactHookHarness.useState,
  };
});

vi.mock("react/compiler-runtime", async () => {
  const { reactHookHarness } = await import("../../test/reactHookHarness");
  return { c: reactHookHarness.useMemoCache };
});

vi.mock("./useProviderLifecycleController", () => ({
  useProviderLifecycleController: () => ({
    planRuntime: commands.plan,
    startRuntime: commands.start,
  }),
}));

vi.mock("../../components/ui/toast", () => ({
  toastManager: { add: commands.toast },
  stackedThreadToast: (value: unknown) => value,
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
  hooks.reset();
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

function withOperation(value: ServerProvider, operation: ProviderRuntimeOperation): ServerProvider {
  return {
    ...value,
    connection: {
      ...value.connection!,
      runtime: { ...value.connection!.runtime!, operation },
    },
  };
}

type ActionButton = ReactElement<{ onClick: () => void | Promise<void> }>;

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function findButton(node: ReactNode): ActionButton | undefined {
  if (Array.isArray(node)) {
    return node.map(findButton).find((button) => button !== undefined);
  }
  if (!isValidElement<{ onClick?: () => void; children?: ReactNode; action?: string }>(node)) {
    return undefined;
  }
  if (node.props.onClick) return node as ActionButton;
  // Run the stateful managed-action child, while leaving button/tooltips as UI primitives.
  if (typeof node.type === "function" && node.props.action !== undefined) {
    const props = node.props;
    return findButton((node.type as (componentProps: typeof props) => ReactNode)(props));
  }
  return findButton(node.props.children);
}

function settingsButton(value: ServerProvider, onManage: () => void) {
  hooks.beginRender();
  const button = findButton(
    ProviderSettingsLifecycleAction({
      displayName: value.displayName ?? "Provider",
      environmentId: EnvironmentId.make("local"),
      provider: value,
      onManage,
    }),
  );
  if (!button) throw new Error("Expected a Settings lifecycle action.");
  return button;
}

describe("ProviderSettingsLifecycleAction", () => {
  beforeEach(() => {
    hooks.reset();
    vi.clearAllMocks();
    commands.plan.mockReset().mockImplementation(async (action: ProviderManagedRuntimeAction) => ({
      instanceId: ProviderInstanceId.make("codex"),
      action,
      target: "darwin-arm64",
      version: "0.148.0",
      downloadBytes: 42,
      sourceLabel: "Official release",
      catalogRevision: "reviewed:1",
      message: "Ready to install.",
    }));
    commands.start.mockReset().mockResolvedValue(provider({ source: "scient_managed" }));
  });
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

  it("starts managed install/update directly and only runs qualified external updates", () => {
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
    ).toEqual({ kind: "managed-runtime", action: "install" });
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
    ).toEqual({ kind: "managed-runtime", action: "update" });
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

  it.each(["install", "update"] as const)(
    "starts %s once without opening the card; pending clicks only open details",
    async (action) => {
      const value = provider({
        source: action === "install" ? "missing" : "scient_managed",
        actions: [action],
      });
      const onManage = vi.fn();
      const plan = deferred<ProviderRuntimePlan>();
      const started = deferred<ServerProvider>();
      commands.plan.mockReturnValue(plan.promise);
      commands.start.mockReturnValue(started.promise);
      const initialButton = settingsButton(value, onManage);
      expect(commands.plan).not.toHaveBeenCalled();

      const completed = initialButton.props.onClick();
      expect(commands.plan).toHaveBeenCalledExactlyOnceWith(action);
      expect(commands.start).not.toHaveBeenCalled();
      expect(onManage).not.toHaveBeenCalled();

      // A rapid click and a click after rerender must both avoid a second transaction.
      initialButton.props.onClick();
      settingsButton(value, onManage).props.onClick();
      expect(onManage).toHaveBeenCalledTimes(2);
      expect(onManage).toHaveBeenCalledWith();
      expect(commands.plan).toHaveBeenCalledTimes(1);

      const exactPlan: ProviderRuntimePlan = {
        instanceId: value.instanceId,
        action,
        target: "darwin-arm64",
        version: "0.148.0",
        downloadBytes: 42,
        sourceLabel: "Official release",
        catalogRevision: "reviewed:exact",
        message: "Ready to install.",
      };
      plan.resolve(exactPlan);
      await plan.promise;
      expect(commands.start).toHaveBeenCalledExactlyOnceWith(exactPlan);
      settingsButton(value, onManage).props.onClick();
      expect(commands.start).toHaveBeenCalledTimes(1);
      expect(onManage).toHaveBeenCalledTimes(3);
      started.resolve(value);
      await completed;
    },
  );

  it.each(["plan", "start"] as const)(
    "keeps %s errors in the existing notification, without opening or retrying",
    async (phase) => {
      const value = provider({ source: "missing" });
      const onManage = vi.fn();
      const failure = deferred<never>();
      commands[phase].mockReturnValue(failure.promise);
      const completed = settingsButton(value, onManage).props.onClick();
      if (phase === "start") await commands.plan.mock.results[0]!.value;
      failure.reject(new Error("Catalog unavailable."));
      await completed;
      expect(commands.toast).toHaveBeenCalledExactlyOnceWith({
        type: "error",
        title: "Could not install Codex",
        description: "Catalog unavailable.",
      });
      expect(onManage).not.toHaveBeenCalled();
      expect(commands.plan).toHaveBeenCalledTimes(1);
      expect(commands.start).toHaveBeenCalledTimes(phase === "start" ? 1 : 0);
    },
  );

  it.each(["install", "update", "repair", "remove"] as const)(
    "opens existing details for active or failed %s without starting/retrying it",
    (action) => {
      const onManage = vi.fn();
      for (const status of ["preparing", "downloading", "verifying", "failed"] as const) {
        const value = withOperation(provider({ source: "scient_managed", actions: [action] }), {
          operationId: "runtime-1",
          action,
          status,
          startedAt: "2026-09-04T00:00:00.000Z",
          finishedAt: status === "failed" ? "2026-09-04T00:01:00.000Z" : null,
          message: status === "failed" ? "Verification failed." : "Working.",
        });
        settingsButton(value, onManage).props.onClick();
        expect(onManage).toHaveBeenLastCalledWith(undefined);
      }
      expect(onManage).toHaveBeenCalledTimes(4);
      expect(commands.plan).not.toHaveBeenCalled();
      expect(commands.start).not.toHaveBeenCalled();
    },
  );

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
