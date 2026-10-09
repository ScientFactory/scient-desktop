import type { ReactElement } from "react";
import {
  DEFAULT_UNIFIED_SETTINGS,
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  resolveProviderInstanceEnabled,
  type ServerProvider,
  type UnifiedSettings,
} from "@t3tools/contracts";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { visitElements } from "../../test/reactElementTree";
import { reactHookHarness as hooks } from "../../test/reactHookHarness";

const atoms = vi.hoisted(() => ({
  providers: null as ReadonlyArray<ServerProvider> | null,
  providersAtom: Symbol("providers"),
  refreshProviders: Symbol("refreshProviders"),
  updateProvider: Symbol("updateProvider"),
  uninstallAcpRegistryManagedBinary: Symbol("uninstallAcpRegistryManagedBinary"),
  acceptAcpRegistryUrlAuth: Symbol("acceptAcpRegistryUrlAuth"),
}));

const commands = vi.hoisted(() => ({
  refresh: vi.fn(),
  updateProvider: vi.fn(),
  uninstall: vi.fn(),
  acceptUrlAuth: vi.fn(),
  canManageProviders: true,
  canWriteSettings: true,
}));

const settingsState = vi.hoisted(() => ({
  value: null as UnifiedSettings | null,
  readEnvironmentIds: [] as EnvironmentId[],
  updateEnvironmentIds: [] as EnvironmentId[],
  mutationEnvironmentIds: [] as EnvironmentId[],
  updateSettings: vi.fn(),
  mutateProviderInstance: vi.fn(),
  updateClientSettings: vi.fn(),
}));

const settingsSearchState = vi.hoisted(() => ({
  targetId: null as string | null,
  effects: [] as Array<() => void>,
}));

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  const { reactHookHarness } = await import("../../test/reactHookHarness");
  return {
    ...actual,
    useCallback: reactHookHarness.useCallback,
    useEffect: (effect: () => void) => settingsSearchState.effects.push(effect),
    useMemo: reactHookHarness.useMemo,
    useRef: reactHookHarness.useRef,
    useState: reactHookHarness.useState,
  };
});

vi.mock("./settingsLayout", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./settingsLayout")>();
  return {
    ...actual,
    useSettingsSearchTargetId: () => settingsSearchState.targetId,
  };
});

vi.mock("./SettingsScopeSentence", () => ({ SettingsScopeSentence: () => null }));
vi.mock("react/compiler-runtime", async () => {
  const { reactHookHarness } = await import("../../test/reactHookHarness");
  return { c: reactHookHarness.useMemoCache };
});

vi.mock("@effect/atom-react", () => ({
  useAtomValue: () => atoms.providers,
}));

vi.mock("../../state/server", () => ({
  EMPTY_SERVER_PROVIDERS: [],
  serverEnvironment: {
    providersValueAtom: () => atoms.providersAtom,
    refreshProviders: atoms.refreshProviders,
    updateProvider: atoms.updateProvider,
    uninstallAcpRegistryManagedBinary: atoms.uninstallAcpRegistryManagedBinary,
    acceptAcpRegistryUrlAuth: atoms.acceptAcpRegistryUrlAuth,
  },
}));

vi.mock("../../state/use-atom-command", () => ({
  useAtomCommand: (atom: symbol) =>
    atom === atoms.refreshProviders
      ? commands.refresh
      : atom === atoms.uninstallAcpRegistryManagedBinary
        ? commands.uninstall
        : atom === atoms.acceptAcpRegistryUrlAuth
          ? commands.acceptUrlAuth
          : commands.updateProvider,
}));

vi.mock("../../hooks/useSettings", () => ({
  useUpdateClientSettings: () => settingsState.updateClientSettings,
  useEnvironmentSettings: (environmentId: EnvironmentId) => {
    settingsState.readEnvironmentIds.push(environmentId);
    return settingsState.value;
  },
  useUpdateEnvironmentSettings: (environmentId: EnvironmentId) => {
    settingsState.updateEnvironmentIds.push(environmentId);
    return settingsState.updateSettings;
  },
  usePersistEnvironmentProviderInstanceMutation: (environmentId: EnvironmentId) => {
    settingsState.mutationEnvironmentIds.push(environmentId);
    return settingsState.mutateProviderInstance;
  },
}));

vi.mock("../../environments/primary", () => ({
  usePrimarySessionState: () => ({ data: null, error: null, isPending: false, refresh: vi.fn() }),
}));

vi.mock("../../state/session", () => ({
  useEnvironmentSessionState: () => ({ data: null, hasError: false, isPending: true }),
  useEnvironmentScope: (environmentId: EnvironmentId, scope: string) =>
    environmentId === "remote-device" &&
    (scope === "providers:manage"
      ? commands.canManageProviders
      : scope === "settings:write"
        ? commands.canWriteSettings
        : scope === "orchestration:read"),
  readEnvironmentScope: (environmentId: EnvironmentId, scope: string) =>
    environmentId === "remote-device" &&
    (scope === "providers:manage"
      ? commands.canManageProviders
      : scope === "settings:write"
        ? commands.canWriteSettings
        : scope === "orchestration:read"),
}));

vi.mock("../../state/entities", () => ({
  useProjects: () => [],
}));

import { EnvironmentProviderSettings } from "./ProviderSettingsPanel";
import { AddProviderInstanceDialog } from "./AddProviderInstanceDialog";

const environmentId = EnvironmentId.make("remote-device");
const codexId = ProviderInstanceId.make("codex");
const customId = ProviderInstanceId.make("codex_work");
const antigravityId = ProviderInstanceId.make("antigravity");

function provider(): ServerProvider {
  return {
    instanceId: codexId,
    driver: ProviderDriverKind.make("codex"),
    enabled: true,
    installed: true,
    version: "1.0.0",
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-07-24T12:00:00.000Z",
    models: [],
    slashCommands: [],
    skills: [],
    versionAdvisory: {
      status: "behind_latest",
      currentVersion: "1.0.0",
      latestVersion: "1.1.0",
      updateCommand: "pnpm add -g @openai/codex@latest",
      canUpdate: true,
      checkedAt: "2026-07-24T12:00:00.000Z",
      message: "Update available.",
    },
  };
}

function missingAntigravityProvider(): ServerProvider {
  return {
    instanceId: antigravityId,
    driver: ProviderDriverKind.make("antigravity"),
    enabled: true,
    installed: false,
    version: null,
    status: "error",
    auth: { status: "unknown", required: true },
    checkedAt: "2026-08-22T12:00:00.000Z",
    models: [],
    slashCommands: [],
    skills: [],
    connection: {
      methods: ["antigravity_google"],
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
        message: "Scient can install Antigravity.",
      },
    },
  };
}

function renderPanel(options?: {
  readonly readOnly?: boolean;
  readonly targetInstanceId?: ProviderInstanceId;
}): ReactElement<Record<string, unknown>> {
  hooks.beginRender();
  return EnvironmentProviderSettings({
    environmentId,
    environmentLabel: "Remote device",
    ...(options?.readOnly === undefined ? {} : { readOnly: options.readOnly }),
    ...(options?.targetInstanceId === undefined
      ? {}
      : { targetInstanceId: options.targetInstanceId }),
  }) as ReactElement<Record<string, unknown>>;
}

function isRefreshButton(element: ReactElement<Record<string, unknown>>): boolean {
  const children = element.props.children;
  return (
    Array.isArray(children) &&
    children.some(
      (child) =>
        typeof child === "object" &&
        child !== null &&
        (child as ReactElement<Record<string, unknown>>).props?.className === "sr-only" &&
        (child as ReactElement<Record<string, unknown>>).props?.children ===
          "Refresh provider status",
    )
  );
}

function isAddProviderButton(element: ReactElement<Record<string, unknown>>): boolean {
  return element.props["aria-label"] === "Add provider";
}

async function flushPromises(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe("EnvironmentProviderSettings routing", () => {
  beforeEach(() => {
    hooks.reset();
    atoms.providers = null;
    settingsState.value = DEFAULT_UNIFIED_SETTINGS;
    settingsState.readEnvironmentIds = [];
    settingsState.updateEnvironmentIds = [];
    settingsState.mutationEnvironmentIds = [];
    settingsState.updateSettings.mockReset();
    settingsState.updateClientSettings.mockReset();
    settingsSearchState.targetId = null;
    settingsSearchState.effects = [];
    settingsState.mutateProviderInstance
      .mockReset()
      .mockResolvedValue({ _tag: "Success", value: {} });
    commands.canManageProviders = true;
    commands.canWriteSettings = true;
    commands.refresh.mockReset().mockResolvedValue({ _tag: "Success" });
    commands.updateProvider.mockReset().mockResolvedValue({ _tag: "Success" });
    commands.uninstall.mockReset().mockResolvedValue({ _tag: "Success", value: {} });
    commands.acceptUrlAuth
      .mockReset()
      .mockResolvedValue({ _tag: "Success", value: { accepted: true } });
  });

  it.each(["loading", "empty", "partial"])(
    "shows built-in default slots with fresh settings and %s provider snapshots without writes",
    (snapshotState) => {
      settingsState.value = { ...DEFAULT_UNIFIED_SETTINGS, providerInstances: {} };
      atoms.providers =
        snapshotState === "loading" ? null : snapshotState === "empty" ? [] : [provider()];
      const panel = renderPanel();
      const drivers = [
        "codex",
        "claudeAgent",
        "antigravity",
        "scient",
        "cursor",
        "grok",
        "droid",
        "pi",
        "omp",
        "opencode",
        "muse",
      ];
      for (const driver of drivers) {
        const instance = { driver: ProviderDriverKind.make(driver) };
        const row = visitElements(
          panel,
          (element) => element.props.instanceId === driver && element.props.mode === "list",
        );
        expect(row, driver).not.toBeNull();
        expect(row?.props.instance).toEqual(instance);
        if (["cursor", "grok", "pi", "opencode", "antigravity", "muse"].includes(driver)) {
          expect(resolveProviderInstanceEnabled(instance), driver).toBe(false);
        }
      }
      expect(
        visitElements(
          panel,
          (element) => element.props.instanceId === "acpRegistry" && element.props.mode === "list",
        ),
      ).toBeNull();
      expect(visitElements(panel, isAddProviderButton)).not.toBeNull();
      expect(settingsState.value.providerInstances).toEqual({});
      expect(settingsState.mutateProviderInstance).not.toHaveBeenCalled();
      expect(settingsState.updateSettings).not.toHaveBeenCalled();
      expect(commands.updateProvider).not.toHaveBeenCalled();
    },
  );

  it("keeps explicitly configured provider slots visible when disabled", () => {
    const drivers = [
      "codex",
      "claudeAgent",
      "antigravity",
      "scient",
      "cursor",
      "grok",
      "droid",
      "pi",
      "omp",
      "opencode",
    ] as const;
    settingsState.value = {
      ...DEFAULT_UNIFIED_SETTINGS,
      providerInstances: Object.fromEntries(
        drivers.map((driver) => [
          ProviderInstanceId.make(driver),
          { driver: ProviderDriverKind.make(driver), enabled: false },
        ]),
      ),
    };
    atoms.providers = [
      {
        ...provider(),
        instanceId: ProviderInstanceId.make("cursor"),
        driver: ProviderDriverKind.make("cursor"),
        enabled: false,
      },
    ];
    const panel = renderPanel();
    for (const driver of drivers) {
      expect(
        visitElements(
          panel,
          (element) => element.props.instanceId === driver && element.props.mode === "list",
        ),
      ).not.toBeNull();
    }
    expect(settingsState.mutateProviderInstance).not.toHaveBeenCalled();
    expect(settingsState.updateSettings).not.toHaveBeenCalled();
  });

  it("opens and enables an explicitly disabled instance through its exact environment", async () => {
    const droidId = ProviderInstanceId.make("droid");
    settingsState.value = {
      ...DEFAULT_UNIFIED_SETTINGS,
      providerInstances: {
        [droidId]: { driver: ProviderDriverKind.make("droid"), enabled: false },
      },
    };
    let panel = renderPanel({ targetInstanceId: droidId });
    const row = visitElements(
      panel,
      (element) => element.props.instanceId === "droid" && element.props.mode === "list",
    );
    if (!row) throw new Error("Disabled Droid settings row was not rendered");
    (row.props.onSelect as () => void)();
    panel = renderPanel({ targetInstanceId: droidId });
    const editor = visitElements(
      panel,
      (element) => element.props.instanceId === "droid" && element.props.mode === "editor",
    );
    if (!editor) throw new Error("Droid settings editor was not rendered");
    expect(settingsState.mutateProviderInstance).not.toHaveBeenCalled();
    const next = { driver: ProviderDriverKind.make("droid"), enabled: true };
    (editor.props.onUpdate as (instance: typeof next) => void)(next);
    await flushPromises();
    expect(settingsState.mutateProviderInstance).toHaveBeenCalledExactlyOnceWith(
      { operation: "upsert", instanceId: droidId, instance: next },
      {},
    );
    expect(settingsState.mutationEnvironmentIds).toEqual([environmentId, environmentId]);
  });

  it("keeps explicitly configured providers visible when disabled", () => {
    const grokId = ProviderInstanceId.make("grok");
    settingsState.value = {
      ...DEFAULT_UNIFIED_SETTINGS,
      providerInstances: {
        [grokId]: { driver: ProviderDriverKind.make("grok"), enabled: false },
      },
    };
    const panel = renderPanel();
    expect(
      visitElements(
        panel,
        (element) => element.props.instanceId === grokId && element.props.mode === "list",
      ),
    ).not.toBeNull();
  });

  it("keeps a configured provider instance visible when disabled", () => {
    settingsState.value = {
      ...DEFAULT_UNIFIED_SETTINGS,
      providerInstances: {
        [ProviderInstanceId.make("grok")]: {
          driver: ProviderDriverKind.make("grok"),
          enabled: false,
          config: {
            binaryPath: "/custom/grok",
          },
        },
      },
    };
    const panel = renderPanel();
    expect(
      visitElements(
        panel,
        (element) => element.props.instanceId === "grok" && element.props.mode === "list",
      ),
    ).not.toBeNull();
  });

  it.each(["pi", "omp", "scient"])(
    "shows %s curated defaults and persists enabling every model",
    (driver) => {
      const instanceId = ProviderInstanceId.make(driver);
      const native = {
        ...provider(),
        instanceId,
        driver: ProviderDriverKind.make(driver),
        models: [
          "anthropic/claude-haiku-4-5",
          "anthropic/claude-opus-5-5",
          "google-antigravity/claude-opus-4-5",
          "google-antigravity/claude-opus-4-6",
          "google-antigravity/gemini-3.8-flash",
          "google-antigravity/gemini-3.1-pro",
        ].map((slug) => ({
          slug,
          name: slug,
          isCustom: false,
          capabilities: {},
        })),
      };
      settingsState.value = {
        ...DEFAULT_UNIFIED_SETTINGS,
        providerInstances: { [instanceId]: { driver: native.driver, enabled: true } },
      };
      atoms.providers = [native];
      const editor = visitElements(
        renderPanel({ targetInstanceId: instanceId }),
        (element) => element.props.instanceId === instanceId && element.props.mode === "editor",
      );
      expect(editor?.props.hiddenModels).toEqual([
        "anthropic/claude-haiku-4-5",
        "google-antigravity/claude-opus-4-5",
      ]);
      if (!editor) throw new Error("Provider editor was not rendered");
      (editor.props.onHiddenModelsChange as (models: string[]) => void)([]);
      const saved = { [instanceId]: { hiddenModels: [], modelOrder: [] } };
      expect(settingsState.updateClientSettings).toHaveBeenCalledExactlyOnceWith({
        providerModelPreferences: saved,
      });
      settingsState.value = { ...settingsState.value, providerModelPreferences: saved };
      const restored = visitElements(
        renderPanel({ targetInstanceId: instanceId }),
        (element) => element.props.instanceId === instanceId && element.props.mode === "editor",
      );
      expect(restored?.props.hiddenModels).toEqual([]);
    },
  );

  it("coalesces a nullable provider snapshot before rendering array-backed UI", () => {
    expect(() => renderPanel()).not.toThrow();
    expect(settingsState.readEnvironmentIds).toEqual([environmentId]);
    expect(settingsState.updateEnvironmentIds).toEqual([environmentId]);
    expect(settingsState.mutationEnvironmentIds).toEqual([environmentId]);
  });

  it("routes refresh and provider update commands to the selected environment", async () => {
    atoms.providers = [provider()];
    const panel = renderPanel({ targetInstanceId: codexId });
    const refreshButton = visitElements(panel, isRefreshButton);
    expect(refreshButton).not.toBeNull();
    (refreshButton?.props.onClick as (() => void) | undefined)?.();
    await flushPromises();

    expect(commands.refresh).toHaveBeenCalledWith({
      environmentId,
      input: { refreshModels: true, refreshManagedRuntimeCatalog: true },
    });

    const providerCard = visitElements(
      panel,
      (element) =>
        element.props.instanceId === codexId && typeof element.props.onRunUpdate === "function",
    );
    expect(providerCard).not.toBeNull();
    (providerCard?.props.onRunUpdate as (() => void) | undefined)?.();
    await flushPromises();

    expect(commands.updateProvider).toHaveBeenCalledWith({
      environmentId,
      input: { provider: ProviderDriverKind.make("codex"), instanceId: codexId },
    });
  });

  it.each([undefined, "install"] as const)(
    "opens a missing provider with only the requested action (%s)",
    (action) => {
      atoms.providers = [missingAntigravityProvider()];
      let panel = renderPanel({ targetInstanceId: antigravityId });
      const providerRow = visitElements(
        panel,
        (element) => element.props.instanceId === antigravityId && element.props.mode === "list",
      );
      expect(providerRow).not.toBeNull();
      (providerRow?.props.onSelect as (() => void) | undefined)?.();

      panel = renderPanel({ targetInstanceId: antigravityId });
      const providerCard = visitElements(
        panel,
        (element) =>
          element.props.instanceId === antigravityId &&
          typeof element.props.onManageConnection === "function",
      );
      expect(providerCard).not.toBeNull();

      (providerCard?.props.onManageConnection as ((action?: "install") => void) | undefined)?.(
        action,
      );

      const updatedPanel = renderPanel();
      const connectionDialog = visitElements(updatedPanel, (element) => {
        const dialogProvider = element.props.provider as ServerProvider | undefined;
        return (
          dialogProvider?.instanceId === antigravityId &&
          element.props.initialRuntimeAction === action
        );
      });
      expect(connectionDialog).not.toBeNull();
    },
  );

  it("forwards a requested runtime action into the lifecycle dialog", () => {
    atoms.providers = [provider()];
    const panel = renderPanel({ targetInstanceId: codexId });
    const providerCard = visitElements(
      panel,
      (element) =>
        element.props.instanceId === codexId &&
        typeof element.props.onManageConnection === "function",
    );

    (providerCard?.props.onManageConnection as ((action: "repair") => void) | undefined)?.(
      "repair",
    );

    const updatedPanel = renderPanel({ targetInstanceId: codexId });
    const connectionDialog = visitElements(updatedPanel, (element) => {
      const dialogProvider = element.props.provider as ServerProvider | undefined;
      return (
        dialogProvider?.instanceId === codexId && element.props.initialRuntimeAction === "repair"
      );
    });
    expect(connectionDialog).not.toBeNull();
  });

  it("opens the requested provider instance instead of the first provider", () => {
    settingsState.value = {
      ...DEFAULT_UNIFIED_SETTINGS,
      providerInstances: {
        [customId]: { driver: ProviderDriverKind.make("codex"), enabled: true },
      },
    };
    atoms.providers = [provider()];
    const panel = renderPanel({ targetInstanceId: customId });
    const editor = visitElements(panel, (element) => element.props.mode === "editor");
    expect(editor?.props.instanceId).toBe(customId);
  });

  it.each([
    ["onFavoriteModelsChange", { favorites: [{ provider: codexId, model: "chosen" }] }],
    [
      "onHiddenModelsChange",
      { providerModelPreferences: { [codexId]: { hiddenModels: ["chosen"], modelOrder: [] } } },
    ],
    [
      "onModelOrderChange",
      { providerModelPreferences: { [codexId]: { hiddenModels: [], modelOrder: ["chosen"] } } },
    ],
  ])("saves %s on this device without changing the selected server", (action, expected) => {
    atoms.providers = [provider()];
    const panel = renderPanel({ targetInstanceId: codexId });
    const editor = visitElements(
      panel,
      (element) => element.props.instanceId === codexId && element.props.mode === "editor",
    );
    expect(editor).not.toBeNull();
    if (!editor) throw new Error("Provider editor was not rendered");
    (editor.props[action] as (models: string[]) => void)(["chosen"]);
    expect(settingsState.updateClientSettings).toHaveBeenCalledExactlyOnceWith(expected);
    expect(settingsState.updateSettings).not.toHaveBeenCalled();
  });

  it("does not substitute another account when the requested instance was removed", () => {
    atoms.providers = [provider()];
    const panel = renderPanel({ targetInstanceId: customId });
    expect(visitElements(panel, (element) => element.props.mode === "editor")).toBeNull();
    expect(settingsState.updateSettings).not.toHaveBeenCalled();
  });

  it("keeps provider selection available while write controls are read only", () => {
    commands.canWriteSettings = false;
    settingsState.value = {
      ...DEFAULT_UNIFIED_SETTINGS,
      providerInstances: {
        [customId]: {
          driver: ProviderDriverKind.make("codex"),
          enabled: true,
        },
      },
    };
    atoms.providers = [provider()];
    let panel = renderPanel({ readOnly: true });

    const inertWrapper = visitElements(panel, (element) => element.props.inert === true);
    expect(inertWrapper).not.toBeNull();

    const customRow = visitElements(
      panel,
      (element) => element.props.instanceId === customId && element.props.mode === "list",
    );
    expect(customRow?.props.readOnly).toBe(true);
    expect(customRow?.props.onSelect).toBeTypeOf("function");
    (customRow?.props.onSelect as (() => void) | undefined)?.();

    panel = renderPanel({ readOnly: true });
    const customEditor = visitElements(
      panel,
      (element) => element.props.instanceId === customId && element.props.mode === "editor",
    );
    expect(customEditor).not.toBeNull();

    const notice = visitElements(panel, (element) => element.props.title === "Limited permissions");
    expect(notice).not.toBeNull();

    expect(visitElements(panel, isRefreshButton)).not.toBeNull();
    expect(visitElements(panel, isAddProviderButton)).toBeNull();
  });

  it("selects another provider during an update and retains it across status refreshes", async () => {
    let finishUpdate!: () => void;
    commands.updateProvider.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishUpdate = () => resolve({ _tag: "Success" });
        }),
    );
    atoms.providers = [provider(), missingAntigravityProvider()];
    settingsState.value = {
      ...DEFAULT_UNIFIED_SETTINGS,
      providerInstances: {
        [antigravityId]: {
          driver: ProviderDriverKind.make("antigravity"),
          enabled: false,
        },
      },
    };
    let panel = renderPanel({ targetInstanceId: codexId });
    const initialEditor = visitElements(panel, (element) => element.props.mode === "editor");
    (initialEditor?.props.onRunUpdate as () => void)();

    panel = renderPanel({ targetInstanceId: codexId });
    const antigravityRow = visitElements(
      panel,
      (element) => element.props.mode === "list" && element.props.instanceId === antigravityId,
    );
    (antigravityRow?.props.onSelect as () => void)();

    for (const status of ["warning", "ready"] as const) {
      atoms.providers = [{ ...provider(), status }, missingAntigravityProvider()];
      panel = renderPanel({ targetInstanceId: codexId });
      expect(
        visitElements(panel, (element) => element.props.mode === "editor")?.props.instanceId,
      ).toBe(antigravityId);
    }

    finishUpdate();
    await flushPromises();
    panel = renderPanel({ targetInstanceId: codexId });
    expect(
      visitElements(panel, (element) => element.props.mode === "editor")?.props.instanceId,
    ).toBe(antigravityId);
    expect(settingsState.updateSettings).not.toHaveBeenCalled();
  });

  it("follows changed deep links without remounting and retains manual picks on refresh", () => {
    atoms.providers = [provider(), missingAntigravityProvider()];
    let panel = renderPanel({ targetInstanceId: codexId });
    expect(
      visitElements(panel, (element) => element.props.mode === "editor")?.props.instanceId,
    ).toBe(codexId);
    panel = renderPanel({ targetInstanceId: antigravityId });
    expect(
      visitElements(panel, (element) => element.props.mode === "editor")?.props.instanceId,
    ).toBe(antigravityId);
    const codexRow = visitElements(
      panel,
      (element) => element.props.mode === "list" && element.props.instanceId === codexId,
    );
    (codexRow?.props.onSelect as () => void)();
    panel = renderPanel({ targetInstanceId: antigravityId });
    expect(
      visitElements(panel, (element) => element.props.mode === "editor")?.props.instanceId,
    ).toBe(codexId);
    panel = renderPanel({ targetInstanceId: codexId });
    expect(
      visitElements(panel, (element) => element.props.mode === "editor")?.props.instanceId,
    ).toBe(codexId);
  });

  it("keeps the editable layout interactive when not read only", () => {
    atoms.providers = [provider()];
    const panel = renderPanel();
    expect(visitElements(panel, (element) => element.props.inert === true)).toBeNull();
    expect(
      visitElements(panel, (element) => element.props.title === "Limited permissions"),
    ).toBeNull();
    expect(visitElements(panel, isRefreshButton)).not.toBeNull();
    expect(visitElements(panel, isAddProviderButton)).not.toBeNull();
  });

  it("removes an open add-instance dialog when the provider grant is revoked", () => {
    let panel = renderPanel();
    const add = visitElements(panel, isAddProviderButton);
    if (!add) throw new Error("Missing Add provider action.");
    (add.props.onClick as () => void)();
    panel = renderPanel();
    expect(
      visitElements(panel, (element) => element.type === AddProviderInstanceDialog),
    ).not.toBeNull();

    commands.canManageProviders = false;
    panel = renderPanel({ readOnly: true });
    expect(
      visitElements(panel, (element) => element.type === AddProviderInstanceDialog),
    ).toBeNull();
    expect(settingsState.updateSettings).not.toHaveBeenCalled();
  });

  it("keeps Advanced visible when search targets the provider health interval", () => {
    let panel = renderPanel();
    expect(visitElements(panel, (element) => element.props.title === "Advanced")).not.toBeNull();
    expect(
      visitElements(panel, (element) => element.props.id === "provider-health-check-interval"),
    ).not.toBeNull();

    settingsSearchState.targetId = "provider-health-check-interval";
    panel = renderPanel();
    expect(visitElements(panel, (element) => element.props.title === "Advanced")).not.toBeNull();
    expect(
      visitElements(panel, (element) => element.props.id === "provider-health-check-interval"),
    ).not.toBeNull();
  });

  it("deletes and resets provider configuration without erasing shared preferences", async () => {
    settingsState.value = {
      ...DEFAULT_UNIFIED_SETTINGS,
      providerInstances: {
        [codexId]: {
          driver: ProviderDriverKind.make("codex"),
          enabled: false,
        },
        [customId]: {
          driver: ProviderDriverKind.make("codex"),
          enabled: true,
        },
      },
      providerModelPreferences: {
        [customId]: { hiddenModels: ["hidden"], modelOrder: ["model"] },
      },
      favorites: [{ provider: customId, model: "favorite" }],
    };
    let panel = renderPanel();
    const customRow = visitElements(
      panel,
      (element) => element.props.instanceId === customId && element.props.mode === "list",
    );
    (customRow?.props.onSelect as (() => void) | undefined)?.();
    panel = renderPanel();
    const customCard = visitElements(
      panel,
      (element) => element.props.instanceId === customId && element.props.mode === "editor",
    );
    expect(customCard).not.toBeNull();
    (customCard?.props.onDelete as (() => void) | undefined)?.();
    await flushPromises();

    expect(settingsState.mutateProviderInstance).toHaveBeenLastCalledWith({
      operation: "remove",
      instanceId: customId,
    });

    settingsState.mutateProviderInstance.mockClear();
    const defaultRow = visitElements(
      panel,
      (element) => element.props.instanceId === codexId && element.props.mode === "list",
    );
    (defaultRow?.props.onSelect as (() => void) | undefined)?.();
    panel = renderPanel();
    const defaultCard = visitElements(
      panel,
      (element) => element.props.instanceId === codexId && element.props.mode === "editor",
    );
    const resetAction = defaultCard?.props.headerAction;
    const resetButton = visitElements(
      resetAction,
      (element) => typeof element.props.onClick === "function",
    );
    expect(resetButton).not.toBeNull();
    (resetButton?.props.onClick as (() => void) | undefined)?.();
    await flushPromises();

    const [resetMutation, resetPatch] = settingsState.mutateProviderInstance.mock.lastCall ?? [];
    expect(resetMutation).toEqual({ operation: "remove", instanceId: codexId });
    // Removing the instance is the whole reset; shared preferences stay untouched.
    expect(resetPatch ?? {}).toEqual({});
  });

  it("updates one provider instance without sending a stale whole map", async () => {
    settingsState.value = {
      ...DEFAULT_UNIFIED_SETTINGS,
      providerInstances: {
        [customId]: {
          driver: ProviderDriverKind.make("codex"),
          enabled: true,
          displayName: "Work",
        },
      },
    };
    const panel = renderPanel();
    const card = visitElements(panel, (element) => element.props.instanceId === customId);
    const next = {
      driver: ProviderDriverKind.make("codex"),
      enabled: false,
      displayName: "Work",
    };
    (card?.props.onUpdate as ((instance: typeof next) => void) | undefined)?.(next);
    await flushPromises();

    expect(settingsState.mutateProviderInstance).toHaveBeenCalledWith(
      { operation: "upsert", instanceId: customId, instance: next },
      {},
    );
  });

  it("lets the server decide managed ACP cleanup after an atomic delete", async () => {
    const firstId = ProviderInstanceId.make("acpRegistry_kilo_one");
    const secondId = ProviderInstanceId.make("acpRegistry_kilo_two");
    const registryInstance = {
      driver: ProviderDriverKind.make("acpRegistry"),
      enabled: true,
      config: { agentId: "kilo" },
    };
    settingsState.value = {
      ...DEFAULT_UNIFIED_SETTINGS,
      providerInstances: {
        [firstId]: registryInstance,
        [secondId]: registryInstance,
      },
    };
    let panel = renderPanel();
    const row = visitElements(
      panel,
      (element) => element.props.instanceId === firstId && element.props.mode === "list",
    );
    (row?.props.onSelect as (() => void) | undefined)?.();
    panel = renderPanel();
    const card = visitElements(
      panel,
      (element) => element.props.instanceId === firstId && element.props.mode === "editor",
    );
    (card?.props.onDelete as (() => void) | undefined)?.();
    await flushPromises();

    expect(settingsState.mutateProviderInstance).toHaveBeenCalledWith({
      operation: "remove",
      instanceId: firstId,
    });
    expect(commands.uninstall).toHaveBeenCalledWith({
      environmentId,
      input: { agentId: "kilo" },
    });
  });

  it("keeps the signed-in ACP account visible when login methods are no longer advertised", () => {
    const instanceId = ProviderInstanceId.make("acpRegistry_devin");
    settingsState.value = {
      ...DEFAULT_UNIFIED_SETTINGS,
      providerInstances: {
        [instanceId]: {
          driver: ProviderDriverKind.make("acpRegistry"),
          enabled: true,
          config: { agentId: "devin" },
        },
      },
    };
    atoms.providers = [
      {
        ...provider(),
        instanceId,
        driver: ProviderDriverKind.make("acpRegistry"),
        auth: { status: "authenticated", canLogout: false },
        setup: { canAuthenticate: false, canInstall: false },
      },
    ];
    const panel = renderPanel({ targetInstanceId: instanceId });
    expect(
      visitElements(
        panel,
        (element) =>
          typeof element.type === "function" &&
          element.type.name === "ProviderAuthenticationSection",
      ),
    ).not.toBeNull();
  });

  it("routes explicit ACP browser authentication consent to the selected environment", async () => {
    const instanceId = ProviderInstanceId.make("acpRegistry_antigravity");
    const action = {
      elicitationId: "google-login-1",
      url: "https://accounts.google.com/login",
      message: "Continue with Google",
    };
    settingsState.value = {
      ...DEFAULT_UNIFIED_SETTINGS,
      providerInstances: {
        [instanceId]: {
          driver: ProviderDriverKind.make("acpRegistry"),
          enabled: true,
          config: { agentId: "antigravity" },
        },
      },
    };
    atoms.providers = [
      {
        ...provider(),
        instanceId,
        driver: ProviderDriverKind.make("acpRegistry"),
        auth: { status: "unauthenticated", action },
      },
    ];

    const panel = renderPanel();
    const card = visitElements(panel, (element) => element.props.instanceId === instanceId);
    (card?.props.onAcceptUrlAuth as ((candidate: typeof action) => void) | undefined)?.(action);
    await flushPromises();

    expect(commands.acceptUrlAuth).toHaveBeenCalledWith({
      environmentId,
      input: { instanceId, elicitationId: action.elicitationId },
    });
  });
});
