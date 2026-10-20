import {
  ConnectorId,
  type ConnectorSummary,
  type ExtensionsInventory,
  ExtensionsError,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
} from "@t3tools/contracts";
import type * as AtomReact from "@effect/atom-react";
import * as Cause from "effect/Cause";
import { act, useSyncExternalStore } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";
import type * as SettingsLayout from "../../components/settings/settingsLayout";

const state = vi.hoisted(() => ({
  primaryEnvironmentId: "local" as string | null,
  /** The environment the settings scope picker selected; undefined means no scope. */
  scopeEnvironmentId: undefined as string | null | undefined,
  httpBaseUrls: {} as Record<string, string>,
  canWrite: true,
  providersByEnvironment: {} as Record<string, ServerProvider[]>,
  inventory: null as ExtensionsInventory | null,
  inventoryTargets: [] as unknown[],
  projects: [] as Array<{ environmentId: string; id: string; title: string; isScratch?: true }>,
  hash: "",
  navigate: vi.fn(),
  commands: {
    update: vi.fn(),
    setSelection: vi.fn(),
    remove: vi.fn(),
    test: vi.fn(),
    startSignIn: vi.fn(),
    install: vi.fn(),
    providerAct: vi.fn(),
    other: vi.fn(),
  },
  confirm: vi.fn(),
  openExternal: vi.fn(),
  /**
   * The app compiles components with memoization, so a child whose props are
   * unchanged only re-renders through a subscription. Mocked hooks that the
   * tests change subscribe here; `render()` notifies them.
   */
  version: 0,
  listeners: new Set<() => void>(),
}));

function useStateVersion() {
  return useSyncExternalStore(
    (listener) => {
      state.listeners.add(listener);
      return () => state.listeners.delete(listener);
    },
    () => state.version,
  );
}

vi.mock("@effect/atom-react", async (importOriginal) => ({
  ...(await importOriginal<typeof AtomReact>()),
  useAtomValue: (atom: unknown) =>
    typeof atom === "string" ? (state.providersByEnvironment[atom] ?? []) : null,
}));
vi.mock("../../state/server", () => ({
  providersIgnoringCheckedAtAtom: (environmentId: string) => environmentId,
}));
vi.mock("../../state/environments", () => ({
  usePrimaryEnvironmentId: () => state.primaryEnvironmentId,
  usePrimaryEnvironment: () => null,
  useEnvironmentHttpBaseUrl: (environmentId: string | null) =>
    environmentId === null ? null : (state.httpBaseUrls[environmentId] ?? null),
}));
vi.mock("../../components/settings/SettingsScopeContext", () => ({
  useOptionalSettingsScope: () =>
    state.scopeEnvironmentId === undefined
      ? null
      : {
          environment:
            state.scopeEnvironmentId === null ? null : { environmentId: state.scopeEnvironmentId },
        },
}));
vi.mock("../../components/settings/SettingsScopeSentence", () => ({
  SettingsScopeSentence: () => null,
}));
vi.mock("../../hooks/useSettings", () => ({
  PRIMARY_SETTINGS_UNAVAILABLE_MESSAGE: "",
  usePrimarySettingsAvailable: () => true,
}));
vi.mock("../../components/settings/scopedSettings", () => ({
  isProjectScopedSettingKey: () => false,
  listProjectOverrides: () => [],
  scopedSettingsAreMixed: () => false,
  scopedSettingsSource: () => null,
}));
vi.mock("../../components/settings/useScopedSettings", () => ({
  useClearProjectOverrides: () => () => undefined,
  useClearScopedSettings: () => () => undefined,
}));
vi.mock("../../components/settings/SettingInheritance", () => ({
  SettingInheritance: () => null,
}));
vi.mock("../../state/entities", () => ({ useProjects: () => state.projects }));
vi.mock("../../state/session", () => ({
  useEnvironmentScope: () => {
    useStateVersion();
    return state.canWrite;
  },
  useEnvironmentsWithScope: () => new Set(),
}));
vi.mock("../../state/query", () => ({
  useEnvironmentQuery: (atom: unknown) =>
    atom === "discover"
      ? { data: { entries: [], fetchedAt: "2026-10-21T00:00:00.000Z" }, error: null }
      : { data: state.inventory, error: null },
}));
vi.mock("../../state/queries", () => ({ useDebouncedValue: (value: unknown) => value }));
vi.mock("./extensionsState", () => ({
  extensionsInventory: (target: unknown) => {
    state.inventoryTargets.push(target);
    return "inventory";
  },
  extensionsDiscoverPage: () => "discover",
  updateConnector: "update",
  setConnectorProjectSelection: "setSelection",
  removeConnector: "remove",
  testConnector: "test",
  startConnectorSignIn: "startSignIn",
  addConnector: "other",
  installScientPlugin: "install",
  removeScientPlugin: "other",
  setScientPluginEnabled: "other",
  actOnProviderPlugin: "providerAct",
}));
vi.mock("../../state/use-atom-command", () => ({
  useAtomCommand: (command: keyof typeof state.commands) => state.commands[command],
}));
vi.mock("../../localApi", () => ({
  ensureLocalApi: () => ({
    dialogs: { confirm: state.confirm },
    shell: { openExternal: state.openExternal },
  }),
}));
vi.mock("../../components/ui/toast", () => ({ toastManager: { add: vi.fn() } }));
vi.mock("@tanstack/react-router", () => ({
  Link: ({ to, search: _search, children, ...props }: Record<string, unknown>) => (
    <a href={String(to)} {...props}>
      {children as React.ReactNode}
    </a>
  ),
  useNavigate: () => state.navigate,
  useLocation: ({ select }: { select: (location: unknown) => unknown }) => {
    useStateVersion();
    return select({ pathname: "/settings/extensions", hash: state.hash, state: {} });
  },
}));
vi.mock("../../components/chat/ProviderInstanceIcon", () => ({
  ProviderInstanceIcon: () => null,
}));
vi.mock("../../components/chat/providerIconUtils", () => ({
  AVAILABLE_PROVIDER_OPTIONS: [
    { value: "codex", label: "Codex" },
    { value: "claudeAgent", label: "Claude" },
  ],
}));
vi.mock("../../components/settings/settingsSearch", () => ({
  searchableSetting: (id: string) => ({ id, title: id }),
  SETTINGS_SECTION_LABELS: { "/settings/documents": "Documents" },
}));
// The real page container, search-target context and target focus; rows and
// sections are stubbed because they read environment-wide settings state.
vi.mock("../../components/settings/settingsLayout", async (importOriginal) => ({
  ...(await importOriginal<typeof SettingsLayout>()),
  SettingsSection: ({
    id,
    title,
    headerAction,
    children,
  }: {
    id?: string;
    title: string;
    headerAction?: React.ReactNode;
    children: React.ReactNode;
  }) => (
    <section data-section={id} aria-label={title}>
      {headerAction}
      {children}
    </section>
  ),
  SettingsRow: ({
    title,
    description,
    status,
    control,
    children,
    ...props
  }: {
    title: React.ReactNode;
    description?: React.ReactNode;
    status?: React.ReactNode;
    control?: React.ReactNode;
    children?: React.ReactNode;
  }) => (
    <div data-row="" {...props}>
      <h3>{title}</h3>
      {description ? <p data-description="">{description}</p> : null}
      {status ? <div data-status="">{status}</div> : null}
      {control}
      {children}
    </div>
  ),
}));
vi.mock("../../components/ui/switch", () => ({
  Switch: ({
    checked,
    disabled,
    onCheckedChange,
    ...props
  }: {
    checked: boolean;
    disabled?: boolean;
    onCheckedChange: (checked: boolean) => void;
  }) => (
    <button
      {...props}
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      onClick={() => onCheckedChange(!checked)}
    />
  ),
}));

import { ExtensionsSettings } from "./ExtensionsSettings";

const codex = ProviderInstanceId.make("codex");
const claude = ProviderInstanceId.make("claude");
const pi = ProviderInstanceId.make("pi");

function provider(
  instanceId: ProviderInstanceId,
  driver: string,
  extra: Partial<ServerProvider>,
): ServerProvider {
  return {
    instanceId,
    driver: ProviderDriverKind.make(driver),
    enabled: true,
    installed: true,
    version: "1.0.0",
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-10-21T00:00:00.000Z",
    models: [],
    slashCommands: [],
    skills: [],
    ...extra,
  };
}

function connector(id: string, patch: Partial<ConnectorSummary> = {}): ConnectorSummary {
  return {
    connectorId: ConnectorId.make(`con_${id}`),
    serverName: id,
    displayName: id,
    url: `https://${id}.example.com/mcp`,
    source: { type: "url" },
    auth: { type: "oauth", usesOwnClient: false },
    status: "connected",
    enabled: true,
    projectPolicy: "all-projects",
    createdAt: "2026-10-21T00:00:00.000Z",
    updatedAt: "2026-10-21T00:00:00.000Z",
    ...patch,
  };
}

function inventory(connectors: ConnectorSummary[]): ExtensionsInventory {
  return {
    revision: 1,
    connectors,
    projectSelections: [],
    providerSupport: [
      {
        providerInstanceId: codex,
        driver: ProviderDriverKind.make("codex"),
        displayName: "Codex",
        status: "supported",
      },
      {
        providerInstanceId: claude,
        driver: ProviderDriverKind.make("claudeAgent"),
        displayName: "Claude",
        status: "supported",
      },
      {
        providerInstanceId: pi,
        driver: ProviderDriverKind.make("pi"),
        displayName: "Pi",
        status: "unsupported",
        reason: "Pi cannot reach remote MCP servers.",
      },
    ],
    plugins: [],
    diagnostics: [],
  };
}

let root: Root;
let container: HTMLDivElement;

async function render() {
  await act(async () => {
    state.version += 1;
    for (const listener of state.listeners) listener();
    root.render(<ExtensionsSettings />);
  });
}

const connectorRow = (id: string) =>
  container.querySelector<HTMLElement>(`[data-connector-id="con_${id}"]`)!;
const buttonIn = (scope: ParentNode, label: string) =>
  [...scope.querySelectorAll("button")].find((item) => item.textContent === label) ?? null;
const providerGroups = () =>
  [...container.querySelectorAll<HTMLElement>("[data-provider-group]")].map(
    (group) => group.dataset.providerGroup,
  );

const localProviders = () => [
  provider(codex, "codex", {
    plugins: [
      {
        id: "linear@openai",
        name: "linear",
        source: "remote",
        enabled: true,
        canUninstall: true,
      },
    ],
    mcpServers: [{ name: "github", status: "needs-auth", canStartSignIn: true }],
  }),
  provider(claude, "claudeAgent", {
    plugins: [{ id: "superpowers", name: "superpowers", source: "local", enabled: true }],
  }),
];

const extensionsError = (message: string) => ({
  _tag: "Failure" as const,
  cause: Cause.fail(new ExtensionsError({ reason: "provider-rejected", message })),
});

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  state.primaryEnvironmentId = "local";
  state.scopeEnvironmentId = undefined;
  state.httpBaseUrls = { local: "http://127.0.0.1:3773/" };
  state.canWrite = true;
  state.projects = [];
  state.providersByEnvironment = { local: localProviders() };
  state.inventory = inventory([connector("linear0001")]);
  state.inventoryTargets = [];
  state.hash = "";
  state.navigate.mockReset();
  for (const command of Object.values(state.commands)) command.mockReset();
  state.confirm.mockReset();
  state.openExternal.mockReset();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

describe("ExtensionsSettings Works with filter", () => {
  it("narrows provider plugins to one instance and hides connectors an agent cannot reach", async () => {
    await render();
    const worksWith = container.querySelector<HTMLSelectElement>(
      'select[aria-label="Works with"]',
    )!;
    expect([...worksWith.options].map((option) => option.textContent)).toEqual([
      "Any agent",
      "Codex",
      "Claude",
      "Pi",
    ]);
    expect(providerGroups()).toEqual(["codex", "claude"]);
    expect(connectorRow("linear0001")).not.toBeNull();

    await userEvent.selectOptions(worksWith, "codex");
    expect(providerGroups()).toEqual(["codex"]);
    expect(connectorRow("linear0001")).not.toBeNull();

    await userEvent.selectOptions(worksWith, "pi");
    expect(providerGroups()).toEqual([]);
    expect(connectorRow("linear0001")).toBeNull();
    const connectors = container.querySelector('[data-section="extensions-connected-services"]')!;
    expect(connectors.textContent).toContain("Not available in Pi");
    expect(connectors.textContent).toContain("Pi cannot reach remote MCP servers.");

    await userEvent.selectOptions(worksWith, "");
    expect(providerGroups()).toEqual(["codex", "claude"]);
  });

  it("offers provider actions only where the provider reports them", async () => {
    await render();
    const codexGroup = container.querySelector('[data-provider-group="codex"]')!;
    expect(buttonIn(codexGroup, "Uninstall")).not.toBeNull();
    expect(buttonIn(codexGroup, "Sign in")).not.toBeNull();
    const claudeGroup = container.querySelector('[data-provider-group="claude"]')!;
    expect(claudeGroup.textContent).toContain("superpowers");
    expect(claudeGroup.querySelectorAll("button")).toHaveLength(0);
  });

  it("filters by kind", async () => {
    await render();
    await userEvent.click(
      [...container.querySelectorAll("button")].find(
        (item) => item.textContent === "Provider plugins",
      )!,
    );
    expect(container.querySelector('[data-section="extensions-connected-services"]')).toBeNull();
    expect(providerGroups()).toEqual(["codex", "claude"]);
  });
});

describe("ExtensionsSettings connector actions", () => {
  it("enables actions by connector status", async () => {
    state.inventory = inventory([
      connector("connected1"),
      connector("needsauth1", { status: "needs-auth" }),
      connector("missingkey", {
        status: "needs-credential",
        auth: { type: "credential", strategy: "bearer", storage: "owned" },
      }),
      connector("openserver", { auth: { type: "none" } }),
    ]);
    await render();

    const connected = connectorRow("connected1");
    expect(connected.querySelector("[data-connector-status]")?.textContent).toBe("Connected");
    expect(buttonIn(connected, "Reconnect")?.disabled).toBe(false);
    expect(buttonIn(connected, "Test")?.disabled).toBe(false);
    expect(buttonIn(connected, "Remove")?.disabled).toBe(false);

    const needsAuth = connectorRow("needsauth1");
    expect(needsAuth.querySelector("[data-connector-status]")?.textContent).toBe("Needs sign-in");
    expect(buttonIn(needsAuth, "Sign in")?.disabled).toBe(false);
    expect(buttonIn(needsAuth, "Test")?.disabled).toBe(true);

    const missing = connectorRow("missingkey");
    expect(missing.querySelector("[data-connector-status]")?.textContent).toBe("Needs credential");
    expect(buttonIn(missing, "Sign in")).toBeNull();
    expect(buttonIn(missing, "Reconnect")).toBeNull();
    expect(buttonIn(missing, "Test")?.disabled).toBe(true);
    expect(missing.textContent).toContain("Remove this service and add it again.");

    const open = connectorRow("openserver");
    expect(buttonIn(open, "Reconnect")).toBeNull();
    expect(buttonIn(open, "Test")?.disabled).toBe(false);
  });

  it("locks every control without settings permission and sign-in without a server origin", async () => {
    state.inventory = inventory([connector("needsauth1", { status: "needs-auth" })]);
    state.httpBaseUrls = {};
    await render();
    expect(buttonIn(connectorRow("needsauth1"), "Sign in")?.disabled).toBe(true);
    expect(buttonIn(connectorRow("needsauth1"), "Remove")?.disabled).toBe(false);

    state.canWrite = false;
    await render();
    const row = connectorRow("needsauth1");
    expect([...row.querySelectorAll("button")].every((item) => item.disabled)).toBe(true);
    expect(row.querySelector("select")?.disabled).toBe(true);
  });

  it("starts sign-in with this client's server origin and opens the returned page", async () => {
    state.inventory = inventory([connector("needsauth1", { status: "needs-auth" })]);
    const reserved = { opener: {}, location: { href: "" }, close: vi.fn() };
    const open = vi.fn(() => reserved);
    vi.stubGlobal("open", open);
    state.commands.startSignIn.mockResolvedValueOnce({
      _tag: "Success",
      value: {
        authorizationUrl: "https://auth.example.com/authorize?state=abc",
        expiresAt: "2026-10-21T00:10:00.000Z",
      },
    });
    await render();
    await userEvent.click(buttonIn(connectorRow("needsauth1"), "Sign in")!);

    expect(open).toHaveBeenCalledWith("", "_blank");
    expect(state.commands.startSignIn).toHaveBeenCalledExactlyOnceWith({
      environmentId: "local",
      input: {
        connectorId: ConnectorId.make("con_needsauth1"),
        callbackOrigin: "http://127.0.0.1:3773",
      },
    });
    expect(reserved.opener).toBeNull();
    expect(reserved.location.href).toBe("https://auth.example.com/authorize?state=abc");
    expect(reserved.close).not.toHaveBeenCalled();
    expect(connectorRow("needsauth1").textContent).toContain("Finish signing in in your browser.");
  });

  it("closes the reserved tab and says why when the server refuses sign-in", async () => {
    state.inventory = inventory([connector("needsauth1", { status: "needs-auth" })]);
    const reserved = { opener: {}, location: { href: "" }, close: vi.fn(), closed: false };
    vi.stubGlobal(
      "open",
      vi.fn(() => reserved),
    );
    state.commands.startSignIn.mockResolvedValueOnce(
      extensionsError("The service does not allow dynamic registration."),
    );
    await render();
    await userEvent.click(buttonIn(connectorRow("needsauth1"), "Sign in")!);
    expect(reserved.close).toHaveBeenCalledOnce();
    expect(reserved.location.href).toBe("");
    const row = connectorRow("needsauth1");
    expect(row.querySelector('[role="alert"]')?.textContent).toBe(
      "The service does not allow dynamic registration.",
    );
    expect(row.textContent).not.toContain("Finish signing in");
  });

  it.each([
    ["blocked", () => null],
    [
      "closed while the server answered",
      () => ({ opener: {}, location: { href: "" }, close: vi.fn(), closed: true }),
    ],
  ])("offers a sign-in link when the reserved window is %s", async (_case, reserve) => {
    state.inventory = inventory([connector("needsauth1", { status: "needs-auth" })]);
    vi.stubGlobal("open", vi.fn(reserve));
    state.commands.startSignIn.mockResolvedValueOnce({
      _tag: "Success",
      value: {
        authorizationUrl: "https://auth.example.com/authorize?state=xyz",
        expiresAt: "2026-10-21T00:10:00.000Z",
      },
    });
    await render();
    await userEvent.click(buttonIn(connectorRow("needsauth1"), "Sign in")!);

    const row = connectorRow("needsauth1");
    expect(row.querySelector('[role="alert"]')?.textContent).toContain(
      "The sign-in window was blocked.",
    );
    const link = [...row.querySelectorAll("a")].find(
      (item) => item.textContent === "Open sign-in page",
    );
    expect(link?.getAttribute("href")).toBe("https://auth.example.com/authorize?state=xyz");
    expect(link?.getAttribute("target")).toBe("_blank");
    expect(link?.getAttribute("rel")).toBe("noopener noreferrer");
    expect(row.textContent).not.toContain("Finish signing in");
  });

  it("shows the server's switch state while a change is in flight and the tools a test reports", async () => {
    const update = Promise.withResolvers<unknown>();
    state.commands.update.mockReturnValueOnce(update.promise);
    state.commands.test.mockResolvedValueOnce({
      _tag: "Success",
      value: {
        connectorId: ConnectorId.make("con_linear0001"),
        outcome: "ok",
        checkedAt: "2026-10-21T00:00:00.000Z",
        serverName: "Linear",
        tools: [
          { name: "list_issues", readOnly: true },
          { name: "delete_issue", destructive: true },
        ],
      },
    });
    await render();
    const row = connectorRow("linear0001");
    const toggle = row.querySelector<HTMLButtonElement>('[role="switch"]')!;
    await userEvent.click(toggle);
    expect(state.commands.update).toHaveBeenCalledExactlyOnceWith({
      environmentId: "local",
      input: { connectorId: ConnectorId.make("con_linear0001"), enabled: false },
    });
    expect(toggle.getAttribute("aria-checked")).toBe("true");
    expect(buttonIn(row, "Test")?.disabled).toBe(true);

    await act(async () => update.resolve({ _tag: "Success", value: state.inventory }));
    expect(buttonIn(row, "Test")?.disabled).toBe(false);
    await userEvent.click(buttonIn(row, "Test")!);
    const tools = row.querySelector('[aria-label="Tools of linear0001"]')!;
    expect(tools.textContent).toContain("list_issuesread-only");
    expect(tools.textContent).toContain("delete_issuechanges data");
  });

  it("removes only after confirmation", async () => {
    state.confirm.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    state.commands.remove.mockResolvedValue({ _tag: "Success", value: state.inventory });
    await render();
    await userEvent.click(buttonIn(connectorRow("linear0001"), "Remove")!);
    expect(state.commands.remove).not.toHaveBeenCalled();
    await userEvent.click(buttonIn(connectorRow("linear0001"), "Remove")!);
    expect(state.commands.remove).toHaveBeenCalledExactlyOnceWith({
      environmentId: "local",
      input: { connectorId: ConnectorId.make("con_linear0001") },
    });
  });

  it("lists per-project switches from the server's selections for selected projects", async () => {
    state.projects = [
      { environmentId: "local", id: "project-a", title: "Alpha" },
      { environmentId: "local", id: "project-b", title: "Beta" },
      { environmentId: "local", id: "scratch", title: "Scratch", isScratch: true },
      { environmentId: "remote", id: "project-c", title: "Remote" },
    ];
    state.inventory = {
      ...inventory([connector("linear0001", { projectPolicy: "selected-projects" })]),
      projectSelections: [
        {
          connectorId: ConnectorId.make("con_linear0001"),
          projectId: ProjectId.make("project-b"),
          enabled: true,
        },
      ],
    };
    state.commands.setSelection.mockResolvedValue({ _tag: "Success", value: state.inventory });
    await render();
    const list = connectorRow("linear0001").querySelector(
      '[aria-label="Projects for linear0001"]',
    )!;
    const switches = [...list.querySelectorAll<HTMLButtonElement>('[role="switch"]')];
    expect(switches.map((item) => item.getAttribute("aria-label"))).toEqual([
      "Turn on linear0001 in Alpha",
      "Turn off linear0001 in Beta",
    ]);
    await userEvent.click(switches[0]!);
    expect(state.commands.setSelection).toHaveBeenCalledExactlyOnceWith({
      environmentId: "local",
      input: {
        connectorId: ConnectorId.make("con_linear0001"),
        projectId: ProjectId.make("project-a"),
        enabled: true,
      },
    });
  });
});

describe("ExtensionsSettings environment target", () => {
  it.each([
    [
      "a desktop-over-SSH environment",
      "remote-ssh",
      "http://127.0.0.1:41234/",
      "http://127.0.0.1:41234",
    ],
    [
      "an HTTPS remote",
      "remote-ts",
      "https://lab.tailnet.ts.net/scient/",
      "https://lab.tailnet.ts.net",
    ],
  ])(
    "reads and changes %s chosen in the settings picker, not the primary",
    async (_case, remoteId, httpBaseUrl, callbackOrigin) => {
      state.scopeEnvironmentId = remoteId;
      state.httpBaseUrls = { local: "http://127.0.0.1:3773/", [remoteId]: httpBaseUrl };
      state.providersByEnvironment = {
        local: localProviders(),
        [remoteId]: [
          provider(codex, "codex", {
            plugins: [{ id: "remote-only", name: "remote-only", source: "remote", enabled: true }],
          }),
        ],
      };
      state.projects = [
        { environmentId: "local", id: "local-project", title: "Local project" },
        { environmentId: remoteId, id: "remote-project", title: "Remote project" },
      ];
      state.inventory = inventory([
        connector("needsauth1", { status: "needs-auth", projectPolicy: "selected-projects" }),
      ]);
      const reserved = { opener: {}, location: { href: "" }, close: vi.fn(), closed: false };
      vi.stubGlobal(
        "open",
        vi.fn(() => reserved),
      );
      state.commands.startSignIn.mockResolvedValueOnce({
        _tag: "Success",
        value: {
          authorizationUrl: "https://auth.example.com/authorize",
          expiresAt: "2026-10-21T00:10:00.000Z",
        },
      });
      state.commands.update.mockResolvedValueOnce({ _tag: "Success", value: state.inventory });
      await render();

      expect(state.inventoryTargets.at(-1)).toEqual({ environmentId: remoteId, input: {} });
      expect(container.textContent).toContain("remote-only");
      expect(container.textContent).not.toContain("superpowers");
      const row = connectorRow("needsauth1");
      expect(row.textContent).toContain("Remote project");
      expect(row.textContent).not.toContain("Local project");

      await userEvent.click(buttonIn(row, "Sign in")!);
      expect(state.commands.startSignIn).toHaveBeenCalledExactlyOnceWith({
        environmentId: remoteId,
        input: { connectorId: ConnectorId.make("con_needsauth1"), callbackOrigin },
      });
      await userEvent.click(row.querySelector<HTMLButtonElement>('[role="switch"]')!);
      expect(state.commands.update).toHaveBeenCalledExactlyOnceWith({
        environmentId: remoteId,
        input: { connectorId: ConnectorId.make("con_needsauth1"), enabled: false },
      });
    },
  );

  it("drops in-progress row state when the picker switches environments", async () => {
    state.scopeEnvironmentId = "remote-ssh";
    state.httpBaseUrls = { "remote-ssh": "http://127.0.0.1:41234/" };
    state.commands.update.mockResolvedValueOnce(extensionsError("Remote refused."));
    await render();
    await userEvent.click(
      connectorRow("linear0001").querySelector<HTMLButtonElement>('[role="switch"]')!,
    );
    expect(connectorRow("linear0001").textContent).toContain("Remote refused.");

    state.scopeEnvironmentId = "local";
    await render();
    expect(connectorRow("linear0001").textContent).not.toContain("Remote refused.");
    expect(state.inventoryTargets.at(-1)).toEqual({ environmentId: "local", input: {} });
  });

  it("asks for a connected environment when the picker has none", async () => {
    state.scopeEnvironmentId = null;
    await render();
    expect(container.textContent).toContain("No execution environment");
    expect(state.inventoryTargets).toEqual([]);
  });
});

describe("ExtensionsSettings failures", () => {
  it("shows a typed server failure on the connector row and a generic one for transport errors", async () => {
    state.commands.update
      .mockResolvedValueOnce(extensionsError("The connector is locked by a plugin."))
      .mockResolvedValueOnce({
        _tag: "Failure",
        cause: Cause.die(new Error("socket closed: ws://secret")),
      });
    await render();
    const toggle = () =>
      connectorRow("linear0001").querySelector<HTMLButtonElement>('[role="switch"]')!;
    await userEvent.click(toggle());
    expect(connectorRow("linear0001").querySelector('[role="alert"]')?.textContent).toBe(
      "The connector is locked by a plugin.",
    );
    await userEvent.click(toggle());
    expect(connectorRow("linear0001").querySelector('[role="alert"]')?.textContent).toBe(
      "Scient could not complete this request. Try again.",
    );
  });

  it("keeps a rejected bundle path and explains the rejection", async () => {
    state.commands.install.mockResolvedValueOnce(
      extensionsError("No scient.plugin.json in /tmp/bundle."),
    );
    await render();
    const path = container.querySelector<HTMLInputElement>(
      'input[aria-label="Bundle folder path"]',
    )!;
    await userEvent.type(path, "/tmp/bundle");
    await userEvent.click(buttonIn(container, "Install")!);
    expect(state.commands.install).toHaveBeenCalledExactlyOnceWith({
      environmentId: "local",
      input: { path: "/tmp/bundle" },
    });
    expect(path.value).toBe("/tmp/bundle");
    const section = container.querySelector('[data-section="extensions-scient-plugins"]')!;
    expect(section.querySelector('[role="alert"]')?.textContent).toBe(
      "No scient.plugin.json in /tmp/bundle.",
    );
  });

  it("shows a provider's refusal on the plugin it came from", async () => {
    state.confirm.mockResolvedValueOnce(true);
    state.commands.providerAct.mockResolvedValueOnce(
      extensionsError("Codex refused to uninstall linear."),
    );
    await render();
    const codexGroup = container.querySelector('[data-provider-group="codex"]')!;
    await userEvent.click(buttonIn(codexGroup, "Uninstall")!);
    expect(codexGroup.querySelectorAll('[role="alert"]')).toHaveLength(1);
    expect(codexGroup.querySelector('[role="alert"]')?.textContent).toBe(
      "Codex refused to uninstall linear.",
    );
  });
});

describe("ExtensionsSettings search targets", () => {
  it("opens and focuses Discover for its search result, then follows a later result", async () => {
    state.hash = "#extensions-discover";
    await render();
    const discover = document.getElementById("extensions-discover");
    expect(discover).not.toBeNull();
    expect(document.activeElement).toBe(discover);
    expect(state.navigate).toHaveBeenCalledWith(expect.objectContaining({ hash: "" }));
    expect(connectorRow("linear0001")).toBeNull();

    state.hash = "#extensions-connected-services";
    await render();
    expect(document.getElementById("extensions-discover")).toBeNull();
    expect(connectorRow("linear0001")).not.toBeNull();
  });
});
