import { act, render } from "../../../test/render";
import {
  AuthProvidersManageScope,
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  sessionGrantsScope,
  type AuthEnvironmentScope,
  type ServerProvider,
} from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";
import { useSyncExternalStore } from "react";

interface RecordedToast {
  readonly title: string;
  readonly actionProps: {
    readonly children: string;
    readonly disabled?: boolean;
    readonly onClick: () => void;
  };
  readonly data: {
    readonly onClose: () => void;
    readonly actionLayout?: string;
    readonly actionVariant?: string;
    readonly secondaryActionProps?: { readonly children: string; readonly onClick: () => void };
  };
}

const state = vi.hoisted(() => ({
  revision: 0,
  listeners: new Set<() => void>(),
  primary: undefined as EnvironmentId | undefined,
  permissions: new Map<EnvironmentId, ReadonlyArray<AuthEnvironmentScope>>(),
  environments: [] as Array<{
    environmentId: EnvironmentId;
    label: string;
    connection: { phase: string };
    serverConfig: object | null;
  }>,
  providers: new Map<EnvironmentId, ReadonlyArray<ServerProvider>>(),
  toasts: [] as RecordedToast[],
  closed: [] as string[],
  cliUpdate: vi.fn<(input: unknown) => Promise<unknown>>(),
  managedUpdate: vi.fn<(targets: ReadonlyArray<unknown>) => Promise<unknown>>(),
  navigate: vi.fn(),
}));

vi.mock("~/env", () => ({ isElectron: false }));
vi.mock("@tanstack/react-router", async (actual) => ({
  ...(await actual<typeof import("@tanstack/react-router")>()),
  useNavigate: () => state.navigate,
}));
vi.mock("~/state/environments", () => ({
  useEnvironments: () => {
    useSyncExternalStore(subscribe, () => state.revision);
    return { environments: state.environments };
  },
  useEnvironmentProviders: () => new Map(state.providers),
  usePrimaryEnvironmentId: () => state.primary,
}));
vi.mock("~/state/use-atom-command", () => ({
  useAtomCommand: () => state.cliUpdate,
}));
vi.mock("~/state/server", () => ({
  serverEnvironment: { updateProvider: {} },
}));
vi.mock("~/state/session", () => ({
  useEnvironmentsWithScope: (
    environments: ReadonlyArray<{ readonly environmentId: EnvironmentId }>,
    scope: AuthEnvironmentScope,
  ) => {
    useSyncExternalStore(subscribe, () => state.revision);
    return new Set(
      environments
        .filter(({ environmentId }) =>
          sessionGrantsScope(
            { authenticated: true, permissions: state.permissions.get(environmentId) ?? [] },
            scope,
          ),
        )
        .map(({ environmentId }) => environmentId),
    );
  },
  readEnvironmentScope: (environmentId: EnvironmentId, scope: AuthEnvironmentScope) =>
    sessionGrantsScope(
      { authenticated: true, permissions: state.permissions.get(environmentId) ?? [] },
      scope,
    ),
}));
vi.mock("./useManagedRuntimeUpdates", async (actual) => {
  const { connectedProviderEnvironments } =
    await actual<typeof import("./useManagedRuntimeUpdates")>();
  const { collectManagedRuntimeUpdateCandidates, managedRuntimeUpdateTargets } =
    await import("./ManagedRuntimeUpdateNotification.logic");
  return {
    connectedProviderEnvironments,
    useManagedRuntimeUpdates: () => {
      const candidates = collectManagedRuntimeUpdateCandidates(
        connectedProviderEnvironments(state.environments, state.providers),
      );
      return {
        candidates,
        targets: managedRuntimeUpdateTargets(candidates),
        update: state.managedUpdate,
      };
    },
  };
});
vi.mock("~/components/ui/toast", async () => ({
  stackedThreadToast: (await import("~/components/ui/toastHelpers")).stackedThreadToast,
  toastManager: {
    add: (options: RecordedToast) => {
      state.toasts.push(options);
      return String(state.toasts.length - 1);
    },
    close: (id: string) => {
      state.closed.push(id);
      state.toasts[Number(id)]?.data.onClose();
    },
    update: (id: string, options: object) => {
      Object.assign(state.toasts[Number(id)]!, options);
    },
  },
}));

import { BrowserProviderUpdateNotification } from "./BrowserProviderUpdateNotification";

const storageKey = "t3code:provider-update-dismissals:v1";
let fixtureId = 0;

function subscribe(listener: () => void) {
  state.listeners.add(listener);
  return () => {
    state.listeners.delete(listener);
  };
}

function setup() {
  const id = ++fixtureId;
  const environmentId = EnvironmentId.make(`availability-${id}`);
  state.revision = 0;
  state.listeners.clear();
  state.primary = environmentId;
  state.permissions = new Map([[environmentId, [AuthProvidersManageScope]]]);
  state.environments = [
    {
      environmentId,
      label: "Research machine",
      connection: { phase: "connected" },
      serverConfig: {},
    },
  ];
  state.providers = new Map();
  state.toasts = [];
  state.closed = [];
  state.cliUpdate.mockReset().mockResolvedValue({ _tag: "Success", value: { providers: [] } });
  state.managedUpdate.mockReset().mockResolvedValue([]);
  state.navigate.mockReset();
  const storage = new Map<string, string>();
  const changes = new DisposableStack();
  changes.use(
    vi.spyOn(Storage.prototype, "getItem").mockImplementation((key) => storage.get(key) ?? null),
  );
  changes.use(
    vi.spyOn(Storage.prototype, "setItem").mockImplementation((key, value) => {
      storage.set(key, value);
    }),
  );
  const latest = `1.1.${id}`;
  const provider: ServerProvider = {
    instanceId: ProviderInstanceId.make("codex"),
    driver: ProviderDriverKind.make("codex"),
    enabled: true,
    installed: true,
    version: "1.0.0",
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-10-18T10:00:00.000Z",
    models: [],
    slashCommands: [],
    skills: [],
    versionAdvisory: {
      status: "behind_latest",
      currentVersion: "1.0.0",
      latestVersion: latest,
      canUpdate: false,
      updateCommand: null,
      checkedAt: "2026-10-18T10:00:00.000Z",
      message: "Update available.",
    },
  };
  const managed: ServerProvider = {
    ...provider,
    connection: {
      methods: [],
      canDisconnect: true,
      operation: null,
      runtime: {
        source: "scient_managed",
        supportTier: "fully_assisted",
        target: "linux-x64",
        actions: ["update"],
        managedVersion: "1.0.0",
        availableManagedVersion: latest,
        previousManagedVersion: null,
        message: "Managed Codex.",
        operation: null,
      },
    },
  };
  const cliProvider: ServerProvider = {
    ...provider,
    versionAdvisory: {
      ...provider.versionAdvisory!,
      canUpdate: true,
      updateCommand: "npm update -g provider",
    },
  };
  return {
    environmentId,
    provider,
    managed,
    cliProvider,
    latest,
    storage,
    publish: (providers: ReadonlyArray<ServerProvider>) => {
      state.providers.set(environmentId, providers);
      state.revision++;
      for (const listener of state.listeners) listener();
    },
    [Symbol.dispose]() {
      changes.dispose();
    },
  };
}

describe("browser provider-update availability", () => {
  it("offers Settings for a browser provider without a one-click command", async () => {
    using fixture = setup();
    fixture.publish([fixture.provider]);
    await using _screen = await render(<BrowserProviderUpdateNotification />);
    expect(state.toasts).toHaveLength(1);
    const toast = state.toasts[0]!;
    expect(toast.title).toContain(fixture.latest);
    expect(toast.actionProps.children).toBe("Settings");
    await act(() => toast.actionProps.onClick());
    expect(state.navigate).toHaveBeenCalledWith({ to: "/settings/providers" });
    expect(state.cliUpdate).not.toHaveBeenCalled();
    expect(fixture.storage.has(storageKey)).toBe(false);
  });

  it("opens exact managed-provider settings without dispatching or dismissing", async () => {
    using fixture = setup();
    fixture.publish([fixture.managed]);
    await using _screen = await render(<BrowserProviderUpdateNotification />);
    expect(state.toasts).toHaveLength(1);
    const toast = state.toasts[0]!;
    expect(toast.actionProps.children).toBe("Update");
    await act(() => toast.data.secondaryActionProps!.onClick());
    expect(state.navigate).toHaveBeenCalledWith({
      to: "/settings/providers",
      search: { environmentId: fixture.environmentId, instanceId: fixture.managed.instanceId },
    });
    expect(state.managedUpdate).not.toHaveBeenCalled();
    expect(fixture.storage.has(storageKey)).toBe(false);
  });

  it("delegates a one-click CLI update once rather than starting a second update owner", async () => {
    using fixture = setup();
    fixture.publish([fixture.cliProvider]);
    await using _screen = await render(<BrowserProviderUpdateNotification />);
    const toast = state.toasts[0]!;
    expect(toast.actionProps.children).toBe("Update");
    await act(() => {
      toast.actionProps.onClick();
      toast.actionProps.onClick();
    });
    expect(state.cliUpdate).toHaveBeenCalledExactlyOnceWith({
      environmentId: fixture.environmentId,
      input: { provider: fixture.provider.driver, instanceId: fixture.provider.instanceId },
    });
    expect(state.managedUpdate).not.toHaveBeenCalled();
  });

  it.each(["queued", "running"] as const)(
    "keeps Settings available when a %s CLI update fails in a read-only browser",
    async (status) => {
      using fixture = setup();
      state.permissions.set(fixture.environmentId, []);
      const updateState = {
        status,
        startedAt: "2026-10-18T10:00:00.000Z",
        finishedAt: null,
        message: "Updating provider.",
        output: null,
      };
      fixture.publish([{ ...fixture.cliProvider, updateState }]);
      await using _screen = await render(<BrowserProviderUpdateNotification />);
      const toast = state.toasts[0]!;
      expect(toast.actionProps.children).toBe("Settings");
      expect(toast.data.secondaryActionProps).toBeUndefined();
      await act(() =>
        fixture.publish([
          {
            ...fixture.cliProvider,
            updateState: {
              ...updateState,
              status: "failed",
              finishedAt: "2026-10-18T10:00:01.000Z",
              message: "Update failed.",
            },
          },
        ]),
      );
      expect(state.toasts).toHaveLength(1);
      expect(toast.actionProps.children).toBe("Update");
      expect(toast.actionProps.disabled).toBe(true);
      expect(toast.data).toMatchObject({ actionLayout: "stacked-end", actionVariant: "outline" });
      await act(() => toast.actionProps.onClick());
      expect(state.cliUpdate).not.toHaveBeenCalled();
      expect(state.closed).toEqual([]);
      expect(toast.data.secondaryActionProps?.children).toBe("Settings");
      await act(() => toast.data.secondaryActionProps!.onClick());
      expect(state.navigate).toHaveBeenCalledExactlyOnceWith({ to: "/settings/providers" });
      expect(fixture.storage.has(storageKey)).toBe(false);
    },
  );

  it("removes the secondary action when the same CLI notice becomes Settings-only", async () => {
    using fixture = setup();
    fixture.publish([fixture.cliProvider]);
    await using _screen = await render(<BrowserProviderUpdateNotification />);
    const toast = state.toasts[0]!;
    const oldUpdate = toast.actionProps.onClick;
    expect(toast.data.secondaryActionProps?.children).toBe("Settings");
    await act(() =>
      fixture.publish([
        {
          ...fixture.cliProvider,
          updateState: {
            status: "running",
            startedAt: "2026-10-18T10:00:00.000Z",
            finishedAt: null,
            message: "Updating provider.",
            output: null,
          },
        },
      ]),
    );
    expect(state.toasts).toHaveLength(1);
    expect(toast.actionProps.children).toBe("Settings");
    expect(toast.data.secondaryActionProps).toBeUndefined();
    expect(toast.data).toMatchObject({ actionLayout: "stacked-end", actionVariant: "outline" });
    await act(() => oldUpdate());
    expect(state.cliUpdate).not.toHaveBeenCalled();
    expect(state.closed).toEqual([]);
    await act(() => toast.actionProps.onClick());
    expect(state.navigate).toHaveBeenCalledExactlyOnceWith({ to: "/settings/providers" });
    expect(fixture.storage.has(storageKey)).toBe(false);
  });

  it("delegates a managed update once and fences repeated callbacks", async () => {
    using fixture = setup();
    fixture.publish([fixture.managed]);
    await using _screen = await render(<BrowserProviderUpdateNotification />);
    const toast = state.toasts[0]!;
    await act(() => {
      toast.actionProps.onClick();
      toast.actionProps.onClick();
    });
    expect(state.managedUpdate).toHaveBeenCalledExactlyOnceWith([
      {
        environmentId: fixture.environmentId,
        environmentLabel: "Research machine",
        instanceId: fixture.managed.instanceId,
        driver: fixture.managed.driver,
        availableVersion: fixture.latest,
      },
    ]);
    expect(fixture.storage.has(storageKey)).toBe(false);
  });

  it("preserves the primary CLI dismissal key across installed-version changes", async () => {
    using fixture = setup();
    fixture.storage.set(storageKey, JSON.stringify({ keys: [`codex:${fixture.latest}`] }));
    fixture.publish([{ ...fixture.provider, version: "0.9.0" }]);
    await using _screen = await render(<BrowserProviderUpdateNotification />);
    expect(state.toasts).toEqual([]);
    await act(() =>
      fixture.publish([
        {
          ...fixture.provider,
          versionAdvisory: {
            ...fixture.provider.versionAdvisory!,
            latestVersion: "2.0.0",
          },
        },
      ]),
    );
    expect(state.toasts).toHaveLength(1);
    expect(state.toasts[0]!.title).toContain("2.0.0");
  });

  it.each(["disconnected", "connected"])(
    "preserves a primary CLI dismissal with a saved %s remote without candidates",
    async (phase) => {
      using fixture = setup();
      state.environments.push({
        environmentId: EnvironmentId.make(`saved-${fixture.environmentId}`),
        label: "Saved remote",
        connection: { phase },
        serverConfig: phase === "connected" ? {} : null,
      });
      fixture.storage.set(storageKey, JSON.stringify({ keys: [`codex:${fixture.latest}`] }));
      fixture.publish([fixture.provider]);
      await using _screen = await render(<BrowserProviderUpdateNotification />);
      expect(state.toasts).toEqual([]);
    },
  );

  it.each(["cli", "managed"] as const)(
    "keeps a read-only %s update disabled and leaves Settings available",
    async (kind) => {
      using fixture = setup();
      state.permissions.set(fixture.environmentId, []);
      fixture.publish([kind === "cli" ? fixture.cliProvider : fixture.managed]);
      await using _screen = await render(<BrowserProviderUpdateNotification />);
      const toast = state.toasts[0]!;
      expect(toast.actionProps.children).toBe("Update");
      expect(toast.actionProps.disabled).toBe(true);
      await act(() => toast.actionProps.onClick());
      expect(state.cliUpdate).not.toHaveBeenCalled();
      expect(state.managedUpdate).not.toHaveBeenCalled();
      expect(state.closed).toEqual([]);
      await act(() => toast.data.secondaryActionProps!.onClick());
      expect(state.navigate).toHaveBeenCalledOnce();
      expect(fixture.storage.has(storageKey)).toBe(false);
    },
  );

  it.each(["cli", "managed"] as const)(
    "rechecks %s management permission before closing or dispatching",
    async (kind) => {
      using fixture = setup();
      const provider = kind === "cli" ? fixture.cliProvider : fixture.managed;
      fixture.publish([provider]);
      await using _screen = await render(<BrowserProviderUpdateNotification />);
      const toast = state.toasts[0]!;
      expect(toast.actionProps.disabled).not.toBe(true);
      state.permissions.set(fixture.environmentId, []);
      await act(() => toast.actionProps.onClick());
      expect(state.cliUpdate).not.toHaveBeenCalled();
      expect(state.managedUpdate).not.toHaveBeenCalled();
      expect(state.closed).toEqual([]);
      await act(() => fixture.publish([provider]));
      expect(toast.actionProps.disabled).toBe(true);
      expect(state.toasts).toHaveLength(1);
      state.permissions.set(fixture.environmentId, [AuthProvidersManageScope]);
      await act(() => fixture.publish([provider]));
      expect(toast.actionProps.disabled).toBe(false);
      await act(() => toast.actionProps.onClick());
      expect(kind === "cli" ? state.cliUpdate : state.managedUpdate).toHaveBeenCalledOnce();
      expect(fixture.storage.has(storageKey)).toBe(false);
    },
  );

  it.each(["cli", "managed"] as const)(
    "requires management permission on every %s update destination",
    async (kind) => {
      using fixture = setup();
      const other = EnvironmentId.make(`restricted-${fixture.environmentId}`);
      const provider = kind === "cli" ? fixture.cliProvider : fixture.managed;
      state.environments.push({
        environmentId: other,
        label: "Read-only machine",
        connection: { phase: "connected" },
        serverConfig: {},
      });
      state.providers.set(other, [provider]);
      fixture.publish([provider]);
      await using _screen = await render(<BrowserProviderUpdateNotification />);
      const toast = state.toasts[0]!;
      expect(toast.actionProps.disabled).toBe(true);
      await act(() => toast.actionProps.onClick());
      expect(state.cliUpdate).not.toHaveBeenCalled();
      expect(state.managedUpdate).not.toHaveBeenCalled();
      expect(state.closed).toEqual([]);
    },
  );

  it("records user dismissal but not replacement, and ignores an obsolete managed action", async () => {
    using fixture = setup();
    fixture.publish([fixture.managed]);
    await using _screen = await render(<BrowserProviderUpdateNotification />);
    const old = state.toasts[0]!;
    await act(() =>
      fixture.publish([
        {
          ...fixture.managed,
          connection: {
            ...fixture.managed.connection!,
            runtime: {
              ...fixture.managed.connection!.runtime!,
              availableManagedVersion: "3.0.0",
            },
          },
        },
      ]),
    );
    expect(state.toasts).toHaveLength(2);
    expect(fixture.storage.has(storageKey)).toBe(false);
    await act(() => old.actionProps.onClick());
    expect(state.managedUpdate).not.toHaveBeenCalled();
    await act(() => state.toasts[1]!.data.onClose());
    expect(JSON.parse(fixture.storage.get(storageKey)!)).toEqual({
      keys: [
        `managed-runtime:${JSON.stringify([
          [
            fixture.environmentId,
            fixture.managed.driver,
            fixture.managed.instanceId,
            "1.0.0",
            "3.0.0",
          ],
        ])}`,
      ],
    });
  });

  it("keeps both connected machines and ignores a machine still connecting", async () => {
    using fixture = setup();
    const other = EnvironmentId.make("secondary");
    state.environments.push({
      environmentId: other,
      label: "Lab machine",
      connection: { phase: "connecting" },
      serverConfig: null,
    });
    fixture.publish([fixture.provider]);
    state.providers.set(other, [fixture.provider]);
    await using _screen = await render(<BrowserProviderUpdateNotification />);
    expect(state.toasts).toHaveLength(1);
    expect(state.toasts[0]!.title).toContain("Research machine");
    state.environments[1] = {
      environmentId: other,
      label: "Lab machine",
      connection: { phase: "connected" },
      serverConfig: {},
    };
    await act(() => fixture.publish([fixture.provider]));
    expect(state.toasts).toHaveLength(2);
    expect(state.toasts[1]!.title).toBe("2 provider updates available");
    expect(fixture.storage.has(storageKey)).toBe(false);
  });
});
