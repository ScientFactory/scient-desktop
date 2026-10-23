import { render as _fixtureRender, type Screen, act } from "../../../test/render";
import { type ReactNode } from "react";

import {
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderManagedRuntimeAction,
  type ProviderRuntimeOperation,
  type ProviderRuntimePlan,
  type ServerProvider,
} from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";
import {
  ProviderSettingsLifecycleAction,
  resolveProviderSettingsPrimaryAction,
} from "./ProviderSettingsLifecycleAction";
import { providerSettingsLifecyclePresentation } from "./providerSettingsLifecyclePresentation";

async function _setupFixture0(_fixture: _Fixture) {
  await undefined;
}

async function mount(_fixture: _Fixture, node: ReactNode) {
  if (!_fixture.root0) {
    _fixture.host = document.createElement("div");
    document.body.append(_fixture.host);
    _fixture.root0 = _fixture.stack.use(
      await _fixtureRender(null, { container: _fixture.host, router: false }),
    );
  }
  await act(async () => await _fixture.root0!.rerender(node));
  return _fixture.host;
}
async function _cleanupFixture1(_fixture: _Fixture) {
  if (_fixture.root0) await act(async () => await _fixture.root0!.unmount());
  _fixture.host?.remove();
  _fixture.root0 = undefined;
  vi.unstubAllGlobals();
}

const commands = vi.hoisted(() => ({ plan: vi.fn(), start: vi.fn(), toast: vi.fn() }));

vi.mock("./useProviderLifecycleController", () => ({
  useProviderLifecycleController: () => ({
    planRuntime: commands.plan,
    startRuntime: commands.start,
  }),
}));

vi.mock("./environmentLocality", () => ({ useEnvironmentIsOnThisDevice: () => true }));
vi.mock("./providerSignInStarting", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./providerSignInStarting")>()),
  useProviderSignInStartingHere: () => false,
}));

vi.mock("../../components/ui/toast", () => ({
  toastManager: { add: commands.toast },
  stackedThreadToast: (value: unknown) => value,
}));

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

async function render(
  _fixture: _Fixture,
  value: ServerProvider,
  options: {
    readonly externalUpdateRunning?: boolean;
    readonly onRunExternalUpdate?: () => void;
  } = {},
): Promise<string> {
  return (
    await mount(
      _fixture,
      <ProviderSettingsLifecycleAction
        displayName={value.displayName ?? "Provider"}
        environmentId={EnvironmentId.make("local")}
        externalUpdateRunning={options.externalUpdateRunning}
        onManage={vi.fn()}
        onRunExternalUpdate={options.onRunExternalUpdate}
        provider={value}
      />,
    )
  ).innerHTML;
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

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function settingsButton(_fixture: _Fixture, value: ServerProvider, onManage: () => void) {
  await mount(
    _fixture,
    <ProviderSettingsLifecycleAction
      displayName={value.displayName ?? "Provider"}
      environmentId={EnvironmentId.make("local")}
      provider={value}
      onManage={onManage}
    />,
  );
  const button = _fixture.host.querySelector<HTMLButtonElement>("button");
  if (!button) throw new Error("Expected a Settings lifecycle action.");
  return button;
}
async function clickSettings(_fixture: _Fixture, value: ServerProvider, onManage: () => void) {
  const button = await settingsButton(_fixture, value, onManage);
  await act(() => button.click());
}
async function settle() {
  await act(async () => {
    await Promise.resolve();
  });
}

describe("ProviderSettingsLifecycleAction", () => {
  async function _setupFixture2(_fixture: _Fixture) {
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
  }
  it("uses one shared component for healthy, missing, disabled, and update states", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);
    await _setupFixture2(_fixture);

    const manage = await render(_fixture, provider({ source: "system" }));
    const install = await render(_fixture, provider({ source: "missing" }));

    expect(manage).toContain(">Manage<");
    expect(manage).toContain("lucide-settings-2");
    expect(manage).toContain("border-transparent");
    expect(manage).toContain("text-muted-foreground");
    expect(manage).not.toContain("text-primary");
    expect(install).toContain(">Install<");
    expect(install).toContain("lucide-download");
    expect(install).toContain("text-primary");
    const disabled = await render(_fixture, provider({ source: "system", enabled: false }));
    expect(disabled).toContain(">Manage<");
    expect(disabled).toContain("lucide-settings-2");
    expect(
      await render(
        _fixture,
        provider({ source: "scient_managed", actions: ["update", "repair", "remove"] }),
      ),
    ).toContain(">Manage<");
  });

  it("names the provider on its short Install and Manage actions", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);
    await _setupFixture2(_fixture);

    const name = provider({ source: "missing" }).displayName ?? "Provider";
    expect(await render(_fixture, provider({ source: "missing" }))).toContain(
      `aria-label="Install ${name}"`,
    );
    expect(
      await render(
        _fixture,
        provider({ source: "scient_managed", actions: ["update", "repair", "remove"] }),
      ),
    ).toContain(`aria-label="Manage ${name}"`);
  });

  it.each([
    ["codex", "Codex"],
    ["claudeAgent", "Claude"],
    ["antigravity", "Antigravity"],
    ["cursor", "Cursor"],
    ["droid", "Droid"],
    ["grok", "Grok"],
    ["opencode", "OpenCode"],
  ] as const)("routes disabled %s through its management card", async (driver, displayName) => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);
    await _setupFixture2(_fixture);

    const value = provider({ driver, source: "missing", enabled: false });
    const presentation = providerSettingsLifecyclePresentation(value, displayName);

    expect(
      resolveProviderSettingsPrimaryAction({
        provider: value,
        presentation,
        canRunExternalUpdate: false,
      }),
    ).toEqual({ kind: "open", runtimeAction: null });
    expect(await render(_fixture, value)).toContain(">Manage<");
    expect(await render(_fixture, value)).not.toContain(">Enable<");
  });

  it("keeps management available while the enabled provider probe settles", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);
    await _setupFixture2(_fixture);

    const markup = await render(_fixture, {
      ...provider({ source: "system" }),
      installed: false,
      probePending: true,
    });

    expect(markup).toContain(">Manage<");
    expect(markup).not.toContain(">Install<");
    expect(markup).not.toContain(">Sign in<");
    expect(markup).not.toContain(">Checking<");
  });

  it.each([
    ["install", "Installing"],
    ["update", "Updating"],
    ["repair", "Repairing"],
    ["remove", "Removing"],
  ] as const)("keeps %s progress visible beside icon-only management", async (action, label) => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);
    await _setupFixture2(_fixture);

    const value = withOperation(provider({ source: "scient_managed" }), {
      operationId: "runtime-1",
      action,
      status: action === "remove" ? "removing" : "downloading",
      startedAt: "2026-10-08T00:00:00.000Z",
      finishedAt: null,
      message: "Working.",
      downloadedBytes: 42,
      totalBytes: 100,
    });
    const markup = await render(_fixture, value);

    expect(markup).toContain(`aria-label="${label} Codex"`);
    expect(markup).toContain('aria-label="Manage Codex"');
    expect(markup).not.toContain(">Manage</button>");
    expect(markup).toContain('role="status"');
    expect(markup).toContain("text-primary");
    expect(markup).toContain("animate-spin");
    if (action === "remove") expect(markup).not.toContain("Download progress");
    else expect(markup).toContain('aria-label="Download progress 42%"');

    const onManage = vi.fn();
    await clickSettings(_fixture, value, onManage);
    expect(onManage).toHaveBeenCalledExactlyOnceWith();
    expect(commands.plan).not.toHaveBeenCalled();
    expect(commands.start).not.toHaveBeenCalled();
  });

  it.each([
    ["verifying", false, "Verifying"],
    ["testing", false, "Verifying"],
    ["activating", true, "Waiting"],
  ] as const)(
    "shows %s without implying download progress",
    async (status, waitingForIdle, label) => {
      await using _fixture = _createFixture();
      _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
      await _setupFixture0(_fixture);
      await _setupFixture2(_fixture);

      const markup = await render(
        _fixture,
        withOperation(
          { ...provider({ source: "scient_managed" }), probePending: true },
          {
            operationId: "runtime-1",
            action: "install",
            status,
            waitingForIdle,
            startedAt: "2026-10-08T00:00:00.000Z",
            finishedAt: null,
            message: "Working.",
            downloadedBytes: 100,
            totalBytes: 100,
          },
        ),
      );
      expect(markup).toContain(`aria-label="${label} Codex"`);
      expect(markup).not.toContain("Download progress");
    },
  );

  it.each(["succeeded", "cancelled", "failed"] as const)(
    "clears progress after the runtime operation is %s",
    async (status) => {
      await using _fixture = _createFixture();
      _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
      await _setupFixture0(_fixture);
      await _setupFixture2(_fixture);

      const markup = await render(
        _fixture,
        withOperation(provider({ source: "scient_managed" }), {
          operationId: "runtime-1",
          action: "install",
          status,
          startedAt: "2026-10-08T00:00:00.000Z",
          finishedAt: "2026-10-08T00:01:00.000Z",
          message: "Finished.",
        }),
      );
      expect(markup).not.toContain('aria-label="Installing Codex"');
      expect(markup).not.toContain("Download progress");
      expect(markup).toContain(">Manage</button>");
      expect(commands.start).not.toHaveBeenCalled();
    },
  );

  it("keeps sign-in progress visible while the account is unauthenticated", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);
    await _setupFixture2(_fixture);

    const ready = provider({ source: "system", authenticated: false });
    const markup = await render(_fixture, {
      ...ready,
      connection: {
        ...ready.connection!,
        operation: {
          operationId: "connection-1",
          method: "codex_browser",
          status: "waiting_for_browser",
          startedAt: "2026-10-08T00:00:00.000Z",
          finishedAt: null,
          message: "Finish in your browser.",
        },
      },
    });
    expect(markup).toContain('aria-label="Signing in Codex"');
    expect(markup).not.toContain(">Manage</button>");
    expect(markup).not.toContain("Download progress");
  });

  it("starts sign-in from the row only for one method that needs nothing else", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);
    await _setupFixture2(_fixture);

    const withMethods = (
      driver: "codex" | "claudeAgent" | "antigravity" | "cursor" | "droid" | "grok",
      methods: NonNullable<ServerProvider["connection"]>["methods"],
    ) => {
      const value = provider({ driver, source: "system", authenticated: false });
      return { ...value, connection: { ...value.connection!, methods } };
    };
    const primaryAction = (value: ServerProvider) =>
      resolveProviderSettingsPrimaryAction({
        provider: value,
        presentation: providerSettingsLifecyclePresentation(value, "Provider"),
        canRunExternalUpdate: false,
      });

    for (const [driver, method] of [
      ["codex", "codex_browser"],
      ["antigravity", "antigravity_google"],
      ["cursor", "cursor_browser"],
    ] as const) {
      expect(primaryAction(withMethods(driver, [method]))).toEqual({
        kind: "browser-sign-in",
        method,
      });
    }
    // The device code is shown in the setup view; the browser flow stays one click.
    expect(primaryAction(withMethods("codex", ["codex_browser", "codex_device_code"]))).toEqual({
      kind: "browser-sign-in",
      method: "codex_browser",
    });
    for (const value of [
      withMethods("claudeAgent", ["claude_subscription", "claude_console"]),
      withMethods("antigravity", ["antigravity_credentials"]),
      withMethods("grok", ["grok_account", "grok_device_code"]),
      withMethods("droid", ["droid_device_pairing"]),
    ]) {
      expect(primaryAction(value)).toEqual({ kind: "open", runtimeAction: null });
    }
  });

  it("names a slow start on the row while it runs", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);
    await _setupFixture2(_fixture);

    const ready = provider({ source: "system", authenticated: false });
    const markup = await render(_fixture, {
      ...ready,
      connection: {
        ...ready.connection!,
        operation: {
          operationId: "connection-1",
          method: "codex_browser",
          status: "starting",
          startedAt: "2026-10-08T00:00:00.000Z",
          finishedAt: null,
          message: "Antigravity can take up to a minute to start.",
        },
      },
    });
    expect(markup).toContain('aria-label="Starting Codex"');
  });

  it("starts managed install/update directly and only runs qualified external updates", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);
    await _setupFixture2(_fixture);

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
    "routes %s through the header without duplicating runtime transactions",
    async (action) => {
      await using _fixture = _createFixture();
      _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
      await _setupFixture0(_fixture);
      await _setupFixture2(_fixture);

      const value = provider({
        source: action === "install" ? "missing" : "scient_managed",
        actions: [action],
      });
      const onManage = vi.fn();
      if (action === "update") {
        await clickSettings(_fixture, value, onManage);
        expect(onManage).toHaveBeenCalledExactlyOnceWith();
        expect(commands.plan).not.toHaveBeenCalled();
        expect(commands.start).not.toHaveBeenCalled();
        return;
      }
      const plan = deferred<ProviderRuntimePlan>();
      const started = deferred<ServerProvider>();
      commands.plan.mockReturnValue(plan.promise);
      commands.start.mockReturnValue(started.promise);
      const initialButton = await settingsButton(_fixture, value, onManage);
      expect(commands.plan).not.toHaveBeenCalled();

      await act(() => initialButton.click());
      expect(commands.plan).toHaveBeenCalledExactlyOnceWith(action);
      expect(commands.start).not.toHaveBeenCalled();
      expect(onManage).not.toHaveBeenCalled();

      // A rapid click and a click after rerender must both avoid a second transaction.
      await act(() => initialButton.click());
      await clickSettings(_fixture, value, onManage);
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
      await clickSettings(_fixture, value, onManage);
      expect(commands.start).toHaveBeenCalledTimes(1);
      expect(onManage).toHaveBeenCalledTimes(3);
      started.resolve(value);
      await settle();
    },
  );

  it.each(["plan", "start"] as const)(
    "keeps %s errors in the existing notification, without opening or retrying",
    async (phase) => {
      await using _fixture = _createFixture();
      _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
      await _setupFixture0(_fixture);
      await _setupFixture2(_fixture);

      const value = provider({ source: "missing" });
      const onManage = vi.fn();
      const failure = deferred<never>();
      commands[phase].mockReturnValue(failure.promise);
      await clickSettings(_fixture, value, onManage);
      if (phase === "start") await commands.plan.mock.results[0]!.value;
      failure.reject(new Error("Catalog unavailable."));
      await settle();
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

  it("starts an install that replaces a newer system runtime without another decision", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);
    await _setupFixture2(_fixture);

    // Offered as a first installation; the plan found a newer system runtime.
    const value = provider({ source: "missing" });
    const onManage = vi.fn();
    commands.plan.mockResolvedValue({
      instanceId: value.instanceId,
      action: "install",
      target: "darwin-arm64",
      version: "0.148.0",
      downloadBytes: 42,
      sourceLabel: "Official release",
      catalogRevision: "reviewed:1:older-than-system",
      message: "Scient-managed Codex 0.148.0 is older than your installed Codex 0.150.0.",
      systemVersion: "0.150.0",
      olderThanSystem: true,
    } satisfies ProviderRuntimePlan);

    await clickSettings(_fixture, value, onManage);
    await settle();

    expect(commands.start).toHaveBeenCalledTimes(1);
    expect(commands.toast).not.toHaveBeenCalled();
    expect(onManage).not.toHaveBeenCalled();
  });

  it("starts an install over a system runtime of unknown version directly", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);
    await _setupFixture2(_fixture);

    const value = provider({ source: "missing" });
    const onManage = vi.fn();
    commands.plan.mockResolvedValue({
      instanceId: value.instanceId,
      action: "install",
      target: "darwin-arm64",
      version: "0.148.0",
      downloadBytes: 42,
      sourceLabel: "Official release",
      catalogRevision: "reviewed:1:system-version-unknown",
      message: "Scient does not know which Codex version, if any, is installed on this computer.",
      systemVersion: null,
      olderThanSystem: false,
    } satisfies ProviderRuntimePlan);

    await clickSettings(_fixture, value, onManage);
    await settle();

    expect(commands.start).toHaveBeenCalledTimes(1);
    expect(onManage).not.toHaveBeenCalled();
  });

  it("reports a stale plan after the controller exhausts its bounded retry", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);
    await _setupFixture2(_fixture);

    const value = provider({ source: "missing" });
    const onManage = vi.fn();
    commands.start.mockRejectedValue(
      Object.assign(new Error("The provider setup plan changed."), {
        reason: "runtime_plan_stale",
      }),
    );

    await clickSettings(_fixture, value, onManage);
    await settle();

    expect(commands.start).toHaveBeenCalledTimes(1);
    expect(commands.toast).toHaveBeenCalledTimes(1);
    expect(onManage).not.toHaveBeenCalled();
  });

  it.each(["install", "update", "repair", "remove"] as const)(
    "opens existing details for active or failed %s without starting/retrying it",
    async (action) => {
      await using _fixture = _createFixture();
      _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
      await _setupFixture0(_fixture);
      await _setupFixture2(_fixture);

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
        await clickSettings(_fixture, value, onManage);
        expect(onManage).toHaveBeenLastCalledWith();
      }
      expect(onManage).toHaveBeenCalledTimes(4);
      expect(commands.plan).not.toHaveBeenCalled();
      expect(commands.start).not.toHaveBeenCalled();
    },
  );

  it("keeps management available beside system and Scient-managed updates", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);
    await _setupFixture2(_fixture);

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
      await render(_fixture, externalUpdate, { onRunExternalUpdate: vi.fn() }),
      await render(_fixture, managedUpdate),
    ]) {
      expect(markup).not.toContain(">Update</button>");
      expect(markup).toContain('aria-label="Manage Codex"');
      expect(markup).toContain("lucide-settings-2");
      expect(markup).toContain(">Manage</button>");
    }

    const updatingMarkup = await render(_fixture, externalUpdate, {
      externalUpdateRunning: true,
      onRunExternalUpdate: vi.fn(),
    });
    expect(updatingMarkup).toContain('aria-label="Updating Codex"');
    expect(updatingMarkup).not.toContain(">Manage</button>");
    const manageButtonEnd = updatingMarkup.indexOf('aria-label="Manage Codex"');
    const manageButtonStart = updatingMarkup.lastIndexOf("<button", manageButtonEnd);
    const manageButtonClose = updatingMarkup.indexOf("</button>", manageButtonEnd);
    expect(updatingMarkup.slice(manageButtonStart, manageButtonClose)).not.toMatch(
      /\sdisabled(?:=|[\s>])/,
    );
  });

  it.each(["queued", "running"] as const)(
    "reads external update progress from a %s server snapshot after remount",
    async (status) => {
      await using _fixture = _createFixture();
      _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
      await _setupFixture0(_fixture);
      await _setupFixture2(_fixture);

      const markup = await render(_fixture, {
        ...provider({ source: "system" }),
        updateState: {
          status,
          message: "Updating the external runtime.",
          output: null,
          startedAt: "2026-10-08T00:00:00.000Z",
          finishedAt: null,
        },
      });
      expect(markup).toContain('aria-label="Updating Codex"');
      expect(markup).not.toContain(">Manage</button>");
      expect(markup).not.toContain("Download progress");
    },
  );
});

function _createFixture() {
  const stack = new AsyncDisposableStack();
  const cleanup = new AsyncDisposableStack();
  return {
    host: undefined! as HTMLDivElement,
    stack,
    cleanup,
    root0: undefined! as Screen | undefined,
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
