import { RegistryContext } from "@effect/atom-react";
import {
  DEFAULT_UNIFIED_SETTINGS,
  // SCIENT-FORK:START
  DEFAULT_SERVER_SETTINGS,
  type ProviderManagedRuntimeAction,
  // SCIENT-FORK:END
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
  type UnifiedSettings,
} from "@t3tools/contracts";
import { AsyncResult, type Atom } from "effect/reactivity";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import "~/index.css";
// SCIENT-FORK:START
import { DRIVER_OPTIONS } from "./providerDriverMeta";
import { applyServerSettingsPatch } from "@t3tools/shared/serverSettings";
// SCIENT-FORK:END
import { act, render } from "../../../test/render";

const state = vi.hoisted(() => ({
  // SCIENT-FORK: null models a provider snapshot that is still loading.
  providers: null as unknown as Atom.Writable<ReadonlyArray<ServerProvider> | null>,
  settings: null as unknown as UnifiedSettings,
  canManageProviders: true,
  canWriteSettings: true,
  searchTargetId: null as string | null,
  readEnvironmentIds: [] as string[],
  updateEnvironmentIds: [] as string[],
  mutationEnvironmentIds: [] as string[],
  // SCIENT-FORK: record the environment that model preference writes go to.
  modelPreferenceEnvironmentIds: [] as string[],
  refresh: vi.fn(),
  updateProvider: vi.fn(),
  uninstall: vi.fn(),
  acceptUrlAuth: vi.fn(),
  updateSettings: vi.fn(),
  updateModelPreferences: vi.fn(),
  toggleFavorite: vi.fn(),
  mutateProviderInstance: vi.fn(),
}));

vi.mock(import("../../state/server"), async (original) => {
  const actual = await original();
  const { Atom } = await import("effect/reactivity");
  // SCIENT-FORK:START - the upstream settings snapshot coalesces a pending raw snapshot.
  const providers = Atom.make<ReadonlyArray<ServerProvider> | null>(null).pipe(Atom.keepAlive);
  const settingsProviders = Atom.make((get) => get(providers) ?? []);
  // SCIENT-FORK:END
  state.providers = providers;
  const config = Atom.make(null);
  const commandLabels = {
    refreshProviders: "refresh",
    updateProvider: "update",
    uninstallAcpRegistryManagedBinary: "uninstall",
    acceptAcpRegistryUrlAuth: "accept-url-auth",
  } as const;
  const labelled = Object.fromEntries(
    Object.entries(commandLabels).map(([key, label]) => [
      key,
      { ...actual.serverEnvironment[key as keyof typeof commandLabels], label },
    ]),
  );
  return {
    ...actual,
    // SCIENT-FORK: read the coalesced snapshot.
    providersIgnoringCheckedAtAtom: (() => settingsProviders) as never,
    serverEnvironment: {
      ...actual.serverEnvironment,
      ...labelled,
      configValueAtom: (() => config) as never,
      providersValueAtom: (() => providers) as never,
    } as never,
  };
});
vi.mock(import("../../state/use-atom-command"), async (original) => ({
  ...(await original()),
  useAtomCommand: ((command: { label?: string }) =>
    ({
      refresh: state.refresh,
      update: state.updateProvider,
      uninstall: state.uninstall,
      "accept-url-auth": state.acceptUrlAuth,
    })[command.label ?? ""] ?? vi.fn()) as never,
}));
vi.mock(import("../../state/query"), async (original) => ({
  ...(await original()),
  useEnvironmentQuery: (() => ({
    data: null,
    error: null,
    isPending: false,
    refresh: vi.fn(),
  })) as never,
}));
vi.mock(import("../../hooks/useSettings"), async (original) => ({
  ...(await original()),
  useEnvironmentSettings: ((environmentId: string) => {
    state.readEnvironmentIds.push(environmentId);
    return state.settings;
  }) as never,
  useUpdateEnvironmentSettings: ((environmentId: string) => {
    state.updateEnvironmentIds.push(environmentId);
    return state.updateSettings;
  }) as never,
  // SCIENT-FORK:START - record the environment that model preference writes go to.
  useUpdateEnvironmentModelPreferences: ((environmentId: string) => {
    state.modelPreferenceEnvironmentIds.push(environmentId);
    return state.updateModelPreferences;
  }) as never,
  // SCIENT-FORK:END
  useToggleEnvironmentModelFavorite: (() => state.toggleFavorite) as never,
  usePersistEnvironmentProviderInstanceMutation: ((environmentId: string) => {
    state.mutationEnvironmentIds.push(environmentId);
    return state.mutateProviderInstance;
  }) as never,
}));
vi.mock(import("../../state/session"), async (original) => {
  const scope = (environmentId: string, requested: string) =>
    environmentId === "remote-device" &&
    (requested === "providers:manage"
      ? state.canManageProviders
      : requested === "settings:write"
        ? state.canWriteSettings
        : requested === "orchestration:read");
  return {
    ...(await original()),
    useEnvironmentScope: scope as never,
    readEnvironmentScope: scope as never,
  };
});
vi.mock(import("../../state/entities"), async (original) => ({
  ...(await original()),
  useProjects: (() => []) as never,
}));
vi.mock(import("./settingsLayout"), async (original) => ({
  ...(await original()),
  useSettingsSearchTargetId: () => state.searchTargetId,
  // The real row reads write permission and overrides from live environment state.
  SettingsRow: (({
    id,
    title,
    description,
    status,
    control,
    children,
  }: {
    id?: string;
    title: ReactNode;
    description?: ReactNode;
    status?: ReactNode;
    control?: ReactNode;
    children?: ReactNode;
  }) => (
    <div id={id}>
      <h4>{title}</h4>
      {description}
      {status}
      {control}
      {children}
    </div>
  )) as never,
}));
// Its own data flows are covered by its suite; this one is about the panel.
vi.mock(import("./UsageProviderSettings"), async (original) => ({
  ...(await original()),
  UsageProviderSettings: (() => null) as never,
}));
vi.mock(import("../ProviderUpdatesAction"), async (original) => ({
  ...(await original()),
  ProviderUpdatesAction: (() => null) as never,
}));

// SCIENT-FORK:START - isolate lifecycle execution while exercising panel routing through DOM events.
vi.mock("../../scient/providerConnection/ProviderConnectionDialog", () => ({
  ProviderConnectionDialog: ({
    provider,
    initialRuntimeAction,
  }: {
    provider: ServerProvider;
    initialRuntimeAction?: ProviderManagedRuntimeAction;
  }) => (
    <div
      role="dialog"
      aria-label="Provider connection"
      data-instance-id={provider.instanceId}
      data-runtime-action={initialRuntimeAction ?? ""}
    />
  ),
}));
vi.mock("../../scient/providerConnection/ProviderSettingsLifecycleAction", () => ({
  ProviderSettingsLifecycleAction: ({
    displayName,
    onManage,
  }: {
    displayName: string;
    onManage: (action?: ProviderManagedRuntimeAction) => void;
  }) => (
    <div>
      <button aria-label={`Manage ${displayName}`} onClick={() => onManage()}>
        Manage
      </button>
      <button onClick={() => onManage("install")}>Request install</button>
    </div>
  ),
}));
// SCIENT-FORK:END

import { appAtomRegistry } from "~/rpc/atomRegistry";
import { EnvironmentProviderSettings } from "./ProviderSettingsPanel";

const environmentId = EnvironmentId.make("remote-device");
const codexId = ProviderInstanceId.make("codex");
const customId = ProviderInstanceId.make("codex_work");

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
    models: [{ slug: "chosen", name: "Chosen", isCustom: false, capabilities: null }],
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

// SCIENT-FORK: null models a provider snapshot that is still loading.
const setProviders = (providers: ReadonlyArray<ServerProvider> | null) =>
  act(async () => appAtomRegistry.set(state.providers, providers));

function panel(options?: {
  readonly readOnly?: boolean;
  readonly targetInstanceId?: ProviderInstanceId;
}) {
  return (
    <RegistryContext.Provider value={appAtomRegistry}>
      <div className="@container/providers">
        <EnvironmentProviderSettings
          environmentId={environmentId}
          environmentLabel="Remote device"
          {...(options?.readOnly === undefined ? {} : { readOnly: options.readOnly })}
          {...(options?.targetInstanceId === undefined
            ? {}
            : { targetInstanceId: options.targetInstanceId })}
        />
      </div>
    </RegistryContext.Provider>
  );
}

// SCIENT-FORK:START - helpers for the Scient cases below.
const button = (name: string) => page.getByRole("button", { name, exact: true });
// The section header and the end of the provider list both offer Add provider.
const addProvider = () => page.getByRole("button", { name: "Add provider" }).first();
const select = (name: string) => button(`Select ${name}`);
// SCIENT-FORK:END

async function setup() {
  await page.viewport(1280, 900);
  state.settings = DEFAULT_UNIFIED_SETTINGS;
  state.canManageProviders = true;
  state.canWriteSettings = true;
  state.searchTargetId = null;
  state.readEnvironmentIds = [];
  state.updateEnvironmentIds = [];
  state.mutationEnvironmentIds = [];
  state.modelPreferenceEnvironmentIds = []; // SCIENT-FORK
  state.updateSettings.mockReset();
  state.updateModelPreferences.mockReset();
  state.toggleFavorite.mockReset();
  state.mutateProviderInstance.mockReset().mockResolvedValue(AsyncResult.success({}));
  state.refresh.mockReset().mockResolvedValue(AsyncResult.success(undefined));
  state.updateProvider.mockReset().mockResolvedValue(AsyncResult.success(undefined));
  state.uninstall.mockReset().mockResolvedValue(AsyncResult.success({}));
  state.acceptUrlAuth.mockReset().mockResolvedValue(AsyncResult.success({ accepted: true }));
  await setProviders([]);
}

describe("EnvironmentProviderSettings routing", () => {
  // SCIENT-FORK:START - untouched slots are visible without enabling or configuring them.
  // regression: ca83f106e8 fix(settings): retain unconfigured built-in provider rows
  it.each(["loading", "empty", "partial"])(
    "shows built-in default slots with fresh settings and %s provider snapshots without writes",
    async (snapshot) => {
      await setup();
      state.settings = { ...DEFAULT_UNIFIED_SETTINGS, providerInstances: {} };
      await setProviders(
        snapshot === "loading" ? null : snapshot === "partial" ? [provider()] : [],
      );
      await using screen = await render(panel());
      const expected = DRIVER_OPTIONS.filter((option) => option.hasDefaultInstance !== false);
      expect(
        [...screen.container.querySelectorAll('button[aria-label^="Select "]')].map((element) =>
          element.getAttribute("aria-label"),
        ),
      ).toEqual(expected.map((option) => `Select ${option.label}`));
      for (const driver of ["cursor", "grok", "pi", "opencode", "muse"]) {
        const option = DRIVER_OPTIONS.find((option) => option.value === driver)!;
        expect(
          screen.container
            .querySelector(`[role="switch"][aria-label="Enable ${option.label}"]`)
            ?.getAttribute("aria-checked"),
        ).toBe("false");
      }
      expect(state.settings.providerInstances).toEqual({});
      expect(state.mutateProviderInstance).not.toHaveBeenCalled();
      expect(state.updateSettings).not.toHaveBeenCalled();
      expect(state.updateProvider).not.toHaveBeenCalled();
    },
  );
  // SCIENT-FORK:END

  it("does not substitute another account when the requested instance was removed", async () => {
    await setup();
    await setProviders([provider()]);
    await using _screen = await render(panel({ targetInstanceId: customId }));
    await expect
      .element(page.getByText("This provider instance is no longer available on this device."))
      .toBeVisible();
    expect(state.updateSettings).not.toHaveBeenCalled();
  });

  it("updates one provider instance without sending a stale whole map", async () => {
    await setup();
    state.settings = {
      ...DEFAULT_UNIFIED_SETTINGS,
      providerInstances: {
        [customId]: {
          driver: ProviderDriverKind.make("codex"),
          enabled: true,
          displayName: "Work",
        },
      },
    };
    await using _screen = await render(panel());
    await userEvent.click(page.getByRole("switch", { name: "Enable Work" }).first());

    expect(state.mutateProviderInstance).toHaveBeenCalledWith(
      {
        operation: "upsert",
        instanceId: customId,
        instance: { driver: ProviderDriverKind.make("codex"), enabled: false, displayName: "Work" },
      },
      {},
    );
  });

  it("routes explicit ACP browser authentication consent to the selected environment", async () => {
    await setup();
    const instanceId = ProviderInstanceId.make("acpRegistry_antigravity");
    const action = {
      elicitationId: "google-login-1",
      url: "https://accounts.google.com/login",
      message: "Continue with Google",
    };
    state.settings = {
      ...DEFAULT_UNIFIED_SETTINGS,
      providerInstances: {
        [instanceId]: {
          driver: ProviderDriverKind.make("acpRegistry"),
          enabled: true,
          config: { agentId: "antigravity" },
        },
      },
    };
    await setProviders([
      {
        ...provider(),
        instanceId,
        driver: ProviderDriverKind.make("acpRegistry"),
        auth: { status: "unauthenticated", action },
      },
    ]);
    await using _screen = await render(panel({ targetInstanceId: instanceId }));
    const link = page.getByRole("link", { name: "Continue authentication" });
    link.element().addEventListener("click", (event) => event.preventDefault());
    await userEvent.click(link);

    expect(state.acceptUrlAuth).toHaveBeenCalledWith({
      environmentId,
      input: { instanceId, elicitationId: action.elicitationId },
    });
  });
});

// SCIENT-FORK:START - preserve default inventory, preference writes, selection and lifecycle intents.
const antigravityId = ProviderInstanceId.make("antigravity");
function missingAntigravityProvider(): ServerProvider {
  return {
    ...provider(),
    instanceId: antigravityId,
    driver: ProviderDriverKind.make("antigravity"),
    installed: false,
    version: null,
    status: "error",
    auth: { status: "unknown", required: true },
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

describe("Scient provider settings", () => {
  it("renders default rows in canonical order with custom instances grouped after their driver", async () => {
    await setup();
    const scientId = ProviderInstanceId.make("scient_research");
    const acpId = ProviderInstanceId.make("acpRegistry_devin");
    state.settings = {
      ...DEFAULT_UNIFIED_SETTINGS,
      providerInstances: {
        [scientId]: {
          driver: ProviderDriverKind.make("scient"),
          enabled: true,
          displayName: "Research",
        },
        [customId]: {
          driver: ProviderDriverKind.make("codex"),
          enabled: true,
          displayName: "Work",
        },
        [acpId]: {
          driver: ProviderDriverKind.make("acpRegistry"),
          enabled: true,
          displayName: "Devin",
          config: { agentId: "devin" },
        },
      },
    };
    await using screen = await render(panel());
    expect(
      [...screen.container.querySelectorAll('button[aria-label^="Select "]')].map((element) =>
        element.getAttribute("aria-label"),
      ),
    ).toEqual([
      "Select Scient",
      "Select Research",
      "Select Codex",
      "Select Work",
      "Select Claude",
      "Select Antigravity",
      "Select OpenCode",
      "Select Droid",
      "Select Pi",
      "Select Oh My Pi",
      "Select Cursor",
      "Select Grok",
      "Select Devin",
      "Select Muse Code",
    ]);
    expect(state.mutateProviderInstance).not.toHaveBeenCalled();
    expect(state.updateSettings).not.toHaveBeenCalled();
    expect(state.updateProvider).not.toHaveBeenCalled();
  });

  // regression: 89974f96b6 fix(alignment): preserve Scient provider and lifecycle behavior
  it("renders Add provider choices in canonical order without changing settings", async () => {
    await setup();
    await using _screen = await render(panel());
    await userEvent.click(addProvider());
    const choices = [...document.querySelectorAll('[role="radio"]')].filter(
      (element) =>
        element.getAttribute("aria-disabled") !== "true" && !element.hasAttribute("disabled"),
    );
    expect(choices.map((element) => element.querySelector(".font-medium")?.textContent)).toEqual(
      DRIVER_OPTIONS.filter((option) => option.value !== "acpRegistry").map(
        (option) => option.label,
      ),
    );
    expect(state.mutateProviderInstance).not.toHaveBeenCalled();
    expect(state.updateSettings).not.toHaveBeenCalled();
    expect(state.updateProvider).not.toHaveBeenCalled();
  });

  it("keeps explicitly configured provider slots visible when disabled", async () => {
    await setup();
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
    ];
    state.settings = {
      ...DEFAULT_UNIFIED_SETTINGS,
      providerInstances: Object.fromEntries(
        drivers.map((driver) => [
          driver,
          { driver: ProviderDriverKind.make(driver), enabled: false },
        ]),
      ),
    };
    await setProviders([
      {
        ...provider(),
        instanceId: ProviderInstanceId.make("cursor"),
        driver: ProviderDriverKind.make("cursor"),
        enabled: false,
      },
    ]);
    await using _screen = await render(panel());
    for (const driver of drivers) {
      const option = DRIVER_OPTIONS.find((option) => option.value === driver)!;
      await expect.element(select(option.label)).toBeVisible();
    }
    expect(state.mutateProviderInstance).not.toHaveBeenCalled();
    expect(state.updateSettings).not.toHaveBeenCalled();
  });

  it("opens and enables an explicitly disabled instance through its exact environment", async () => {
    await setup();
    const instanceId = ProviderInstanceId.make("droid");
    state.settings = {
      ...DEFAULT_UNIFIED_SETTINGS,
      providerInstances: {
        [instanceId]: { driver: ProviderDriverKind.make("droid"), enabled: false },
      },
    };
    await using _screen = await render(panel({ targetInstanceId: instanceId }));
    await userEvent.click(select("Droid"));
    expect(state.mutateProviderInstance).not.toHaveBeenCalled();
    await userEvent.click(page.getByRole("switch", { name: "Enable Droid", exact: true }));
    expect(state.mutateProviderInstance).toHaveBeenCalledExactlyOnceWith(
      {
        operation: "upsert",
        instanceId,
        instance: { driver: ProviderDriverKind.make("droid"), enabled: true },
      },
      {},
    );
    expect(new Set(state.mutationEnvironmentIds)).toEqual(new Set([environmentId]));
  });

  // regression: b96d7d6a43 fix(alignment): preserve catalog identity and refresh seam witnesses
  it.each(
    // pi, omp and scient share one catalog-default branch (resolveProviderModelPreferences).
    ["missing", "empty"].map((preferences) => ({ driver: "pi", preferences })),
  )(
    "saves $driver visibility on its owning environment with $preferences preferences",
    async ({ driver, preferences }) => {
      await setup();
      const instanceId = ProviderInstanceId.make(driver);
      const models = [
        "anthropic/claude-haiku-4-5",
        "anthropic/claude-opus-5-5",
        "google-antigravity/claude-opus-4-5",
        "google-antigravity/claude-opus-4-6",
        "google-antigravity/gemini-3.8-flash",
        "google-antigravity/gemini-3.1-pro",
      ].map((slug) => ({ slug, name: slug, isCustom: false, capabilities: {} }));
      const curatedHidden = ["anthropic/claude-haiku-4-5", "google-antigravity/claude-opus-4-5"];
      const initialPreferences =
        preferences === "empty" ? { [instanceId]: { hiddenModels: [], modelOrder: [] } } : {};
      state.settings = {
        ...DEFAULT_UNIFIED_SETTINGS,
        providerInstances: {
          [instanceId]: { driver: ProviderDriverKind.make(driver), enabled: true },
        },
        providerModelPreferences: initialPreferences,
      };
      await setProviders([
        { ...provider(), instanceId, driver: ProviderDriverKind.make(driver), models },
      ]);
      await using screen = await render(panel({ targetInstanceId: instanceId }));
      const hiddenModels = preferences === "missing" ? curatedHidden : [];
      const modelOrder = models.map((model) => model.slug);
      for (const model of models) {
        const toggle = page
          .getByRole("switch", { name: `Show ${model.name} in the model picker` })
          .element();
        expect(toggle.getAttribute("aria-checked")).toBe(
          String(!hiddenModels.includes(model.slug)),
        );
      }
      const nextHidden = preferences === "missing" ? [] : ["anthropic/claude-opus-5-5"];
      if (preferences === "missing") {
        for (const model of curatedHidden)
          await userEvent.click(
            page.getByRole("switch", { name: `Show ${model} in the model picker` }),
          );
      } else {
        await userEvent.click(
          page.getByRole("switch", { name: "Show anthropic/claude-opus-5-5 in the model picker" }),
        );
      }
      const changes = state.updateModelPreferences.mock.calls.flatMap(
        ([patch]) => patch.setModelsHidden ?? [],
      );
      expect(changes).toEqual(
        (preferences === "missing" ? curatedHidden : nextHidden).map((model) => ({
          provider: instanceId,
          model,
          hidden: nextHidden.includes(model),
          initialPreferences: { hiddenModels, modelOrder },
        })),
      );
      expect(new Set(state.modelPreferenceEnvironmentIds)).toEqual(new Set([environmentId]));
      expect(state.updateSettings).not.toHaveBeenCalled();
      const saved = applyServerSettingsPatch(
        { ...DEFAULT_SERVER_SETTINGS, providerModelPreferences: initialPreferences },
        { setModelsHidden: changes },
      ).providerModelPreferences;
      expect(saved?.[instanceId]).toEqual({
        hiddenModels: nextHidden,
        modelOrder: preferences === "missing" ? modelOrder : [],
      });
      state.settings = { ...state.settings, providerModelPreferences: saved ?? {} };
      await screen.rerender(panel({ targetInstanceId: instanceId }));
      for (const model of models)
        expect(
          page
            .getByRole("switch", { name: `Show ${model.name} in the model picker` })
            .element()
            .getAttribute("aria-checked"),
        ).toBe(String(!nextHidden.includes(model.slug)));
    },
  );

  it("saves model order on the owning environment with the initial catalog preferences", async () => {
    await setup();
    await setProviders([
      {
        ...provider(),
        models: [
          { slug: "chosen", name: "Chosen", isCustom: false, capabilities: null },
          { slug: "second", name: "Second", isCustom: false, capabilities: null },
        ],
      },
    ]);
    await using _screen = await render(panel({ targetInstanceId: codexId }));
    await userEvent.click(button("Move Chosen down"));
    expect(state.updateModelPreferences).toHaveBeenCalledExactlyOnceWith({
      setProviderModelOrder: {
        provider: codexId,
        modelOrder: ["second", "chosen"],
        initialPreferences: { hiddenModels: [], modelOrder: [] },
      },
    });
    expect(new Set(state.modelPreferenceEnvironmentIds)).toEqual(new Set([environmentId]));
    expect(state.updateSettings).not.toHaveBeenCalled();
  });

  // regression: 4f8a2ef99e fix(providers): install and update directly with quiet settings progress
  it.each([undefined, "install"] as const)(
    "opens a missing provider with only the requested action (%s)",
    async (action) => {
      await setup();
      await setProviders([missingAntigravityProvider()]);
      await using _screen = await render(panel({ targetInstanceId: antigravityId }));
      await userEvent.click(select("Antigravity"));
      await userEvent.click(action ? button("Request install") : button("Manage Antigravity"));
      const dialog = page.getByRole("dialog", { name: "Provider connection" }).element();
      expect(dialog.getAttribute("data-instance-id")).toBe(antigravityId);
      expect(dialog.getAttribute("data-runtime-action")).toBe(action ?? "");
    },
  );

  // regression: 173a24544e fix(web): make provider rows fully selectable
  it("selects another provider during an update and retains it across status refreshes", async () => {
    await setup();
    let finishUpdate!: () => void;
    state.updateProvider.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishUpdate = () => resolve(AsyncResult.success(undefined));
        }),
    );
    await setProviders([provider(), missingAntigravityProvider()]);
    state.settings = {
      ...DEFAULT_UNIFIED_SETTINGS,
      providerInstances: {
        [antigravityId]: { driver: ProviderDriverKind.make("antigravity"), enabled: false },
      },
    };
    await using _screen = await render(panel({ targetInstanceId: codexId }));
    await userEvent.click(page.getByRole("button", { name: /view details/ }).last());
    await userEvent.click(button("Update now"));
    await userEvent.click(select("Antigravity"));
    for (const status of ["warning", "ready"] as const) {
      await setProviders([{ ...provider(), status }, missingAntigravityProvider()]);
      expect(select("Antigravity").element().getAttribute("aria-pressed")).toBe("true");
    }
    await act(async () => finishUpdate());
    expect(select("Antigravity").element().getAttribute("aria-pressed")).toBe("true");
    expect(state.updateSettings).not.toHaveBeenCalled();
  });

  // regression: a382619321 fix(settings): follow deep links without resetting page state
  it("follows changed deep links without remounting and retains manual picks on refresh", async () => {
    await setup();
    await setProviders([provider(), missingAntigravityProvider()]);
    await using screen = await render(panel({ targetInstanceId: codexId }));
    expect(select("Codex").element().getAttribute("aria-pressed")).toBe("true");
    await screen.rerender(panel({ targetInstanceId: antigravityId }));
    expect(select("Antigravity").element().getAttribute("aria-pressed")).toBe("true");
    await userEvent.click(select("Codex"));
    await setProviders([
      { ...provider(), checkedAt: "2026-10-19T00:00:00.000Z" },
      missingAntigravityProvider(),
    ]);
    expect(select("Codex").element().getAttribute("aria-pressed")).toBe("true");
    await screen.rerender(panel({ targetInstanceId: codexId }));
    expect(select("Codex").element().getAttribute("aria-pressed")).toBe("true");
  });
});
// SCIENT-FORK:END
