import {
  ConnectorId,
  type ConnectorSummary,
  type ConnectorTestResult,
  type DiscoverCatalog,
  type DiscoverEntry,
  type DiscoverPage as DiscoverPageResult,
  ExtensionsError,
  type ExtensionsInventory,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ScientPluginSummary,
  type ServerProvider,
} from "@t3tools/contracts";
import type * as AtomReact from "@effect/atom-react";
import type * as TanStackRouter from "@tanstack/react-router";
import { RegistryContext } from "@effect/atom-react";
import * as Cause from "effect/Cause";
import { AtomRegistry } from "effect/reactivity";
import { cloneElement, type ReactElement, useSyncExternalStore } from "react";
import { describe, expect, it, vi } from "vite-plus/test";
import {
  act,
  fakeTimers,
  render as renderScreen,
  stubGlobal,
  type Screen,
} from "../../../test/render";
import { page, userEvent } from "vite-plus/test/browser";

const state = vi.hoisted(() => ({
  primaryEnvironmentId: "local" as string | null,
  /** The environment the settings scope picker selected; undefined means no scope. */
  scopeEnvironmentId: undefined as string | null | undefined,
  httpBaseUrls: {} as Record<string, string>,
  canWrite: true,
  providersByEnvironment: {} as Record<string, ServerProvider[]>,
  inventory: null as ExtensionsInventory | null,
  catalog: null as DiscoverCatalog | null,
  discoverPages: {} as Record<string, DiscoverPageResult>,
  /** A discover query still waiting, or failed with this message; keyed like `discoverPages`. */
  discoverOutcomes: {} as Record<string, "pending" | { readonly error: string }>,
  /** `extensions.discover.entry` answers by name; catalog entries answer too. */
  entries: {} as Record<string, DiscoverEntry>,
  queryTargets: [] as unknown[],
  projects: [] as Array<{ environmentId: string; id: string; title: string; isScratch?: true }>,
  projectsKnown: true,
  registry: null as AtomRegistry.AtomRegistry | null,
  hash: "",
  navigate: vi.fn(),
  commands: {
    add: vi.fn(),
    update: vi.fn(),
    remove: vi.fn(),
    test: vi.fn(),
    startSignIn: vi.fn(),
    install: vi.fn(),
    pluginRemove: vi.fn(),
    pluginEnabled: vi.fn(),
    providerAct: vi.fn(),
  },
  confirm: vi.fn(),
  openExternal: vi.fn(),
  toast: vi.fn(),
  /**
   * The app compiles components with memoization, so a child whose props are
   * unchanged only re-renders through a subscription. Mocked hooks subscribe
   * here; `render()` notifies them.
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

vi.mock("@effect/atom-react", async (importOriginal) => {
  const actual = await importOriginal<typeof AtomReact>();
  const { some, none } = await import("effect/Option");
  return {
    ...actual,
    useAtomValue: (atom: unknown) => {
      useStateVersion();
      if (typeof atom === "string") return state.providersByEnvironment[atom] ?? [];
      if (typeof atom === "object" && atom !== null && "shellOf" in atom) {
        return { status: "live", snapshot: state.projectsKnown ? some({}) : none() };
      }
      return actual.useAtomValue(atom as Parameters<typeof actual.useAtomValue>[0]);
    },
  };
});
vi.mock("../../state/shell", () => ({
  environmentShell: { stateValueAtom: (environmentId: string) => ({ shellOf: environmentId }) },
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
  useOptionalSettingsScope: () => {
    useStateVersion();
    return state.scopeEnvironmentId === undefined
      ? null
      : {
          environment:
            state.scopeEnvironmentId === null ? null : { environmentId: state.scopeEnvironmentId },
        };
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
vi.mock("../../state/query", async () => {
  const { ExtensionsError: NotFound } = await import("@t3tools/contracts");
  return {
    useEnvironmentQuery: (
      atom: { kind: string; environmentId: string; input?: Record<string, unknown> } | null,
    ) => {
      useStateVersion();
      if (atom === null) return { data: null, error: null, failure: null, isPending: false };
      state.queryTargets.push(atom);
      if (atom.kind === "inventory") return { data: state.inventory, error: null };
      if (atom.kind === "catalog") return { data: state.catalog, error: null };
      if (atom.kind === "entry") {
        const name = String(atom.input?.name);
        const found =
          state.entries[name] ??
          state.catalog?.sections
            .flatMap((section) => section.entries)
            .find((candidate) => candidate.name === name);
        return found
          ? { data: found, error: null, failure: null, isPending: false }
          : {
              data: null,
              error: `No server named ${name}.`,
              failure: new NotFound({ reason: "not-found", message: `No server named ${name}.` }),
              isPending: false,
            };
      }
      const key = JSON.stringify(atom.input ?? {});
      const outcome = state.discoverOutcomes[key];
      if (outcome === "pending") return { data: null, error: null, isPending: true };
      if (outcome) return { data: null, error: outcome.error, isPending: false };
      return {
        data: state.discoverPages[key] ?? { entries: [], fetchedAt: "2026-10-21T00:00:00.000Z" },
        error: null,
        isPending: false,
      };
    },
  };
});
vi.mock("../../state/queries", () => ({ useDebouncedValue: (value: unknown) => value }));
vi.mock("./extensionsState", async () => {
  const { Atom } = await import("effect/reactivity");
  const idle = { busy: null, error: null, blockedSignInUrl: null, signInStartedAt: null };
  return {
    extensionsInventory: ({ environmentId }: { environmentId: string }) => ({
      kind: "inventory",
      environmentId,
    }),
    extensionsDiscoverCatalog: ({ environmentId }: { environmentId: string }) => ({
      kind: "catalog",
      environmentId,
    }),
    extensionsDiscoverEntry: ({
      environmentId,
      input,
    }: {
      environmentId: string;
      input: Record<string, unknown>;
    }) => ({ kind: "entry", environmentId, input }),
    extensionsDiscoverPage: ({
      environmentId,
      input,
    }: {
      environmentId: string;
      input: Record<string, unknown>;
    }) => ({ kind: "discover", environmentId, input }),
    // Real atoms: each test renders into its own registry, so nothing leaks between tests.
    extensionItemOperation: Atom.family((_key: string) => Atom.make(idle).pipe(Atom.keepAlive)),
    extensionItemOperationKey: (environmentId: string, item: string) =>
      JSON.stringify([environmentId, item]),
    addConnector: "add",
    updateConnector: "update",
    removeConnector: "remove",
    testConnector: "test",
    startConnectorSignIn: "startSignIn",
    installScientPlugin: "install",
    removeScientPlugin: "pluginRemove",
    setScientPluginEnabled: "pluginEnabled",
    actOnProviderPlugin: "providerAct",
  };
});
vi.mock("../../state/use-atom-command", () => ({
  useAtomCommand: (command: keyof typeof state.commands) => state.commands[command],
}));
vi.mock("../../localApi", () => ({
  ensureLocalApi: () => ({
    dialogs: { confirm: state.confirm },
    shell: { openExternal: state.openExternal },
  }),
}));
vi.mock("../../components/ui/toast", () => ({ toastManager: { add: state.toast } }));
/** `to` with its params filled in, as the router would build the address. */
function hrefOf(to: string, params: Record<string, string> = {}) {
  return to
    .replace(/\$([A-Za-z]+)/g, (_match, key: string) => encodeURIComponent(params[key] ?? ""))
    .replace(/\/\$$/, `/${params._splat ?? ""}`);
}
vi.mock("@tanstack/react-router", async (importOriginal) => ({
  ...(await importOriginal<typeof TanStackRouter>()),
  Link: ({
    to,
    params,
    search: _search,
    children,
    ...props
  }: {
    to: string;
    params?: Record<string, string>;
    search?: unknown;
    children?: React.ReactNode;
  }) => (
    <a href={hrefOf(to, params)} {...props}>
      {children}
    </a>
  ),
  Navigate: ({ to, hash }: { to: string; hash?: string }) => (
    <span data-navigate={to} data-hash={hash} />
  ),
  useNavigate: () => state.navigate,
  useLocation: ({ select }: { select: (location: unknown) => unknown }) => {
    useStateVersion();
    return select({ pathname: "/settings/extensions", hash: state.hash, state: {} });
  },
}));
vi.mock("../../components/chat/providerIconUtils", () => ({
  AVAILABLE_PROVIDER_OPTIONS: [
    { value: "codex", label: "Codex" },
    { value: "claudeAgent", label: "Claude" },
  ],
}));
// Provider logos pull in every provider package; a marker keeps what the page passes visible.
vi.mock("../../components/chat/ProviderInstanceIcon", () => ({
  ProviderInstanceIcon: ({
    displayName,
    statusDotClassName,
  }: {
    displayName: string;
    statusDotClassName?: string;
  }) => (
    <span data-provider-icon={displayName}>
      {statusDotClassName ? <span data-status-dot={statusDotClassName} /> : null}
    </span>
  ),
}));
vi.mock("../../components/settings/settingsSearch", () => ({
  searchableSetting: (id: string) => ({ id, title: id }),
}));
// Menus render inline so their items are plain buttons in the row.
vi.mock("../../components/ui/menu", () => ({
  // Other modules in the page's import graph name these; they render nothing here.
  ...Object.fromEntries(
    [
      "MenuGroup",
      "MenuGroupLabel",
      "MenuItemLabel",
      "MenuCheckboxItem",
      "MenuRadioGroup",
      "MenuRadioItem",
      "MenuRadioItemIndicator",
      "MenuShortcut",
      "MenuSub",
      "MenuSubTrigger",
      "MenuSubPopup",
      "DropdownMenu",
      "DropdownMenuTrigger",
      "DropdownMenuContent",
      "DropdownMenuGroup",
      "DropdownMenuItem",
      "DropdownMenuCheckboxItem",
      "DropdownMenuRadioGroup",
      "DropdownMenuRadioItem",
      "DropdownMenuLabel",
      "DropdownMenuSeparator",
      "DropdownMenuShortcut",
      "DropdownMenuSub",
      "DropdownMenuSubTrigger",
      "DropdownMenuSubContent",
    ].map((name) => [name, () => null]),
  ),
  Menu: ({ children }: { children: React.ReactNode }) => <div data-menu="">{children}</div>,
  MenuTrigger: ({ render, children }: { render: ReactElement; children: React.ReactNode }) =>
    cloneElement(render, {}, children),
  MenuPopup: ({ children }: { children: React.ReactNode }) => <div role="menu">{children}</div>,
  MenuItem: ({
    children,
    disabled,
    onClick,
  }: {
    children: React.ReactNode;
    disabled?: boolean;
    onClick?: () => void;
  }) => (
    <button type="button" role="menuitem" disabled={disabled} onClick={onClick}>
      {children}
    </button>
  ),
  MenuSeparator: () => <hr />,
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

import { AllServersPage, CategoryPage, DiscoverPage } from "./DiscoverPages";
import {
  ConnectorDetailPage,
  PluginDetailPage,
  ProviderPluginDetailPage,
  ServerDetailPage,
} from "./ExtensionDetailPages";
import { InstalledPage } from "./InstalledPage";

const codex = ProviderInstanceId.make("codex");
const claude = ProviderInstanceId.make("claude");
const pi = ProviderInstanceId.make("pi");
const LINEAR = ConnectorId.make("con_linear0001");

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
    authRevision: 0,
    enabled: true,
    availability: { type: "all-projects" },
    createdAt: "2026-10-21T00:00:00.000Z",
    updatedAt: "2026-10-21T00:00:00.000Z",
    ...patch,
  };
}

function entry(name: string, patch: Partial<DiscoverEntry> = {}): DiscoverEntry {
  return {
    name,
    version: "1.0.0",
    remotes: [
      { type: "streamable-http", url: `https://${name}.example.com/mcp`, requiresInput: false },
    ],
    installable: true,
    categories: ["featured"],
    ...patch,
  };
}

function plugin(id: string, patch: Partial<ScientPluginSummary> = {}): ScientPluginSummary {
  return {
    pluginId: id,
    version: "1.0.0",
    displayName: id,
    description: `${id} description`,
    publisher: "Scient",
    origin: "built-in",
    components: [],
    enabled: true,
    canSetEnabled: false,
    canRemove: false,
    connectorIds: [],
    ...patch,
  };
}

function inventory(patch: Partial<ExtensionsInventory> = {}): ExtensionsInventory {
  return {
    revision: 1,
    connectors: [connector("linear0001", { displayName: "Linear" })],
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
    plugins: [plugin("sources", { displayName: "Sources", description: "Find papers and notes" })],
    diagnostics: [],
    ...patch,
  };
}

const catalog: DiscoverCatalog = {
  fetchedAt: "2026-10-21T00:00:00.000Z",
  sections: [
    {
      category: "featured",
      title: "Popular",
      total: 3,
      entries: [
        entry("app.linear/linear", {
          title: "Linear",
          tagline: "Issues and projects",
          iconUrl: "data:image/png;base64,iVBORw0KGgo=",
          installedConnectorId: LINEAR,
        }),
        entry("io.notion/notion", { title: "Notion", tagline: "Notes and docs" }),
        entry("io.github.acme/local", {
          title: "Local tool",
          tagline: "Runs on your computer",
          remotes: [],
          installable: false,
          unsupportedReason: "Runs locally, not supported.",
        }),
      ],
    },
  ],
};

const buttonIn = (scope: ParentNode, label: string) =>
  [...scope.querySelectorAll("button")].find(
    (item) => item.textContent === label || item.getAttribute("aria-label") === label,
  ) ?? null;
const linkIn = (scope: ParentNode, text: string) =>
  [...scope.querySelectorAll("a")].find((item) => item.textContent === text) ?? null;

const extensionsError = (message: string) => ({
  _tag: "Failure" as const,
  cause: Cause.fail(new ExtensionsError({ reason: "provider-rejected", message })),
});

function setup() {
  state.primaryEnvironmentId = "local";
  state.scopeEnvironmentId = undefined;
  state.httpBaseUrls = { local: "http://127.0.0.1:3773/" };
  state.canWrite = true;
  state.projects = [];
  state.providersByEnvironment = {
    local: [
      provider(codex, "codex", {
        plugins: Array.from({ length: 7 }, (_, index) => ({
          id: `plugin-${index + 1}`,
          name: `Codex plugin ${index + 1}`,
          source: "remote" as const,
          enabled: true,
          canUninstall: index === 0,
        })),
        mcpServers: [{ name: "github", status: "needs-auth", canStartSignIn: true }],
      }),
      provider(claude, "claudeAgent", {
        plugins: [{ id: "superpowers", name: "superpowers", source: "local", enabled: true }],
      }),
    ],
  };
  state.inventory = inventory();
  state.catalog = catalog;
  state.discoverPages = {};
  state.discoverOutcomes = {};
  state.entries = {};
  state.projectsKnown = true;
  state.registry = AtomRegistry.make();
  state.queryTargets = [];
  state.hash = "";
  state.navigate.mockReset();
  for (const command of Object.values(state.commands)) command.mockReset();
  state.confirm.mockReset();
  state.openExternal.mockReset();
  state.toast.mockReset();
  const stack = new AsyncDisposableStack();
  const registry = state.registry;
  stack.defer(() => registry.dispose());
  const host = document.createElement("div");
  let screen: Screen | undefined;
  return {
    container: host,
    async render(element: ReactElement) {
      await act(async () => {
        state.version += 1;
        for (const listener of state.listeners) listener();
        const ui = <RegistryContext value={registry}>{element}</RegistryContext>;
        if (screen) await screen.rerender(ui);
        // Routing is mocked to inspect hrefs and navigation commands without changing pages.
        else screen = stack.use(await renderScreen(ui, { container: host, router: false }));
      });
    },
    async reset() {
      await screen?.[Symbol.asyncDispose]();
      screen = undefined;
    },
    rowNames(scope: ParentNode = host) {
      return [...scope.querySelectorAll<HTMLElement>("[data-extension-row]")].map(
        (item) => item.dataset.extensionRow,
      );
    },
    row(name: string) {
      return host.querySelector<HTMLElement>(`[data-extension-row="${name}"]`)!;
    },
    section(label: string) {
      return host.querySelector<HTMLElement>(`[aria-label="${label}"]`)!;
    },
    header: () => host.querySelector("header")!,
    headerButtons: () =>
      [...host.querySelector("header")!.querySelectorAll("button")].map(
        (item) => item.getAttribute("aria-label") ?? item.textContent,
      ),
    aboutTerms: () =>
      [...host.querySelector('[aria-label="About"]')!.querySelectorAll("dt")].map(
        (item) => item.textContent,
      ),
    aboutValue: (label: string) =>
      [...host.querySelector('[aria-label="About"]')!.querySelectorAll("dt")].find(
        (item) => item.textContent === label,
      )?.nextElementSibling?.textContent,
    [Symbol.asyncDispose]: () => stack.disposeAsync(),
  };
}

describe("Discover", () => {
  it("shows each catalog section with a link to its category, built-ins and Browse all", async () => {
    await using fixture = setup();
    await fixture.render(<DiscoverPage />);
    const popular = fixture.section("Popular");
    expect(linkIn(fixture.container, "Popular")?.getAttribute("href")).toBe(
      "/settings/extensions/category/featured",
    );
    expect(fixture.rowNames(popular)).toEqual(["Linear", "Notion", "Local tool"]);
    expect(fixture.rowNames(fixture.section("Built into Scient"))).toEqual(["Sources"]);
    expect(linkIn(fixture.container, "Browse all MCP servers")?.getAttribute("href")).toBe(
      "/settings/extensions/all",
    );
    expect(linkIn(fixture.row("Notion"), "Notion")?.getAttribute("href")).toBe(
      "/settings/extensions/item/server/io.notion/notion",
    );
    expect(linkIn(fixture.row("Linear"), "Linear")?.getAttribute("href")).toBe(
      "/settings/extensions/item/connector/con_linear0001",
    );
    expect(fixture.row("Notion").textContent).toContain("Notes and docs");
  });

  it("offers + for servers not added and ⋯ for added ones", async () => {
    await using fixture = setup();
    await fixture.render(<DiscoverPage />);
    expect(buttonIn(fixture.row("Linear"), "More for Linear")).not.toBeNull();
    expect(buttonIn(fixture.row("Linear"), "Add Linear")).toBeNull();
    expect(buttonIn(fixture.row("Notion"), "Add Notion")).not.toBeNull();
    expect(buttonIn(fixture.row("Notion"), "More for Notion")).toBeNull();

    await userEvent.click(buttonIn(fixture.row("Local tool"), "Why Local tool can't be added")!);
    expect(state.commands.add).not.toHaveBeenCalled();
    expect(state.navigate).toHaveBeenCalledWith({
      to: "/settings/extensions/item/server/$",
      params: { _splat: "io.github.acme/local" },
    });
  });

  it("adds with + and opens sign-in when the server asks for it", async () => {
    await using fixture = setup();
    const reserved = { opener: {}, location: { href: "" }, close: vi.fn(), closed: false };
    using _window = stubGlobal(
      "open",
      vi.fn(() => reserved),
    );
    state.commands.add.mockResolvedValueOnce({
      _tag: "Success",
      value: {
        connector: connector("notion0001", { displayName: "Notion", status: "needs-auth" }),
        nextStep: "sign-in-required",
      },
    });
    state.commands.startSignIn.mockResolvedValueOnce({
      _tag: "Success",
      value: {
        authorizationUrl: "https://auth.notion.so/authorize",
        expiresAt: "2026-10-21T00:10:00.000Z",
      },
    });
    await fixture.render(<DiscoverPage />);
    await userEvent.click(buttonIn(fixture.row("Notion"), "Add Notion")!);
    expect(state.commands.add).toHaveBeenCalledExactlyOnceWith({
      environmentId: "local",
      input: {
        target: {
          type: "registry",
          name: "io.notion/notion",
          version: "1.0.0",
          url: "https://io.notion/notion.example.com/mcp",
        },
        displayName: "Notion",
      },
    });
    expect(state.commands.startSignIn).toHaveBeenCalledExactlyOnceWith({
      environmentId: "local",
      input: {
        connectorId: ConnectorId.make("con_notion0001"),
        callbackOrigin: "http://127.0.0.1:3773",
      },
    });
    expect(reserved.location.href).toBe("https://auth.notion.so/authorize");
  });

  it("keeps a deferred sign-in's fallback link once the added connector replaces the row", async () => {
    await using fixture = setup();
    // The browser refuses the sign-in window.
    using _window = stubGlobal(
      "open",
      vi.fn(() => null),
    );
    const notion = connector("notion0001", { displayName: "Notion", status: "needs-auth" });
    state.commands.add.mockResolvedValueOnce({
      _tag: "Success",
      value: { connector: notion, nextStep: "sign-in-required" },
    });
    const signIn = Promise.withResolvers<unknown>();
    state.commands.startSignIn.mockReturnValueOnce(signIn.promise);
    await fixture.render(<DiscoverPage />);
    await userEvent.click(buttonIn(fixture.row("Notion"), "Add Notion")!);
    await act(async () => undefined);
    expect(state.commands.startSignIn).toHaveBeenCalledOnce();

    // The server publishes the new connector while its sign-in is still opening.
    state.inventory = inventory({
      connectors: [connector("linear0001", { displayName: "Linear" }), notion],
    });
    const [popular] = catalog.sections;
    state.catalog = {
      ...catalog,
      sections: [
        {
          ...popular!,
          entries: popular!.entries.map((item) =>
            item.name === "io.notion/notion"
              ? { ...item, installedConnectorId: notion.connectorId }
              : item,
          ),
        },
      ],
    };
    await fixture.render(<DiscoverPage />);
    expect(buttonIn(fixture.row("Notion"), "More for Notion")).not.toBeNull();
    expect(fixture.row("Notion").querySelector("[data-extension-status]")?.textContent).toBe(
      "Opening sign-in…",
    );

    await act(async () =>
      signIn.resolve({
        _tag: "Success",
        value: {
          authorizationUrl: "https://auth.notion.so/authorize",
          expiresAt: "2026-10-21T00:10:00.000Z",
        },
      }),
    );
    expect(linkIn(fixture.row("Notion"), "Open sign-in page")?.getAttribute("href")).toBe(
      "https://auth.notion.so/authorize",
    );
    expect(fixture.row("Notion").querySelector("[data-extension-status]")?.textContent).toBe(
      "Needs sign-in",
    );

    await fixture.render(<ConnectorDetailPage connectorId="con_notion0001" />);
    expect(linkIn(fixture.section("Connection"), "Open sign-in page")?.getAttribute("href")).toBe(
      "https://auth.notion.so/authorize",
    );
  });

  it("draws a letter tile for an icon that is not an allowed inline image", async () => {
    await using fixture = setup();
    const [popular] = catalog.sections;
    state.catalog = {
      ...catalog,
      sections: [
        {
          ...popular!,
          entries: [
            entry("io.example/odd", {
              title: "Odd",
              iconUrl: "data:constructor;base64,bm90IGFuIGltYWdl",
            }),
            entry("io.example/fine", {
              title: "Fine",
              iconUrl: "data:image/png;base64,iVBORw0KGgo=",
            }),
          ],
        },
      ],
    };
    await fixture.render(<DiscoverPage />);
    expect(fixture.row("Odd").querySelector("img")).toBeNull();
    expect(fixture.row("Odd").querySelector("[data-extension-icon]")).toBeNull();
    expect(fixture.row("Fine").querySelector('[data-extension-icon="image"] img')).not.toBeNull();
  });

  it("shows a failed add on its row", async () => {
    await using fixture = setup();
    state.commands.add.mockResolvedValueOnce(extensionsError("The server did not answer."));
    await fixture.render(<DiscoverPage />);
    await userEvent.click(buttonIn(fixture.row("Notion"), "Add Notion")!);
    expect(fixture.row("Notion").querySelector('[role="alert"]')?.textContent).toBe(
      "The server did not answer.",
    );
  });

  it("mixes installed, built-in, curated and registry matches in one grid, each once", async () => {
    await using fixture = setup();
    state.inventory = inventory({
      connectors: [
        connector("linear0001", { displayName: "Linear" }),
        connector("teamnotes1", { displayName: "Team notes" }),
      ],
    });
    const curatedKey = JSON.stringify({ scope: "curated", query: "note" });
    const notion = entry("io.notion/notion", { title: "Notion" });
    const notes = entry("io.github.x/notes", { title: "Notes server", categories: [] });
    state.discoverPages = {
      [curatedKey]: { fetchedAt: "2026-10-21T00:00:00.000Z", entries: [notion] },
      // The registry lists catalog servers too, in catalog shape.
      [JSON.stringify({ scope: "registry", query: "note" })]: {
        fetchedAt: "2026-10-21T00:00:00.000Z",
        entries: [notion, notes],
        nextCursor: "page-2",
      },
      [JSON.stringify({ scope: "registry", query: "note", cursor: "page-2" })]: {
        fetchedAt: "2026-10-21T00:00:00.000Z",
        entries: [
          notion,
          notes,
          entry("io.github.y/notebook", { title: "Notebook", categories: [] }),
        ],
      },
    };
    // Until the catalog answers, the registry's rows wait: any could repeat it.
    state.discoverOutcomes = { [curatedKey]: "pending" };
    await fixture.render(<DiscoverPage />);
    await userEvent.type(
      fixture.container.querySelector<HTMLInputElement>('input[aria-label="Search extensions"]')!,
      "note",
    );
    expect(fixture.section("Popular")).toBeNull();
    expect(fixture.rowNames(fixture.section("Search results"))).toEqual(["Team notes", "Sources"]);

    state.discoverOutcomes = {};
    await fixture.render(<DiscoverPage />);
    expect(fixture.rowNames(fixture.section("Search results"))).toEqual([
      "Team notes",
      "Sources",
      "Notion",
      "Notes server",
    ]);
    expect(buttonIn(fixture.row("Team notes"), "More for Team notes")).not.toBeNull();
    expect(buttonIn(fixture.row("Notes server"), "Add Notes server")).not.toBeNull();

    // A later registry page skips what earlier rows already listed.
    await userEvent.click(buttonIn(fixture.section("Search results"), "Load more")!);
    expect(fixture.rowNames(fixture.section("Search results"))).toEqual([
      "Team notes",
      "Sources",
      "Notion",
      "Notes server",
      "Notebook",
    ]);
  });

  it("shows catalog matches at once while the registry is slow, then on failure", async () => {
    await using fixture = setup();
    const curatedKey = JSON.stringify({ scope: "curated", query: "granola" });
    const registryKey = JSON.stringify({ scope: "registry", query: "granola" });
    state.discoverPages = {
      [curatedKey]: {
        fetchedAt: "2026-10-21T00:00:00.000Z",
        entries: [entry("scient.curated/granola", { title: "Granola", categories: ["writing"] })],
      },
    };
    state.discoverOutcomes = { [registryKey]: "pending" };
    await fixture.render(<DiscoverPage />);
    await userEvent.type(
      fixture.container.querySelector<HTMLInputElement>('input[aria-label="Search extensions"]')!,
      "granola",
    );
    const results = () => fixture.section("Search results");
    expect(fixture.rowNames(results())).toEqual(["Granola"]);
    expect(results().querySelector('[data-discover-pending="registry"]')?.textContent).toBe(
      "Searching the MCP Registry…",
    );

    // The registry fails: the catalog row stays and one line says why.
    state.discoverOutcomes = { [registryKey]: { error: "The MCP Registry did not answer." } };
    await fixture.render(<DiscoverPage />);
    expect(fixture.rowNames(results())).toEqual(["Granola"]);
    expect(results().querySelector("[data-discover-pending]")).toBeNull();
    expect(results().querySelector('[data-discover-error="registry"]')?.textContent).toBe(
      "The MCP Registry did not answer.",
    );

    // When the registry answers, its rows follow the catalog's.
    state.discoverOutcomes = {};
    state.discoverPages = {
      ...state.discoverPages,
      [registryKey]: {
        fetchedAt: "2026-10-21T00:00:00.000Z",
        entries: [entry("io.example/granola-notes", { title: "Granola notes", categories: [] })],
      },
    };
    await fixture.render(<DiscoverPage />);
    expect(fixture.rowNames(results())).toEqual(["Granola", "Granola notes"]);
    expect(results().querySelector("[data-discover-error]")).toBeNull();
  });

  it("queries the registry for All MCP servers and the catalog for categories", async () => {
    await using fixture = setup();
    await fixture.render(<AllServersPage />);
    expect(state.queryTargets).toContainEqual({
      kind: "discover",
      environmentId: "local",
      input: { scope: "registry" },
    });
    await fixture.render(<CategoryPage category="research" />);
    expect(state.queryTargets).toContainEqual({
      kind: "discover",
      environmentId: "local",
      input: { scope: "curated", category: "research" },
    });
  });

  it("lists every registry result on All MCP servers, catalog servers included", async () => {
    await using fixture = setup();
    const granola = entry("scient.curated/granola", {
      title: "Granola",
      tagline: "Meeting notes",
      categories: ["writing"],
    });
    state.discoverPages = {
      [JSON.stringify({ scope: "registry" })]: {
        fetchedAt: "2026-10-21T00:00:00.000Z",
        entries: [entry("io.example/alpha", { title: "Alpha", categories: [] }), granola],
      },
      [JSON.stringify({ scope: "registry", query: "granola" })]: {
        fetchedAt: "2026-10-21T00:00:00.000Z",
        entries: [granola],
      },
    };
    await fixture.render(<AllServersPage />);
    const all = () => fixture.section("All MCP servers");
    expect(fixture.rowNames(all())).toEqual(["Alpha", "Granola"]);
    expect(fixture.row("Granola").textContent).toContain("Meeting notes");
    await userEvent.type(
      fixture.container.querySelector<HTMLInputElement>('input[aria-label="Search MCP servers"]')!,
      "granola",
    );
    expect(fixture.rowNames(all())).toEqual(["Granola"]);
    // This page never asks the catalog: the registry's list is complete here.
    expect(JSON.stringify(state.queryTargets)).not.toContain('"scope":"curated"');
  });

  it("forwards an Installed search result to the Installed page", async () => {
    await using fixture = setup();
    state.hash = "#extensions-connected-services";
    await fixture.render(<DiscoverPage />);
    const redirect = fixture.container.querySelector<HTMLElement>("[data-navigate]");
    expect(redirect?.dataset.navigate).toBe("/settings/extensions/installed");
    expect(redirect?.dataset.hash).toBe("extensions-connected-services");
  });

  it("lists a category with a way back, and rejects unknown categories", async () => {
    await using fixture = setup();
    state.discoverPages = {
      [JSON.stringify({ scope: "curated", category: "featured" })]: {
        fetchedAt: "2026-10-21T00:00:00.000Z",
        entries: [entry("io.notion/notion", { title: "Notion" })],
        nextCursor: "page-2",
      },
    };
    await fixture.render(<CategoryPage category="featured" />);
    expect(linkIn(fixture.container, "Discover")?.getAttribute("href")).toBe(
      "/settings/extensions",
    );
    expect(fixture.rowNames(fixture.section("Popular"))).toEqual(["Notion"]);
    expect(buttonIn(fixture.container, "Load more")).not.toBeNull();

    await fixture.render(<CategoryPage category="nonsense" />);
    expect(fixture.container.textContent).toContain("This category does not exist.");
  });
});

describe("Installed", () => {
  it("groups connectors, Scient plugins and each agent's own items, six rows until Show all", async () => {
    await using fixture = setup();
    state.inventory = inventory({
      plugins: [
        plugin("sources", { displayName: "Sources" }),
        plugin("lab-kit", {
          displayName: "Lab kit",
          origin: "bundle",
          enabled: false,
          canSetEnabled: true,
          canRemove: true,
        }),
      ],
    });
    state.providersByEnvironment = {
      local: [
        state.providersByEnvironment.local![0]!,
        provider(claude, "claudeAgent", {
          plugins: Array.from({ length: 6 }, (_, index) => ({
            id: `claude-${index + 1}`,
            name: `claude-${index + 1}`,
            source: "local" as const,
            enabled: true,
          })),
        }),
      ],
    };
    await fixture.render(<InstalledPage />);
    expect(fixture.rowNames(fixture.section("Connected services"))).toEqual(["Linear"]);
    expect(fixture.rowNames(fixture.section("Scient plugins"))).toEqual(["Lab kit", "Sources"]);
    expect(fixture.row("Lab kit").querySelector("[data-extension-status]")?.textContent).toBe(
      "Off",
    );

    // The toggle sits in the section header, beside its heading.
    const fromCodex = fixture.section("From Codex");
    expect(fixture.rowNames(fromCodex)).toHaveLength(6);
    const toggle = buttonIn(fromCodex, "Show all 8")!;
    expect(toggle.parentElement?.querySelector("h2")?.textContent).toBe("From Codex");
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    await userEvent.click(toggle);
    expect(fixture.rowNames(fromCodex)).toHaveLength(8);
    expect(fixture.rowNames(fromCodex).at(-1)).toBe("github");
    expect(toggle.textContent).toBe("Show less");
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    await userEvent.click(toggle);
    expect(fixture.rowNames(fromCodex)).toHaveLength(6);
    expect(toggle.textContent).toBe("Show all 8");

    // Six or fewer: everything shows and there is nothing to toggle.
    const fromClaude = fixture.section("From Claude");
    expect(fixture.rowNames(fromClaude)).toHaveLength(6);
    expect(
      [...fromClaude.querySelectorAll("button")].some((button) =>
        /^Show (all|less)/.test(button.textContent ?? ""),
      ),
    ).toBe(false);
  });

  it("filters by Works with and explains when an agent cannot use connected services", async () => {
    await using fixture = setup();
    await fixture.render(<InstalledPage />);
    const worksWith = fixture.container.querySelector<HTMLSelectElement>(
      'select[aria-label="Works with"]',
    )!;
    expect([...worksWith.options].map((option) => option.textContent)).toEqual([
      "Works with any agent",
      "Codex",
      "Claude",
      "Pi",
    ]);
    await userEvent.selectOptions(worksWith, "claude");
    expect(fixture.section("From Codex")).toBeNull();
    expect(fixture.rowNames(fixture.section("From Claude"))).toEqual(["superpowers"]);
    expect(fixture.rowNames(fixture.section("Connected services"))).toEqual(["Linear"]);

    await userEvent.selectOptions(worksWith, "pi");
    expect(fixture.rowNames(fixture.section("Connected services"))).toEqual([]);
    expect(fixture.section("Connected services").textContent).toContain(
      "Pi cannot reach remote MCP servers.",
    );
  });

  it("runs row menu actions against the server and shows its refusal inline", async () => {
    await using fixture = setup();
    state.commands.update.mockResolvedValueOnce(extensionsError("Locked by a plugin."));
    await fixture.render(<InstalledPage />);
    await userEvent.click(buttonIn(fixture.row("Linear"), "Turn off")!);
    expect(state.commands.update).toHaveBeenCalledExactlyOnceWith({
      environmentId: "local",
      input: { connectorId: LINEAR, enabled: false },
    });
    expect(fixture.row("Linear").querySelector('[role="alert"]')?.textContent).toBe(
      "Locked by a plugin.",
    );
  });

  it("disables changes without settings permission but still opens items", async () => {
    await using fixture = setup();
    state.canWrite = false;
    await fixture.render(<InstalledPage />);
    expect(buttonIn(fixture.row("Linear"), "Turn off")?.disabled).toBe(true);
    expect(buttonIn(fixture.row("Linear"), "Remove")?.disabled).toBe(true);
    expect(buttonIn(fixture.row("Linear"), "Open")?.disabled).toBe(false);
    expect(buttonIn(fixture.section("Connected services"), "Add by URL")?.disabled).toBe(true);
    expect(fixture.container.textContent).toContain(
      "This connection can view extensions but not change them.",
    );
  });

  it("reads and changes the environment chosen in the settings picker", async () => {
    await using fixture = setup();
    state.scopeEnvironmentId = "remote-ssh";
    state.httpBaseUrls = {
      local: "http://127.0.0.1:3773/",
      "remote-ssh": "http://127.0.0.1:41234/",
    };
    state.inventory = inventory({
      connectors: [connector("linear0001", { displayName: "Linear", status: "needs-auth" })],
    });
    state.commands.startSignIn.mockResolvedValueOnce({ _tag: "Failure", cause: Cause.interrupt() });
    using _window = stubGlobal(
      "open",
      vi.fn(() => ({ opener: {}, location: { href: "" }, close: vi.fn(), closed: false })),
    );
    await fixture.render(<InstalledPage />);
    expect(state.queryTargets).toContainEqual({ kind: "inventory", environmentId: "remote-ssh" });
    expect(state.queryTargets).not.toContainEqual({ kind: "inventory", environmentId: "local" });
    await userEvent.click(buttonIn(fixture.row("Linear"), "Sign in")!);
    expect(state.commands.startSignIn).toHaveBeenCalledExactlyOnceWith({
      environmentId: "remote-ssh",
      input: { connectorId: LINEAR, callbackOrigin: "http://127.0.0.1:41234" },
    });
  });
});

const groupTrigger = (scope: ParentNode, label: string) =>
  [...scope.querySelectorAll("button")].find((item) => item.textContent?.startsWith(label)) ?? null;
const toolResult = (connectorId: ConnectorId, tools: ConnectorTestResult["tools"]) => ({
  _tag: "Success" as const,
  value: {
    connectorId,
    outcome: "ok" as const,
    checkedAt: "2026-10-21T00:00:00.000Z",
    tools,
  },
});
const projectA = ProjectId.make("project-a");
const projectB = ProjectId.make("project-b");
const projectC = ProjectId.make("project-c");

describe("Detail pages", () => {
  it("shows each kind's header actions", async () => {
    await using fixture = setup();
    await fixture.render(<ConnectorDetailPage connectorId="con_linear0001" />);
    expect(fixture.headerButtons()).toEqual(["Remove"]);

    await fixture.render(<ServerDetailPage name="io.notion/notion" />);
    expect(fixture.headerButtons()).toEqual(["Add", "More for Notion", "Add with options…"]);

    state.inventory = inventory({
      plugins: [
        plugin("scient.sources", { displayName: "Sources" }),
        plugin("lab-kit", {
          displayName: "Lab kit",
          origin: "bundle",
          canSetEnabled: true,
          canRemove: true,
        }),
      ],
    });
    await fixture.render(<PluginDetailPage pluginId="scient.sources" />);
    expect(fixture.headerButtons()).toEqual([]);
    await fixture.render(<PluginDetailPage pluginId="lab-kit" />);
    expect(fixture.headerButtons()).toEqual(["Turn off Lab kit", "Uninstall"]);

    await fixture.render(
      <ProviderPluginDetailPage instanceId="codex" pluginId="plugin-1" workspace={undefined} />,
    );
    expect(fixture.headerButtons()).toEqual(["Uninstall"]);
    await fixture.render(
      <ProviderPluginDetailPage instanceId="codex" pluginId="plugin-2" workspace={undefined} />,
    );
    expect(fixture.headerButtons()).toEqual([]);
    expect(fixture.header().textContent).toContain("Managed by Codex");
  });

  it("draws Add, Sign in and Reconnect like the provider Install button", async () => {
    await using fixture = setup();
    const primary = (scope: ParentNode, label: string) => {
      const button = buttonIn(scope, label)!;
      return {
        variant: button.dataset.variant,
        icon: button
          .querySelector("svg")
          ?.getAttribute("class")
          ?.match(/lucide-[a-z-]+/)?.[0],
      };
    };
    await fixture.render(<ServerDetailPage name="io.notion/notion" />);
    expect(primary(fixture.header(), "Add")).toEqual({
      variant: "ghost-primary",
      icon: "lucide-download",
    });

    state.inventory = inventory({
      connectors: [connector("linear0001", { displayName: "Linear", status: "needs-auth" })],
    });
    await fixture.render(<ConnectorDetailPage connectorId="con_linear0001" />);
    expect(primary(fixture.section("Connection"), "Sign in")).toEqual({
      variant: "ghost-primary",
      icon: "lucide-log-in",
    });

    state.inventory = inventory();
    await fixture.render(<ConnectorDetailPage connectorId="con_linear0001" />);
    expect(primary(fixture.section("Connection"), "Reconnect")).toEqual({
      variant: "ghost-primary",
      icon: "lucide-refresh-cw",
    });
    expect(buttonIn(fixture.header(), "Remove")?.dataset.variant).toBe("destructive-outline");
  });

  it("shows the connection with its sign-in, menu and On/Off switch", async () => {
    await using fixture = setup();
    state.inventory = inventory({
      connectors: [connector("linear0001", { displayName: "Linear", status: "needs-auth" })],
    });
    await fixture.render(<ConnectorDetailPage connectorId="con_linear0001" />);
    const connection = fixture.section("Connection");
    expect(connection.textContent).toContain("Needs sign-in");
    expect(buttonIn(connection, "Sign in")?.disabled).toBe(false);
    expect(buttonIn(connection, "Test")?.disabled).toBe(true);
    expect(buttonIn(fixture.header(), "Sign in")).toBeNull();
    expect(linkIn(fixture.container, "Installed")?.getAttribute("href")).toBe(
      "/settings/extensions/installed",
    );

    state.inventory = inventory({
      connectors: [connector("linear0001", { displayName: "Linear", enabled: false })],
    });
    state.commands.update.mockResolvedValueOnce(extensionsError("Locked by a plugin."));
    await fixture.render(<ConnectorDetailPage connectorId="con_linear0001" />);
    expect(fixture.section("Connection").textContent).toContain("Signed in");
    expect(buttonIn(fixture.section("Connection"), "Sign in")).toBeNull();
    expect(buttonIn(fixture.section("Connection"), "Reconnect")).not.toBeNull();
    const toggle = buttonIn(fixture.section("Connection"), "Turn on Linear")!;
    expect(toggle.getAttribute("aria-checked")).toBe("false");
    await userEvent.click(toggle);
    expect(state.commands.update).toHaveBeenCalledExactlyOnceWith({
      environmentId: "local",
      input: { connectorId: LINEAR, enabled: true },
    });
    expect(fixture.section("Connection").querySelector('[role="alert"]')?.textContent).toBe(
      "Locked by a plugin.",
    );
    expect(toggle.getAttribute("aria-checked")).toBe("false");
  });

  it("sends the whole project list for each availability change", async () => {
    await using fixture = setup();
    state.projects = [
      { environmentId: "local", id: "project-a", title: "Alpha" },
      { environmentId: "local", id: "project-b", title: "Beta" },
      { environmentId: "local", id: "scratch", title: "Scratch", isScratch: true },
      { environmentId: "remote", id: "project-c", title: "Remote" },
    ];
    state.commands.update.mockResolvedValue({ _tag: "Success", value: inventory() });
    await fixture.render(<ConnectorDetailPage connectorId="con_linear0001" />);
    await userEvent.selectOptions(
      fixture.section("Available in").querySelector("select")!,
      "projects",
    );
    expect(state.commands.update).toHaveBeenLastCalledWith({
      environmentId: "local",
      input: { connectorId: LINEAR, availability: { type: "projects", projectIds: [] } },
    });

    state.inventory = inventory({
      connectors: [
        connector("linear0001", {
          displayName: "Linear",
          availability: { type: "projects", projectIds: [] },
        }),
      ],
    });
    await fixture.render(<ConnectorDetailPage connectorId="con_linear0001" />);
    expect(fixture.section("Available in").textContent).toContain("Not available in any project.");
    const switches = () => [
      ...fixture.section("Available in").querySelectorAll<HTMLButtonElement>('[role="switch"]'),
    ];
    expect(switches().map((item) => item.getAttribute("aria-label"))).toEqual([
      "Turn on in Alpha",
      "Turn on in Beta",
    ]);
    await userEvent.click(switches()[0]!);
    expect(state.commands.update).toHaveBeenLastCalledWith({
      environmentId: "local",
      input: { connectorId: LINEAR, availability: { type: "projects", projectIds: [projectA] } },
    });

    state.inventory = inventory({
      connectors: [
        connector("linear0001", {
          displayName: "Linear",
          availability: { type: "projects", projectIds: [projectA] },
        }),
      ],
    });
    await fixture.render(<ConnectorDetailPage connectorId="con_linear0001" />);
    expect(fixture.section("Available in").textContent).not.toContain(
      "Not available in any project.",
    );
    await userEvent.click(switches()[1]!);
    expect(state.commands.update).toHaveBeenLastCalledWith({
      environmentId: "local",
      input: {
        connectorId: LINEAR,
        availability: { type: "projects", projectIds: [projectA, projectB] },
      },
    });
    await userEvent.click(switches()[0]!);
    expect(state.commands.update).toHaveBeenLastCalledWith({
      environmentId: "local",
      input: { connectorId: LINEAR, availability: { type: "projects", projectIds: [] } },
    });
  });

  it("keeps project switches working after a selected project is deleted", async () => {
    await using fixture = setup();
    // A and B were selected; B has since been deleted, so only A and C exist.
    state.projects = [
      { environmentId: "local", id: "project-a", title: "Alpha" },
      { environmentId: "local", id: "project-c", title: "Gamma" },
    ];
    state.inventory = inventory({
      connectors: [
        connector("linear0001", {
          displayName: "Linear",
          availability: { type: "projects", projectIds: [projectA, projectB] },
        }),
      ],
    });
    state.commands.update.mockResolvedValue({ _tag: "Success", value: inventory() });
    await fixture.render(<ConnectorDetailPage connectorId="con_linear0001" />);
    const available = fixture.section("Available in");
    expect(available.textContent).toContain("Deleted project");

    await userEvent.click(buttonIn(available, "Turn off in Alpha")!);
    expect(state.commands.update).toHaveBeenLastCalledWith({
      environmentId: "local",
      input: { connectorId: LINEAR, availability: { type: "projects", projectIds: [] } },
    });
    await userEvent.click(buttonIn(available, "Turn on in Gamma")!);
    expect(state.commands.update).toHaveBeenLastCalledWith({
      environmentId: "local",
      input: {
        connectorId: LINEAR,
        availability: { type: "projects", projectIds: [projectA, projectC] },
      },
    });
    await userEvent.click(buttonIn(available, "Remove deleted project project-b")!);
    expect(state.commands.update).toHaveBeenLastCalledWith({
      environmentId: "local",
      input: { connectorId: LINEAR, availability: { type: "projects", projectIds: [projectA] } },
    });
    expect(state.commands.update).not.toHaveBeenCalledWith(
      expect.objectContaining({
        input: expect.objectContaining({ availability: { type: "all-projects" } }),
      }),
    );

    // Before the project list arrives, nothing is called deleted or dropped.
    state.projectsKnown = false;
    await fixture.render(<ConnectorDetailPage connectorId="con_linear0001" />);
    expect(fixture.section("Available in").textContent).not.toContain("Deleted project");
    expect(fixture.section("Available in").textContent).toContain("Loading projects…");
  });

  it("removes a connector only after confirmation", async () => {
    await using fixture = setup();
    state.confirm.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    state.commands.remove.mockResolvedValue({ _tag: "Success", value: inventory() });
    await fixture.render(<ConnectorDetailPage connectorId="con_linear0001" />);
    await userEvent.click(buttonIn(fixture.header(), "Remove")!);
    expect(state.commands.remove).not.toHaveBeenCalled();
    await userEvent.click(buttonIn(fixture.header(), "Remove")!);
    expect(state.commands.remove).toHaveBeenCalledExactlyOnceWith({
      environmentId: "local",
      input: { connectorId: LINEAR },
    });
  });

  it("explains why a server cannot be added and adds one that can", async () => {
    await using fixture = setup();
    await fixture.render(<ServerDetailPage name="io.github.acme/local" />);
    expect(buttonIn(fixture.header(), "Add")?.disabled).toBe(true);
    expect(fixture.container.textContent).toContain("Runs locally, not supported.");

    state.commands.add.mockResolvedValueOnce({
      _tag: "Success",
      value: { connector: connector("notion0001", { displayName: "Notion" }), nextStep: "ready" },
    });
    await fixture.render(<ServerDetailPage name="io.notion/notion" />);
    await userEvent.click(buttonIn(fixture.header(), "Add")!);
    expect(state.commands.add).toHaveBeenCalledOnce();
    expect(state.toast).toHaveBeenCalledWith({ type: "success", title: "Notion added" });
  });

  it("shows an added catalog server as its connector", async () => {
    await using fixture = setup();
    await fixture.render(<ServerDetailPage name="app.linear/linear" />);
    expect(fixture.container.querySelector("h1")?.textContent).toBe("Linear");
    expect(buttonIn(fixture.section("Connection"), "Turn off Linear")).not.toBeNull();
    expect(fixture.header().querySelector("img")).not.toBeNull();
    expect(fixture.section("Available in")).not.toBeNull();
  });

  it("opens a catalog entry that no preview lists, by link, reload and search", async () => {
    await using fixture = setup();
    const synapse = entry("scient.curated/synapse", {
      title: "Synapse",
      tagline: "Biomedical research data",
      categories: ["research"],
    });
    state.entries = { [synapse.name]: synapse };
    await fixture.render(<ServerDetailPage name="scient.curated/synapse" />);
    expect(fixture.container.querySelector("h1")?.textContent).toBe("Synapse");
    expect(state.queryTargets).toContainEqual({
      kind: "entry",
      environmentId: "local",
      input: { name: "scient.curated/synapse" },
    });

    await fixture.reset();
    await fixture.render(<ServerDetailPage name="scient.curated/synapse" />);
    expect(fixture.container.querySelector("h1")?.textContent).toBe("Synapse");

    await fixture.render(<ServerDetailPage name="io.nowhere/missing" />);
    expect(fixture.container.textContent).toContain("This server was not found.");

    state.discoverPages = {
      [JSON.stringify({ scope: "curated", query: "synapse" })]: {
        fetchedAt: "2026-10-21T00:00:00.000Z",
        entries: [synapse],
      },
    };
    await fixture.render(<DiscoverPage />);
    await userEvent.type(
      fixture.container.querySelector<HTMLInputElement>('input[aria-label="Search extensions"]')!,
      "synapse",
    );
    expect(fixture.rowNames(fixture.section("Search results"))).toEqual(["Synapse"]);
    expect(linkIn(fixture.row("Synapse"), "Synapse")?.getAttribute("href")).toBe(
      "/settings/extensions/item/server/scient.curated/synapse",
    );
  });

  it("lists only the About rows it has data for", async () => {
    await using fixture = setup();
    state.entries = {
      "io.example/full": entry("io.example/full", {
        title: "Full",
        version: "3.1.0",
        websiteUrl: "https://www.full.example/docs",
        repositoryUrl: "https://github.com/acme/full",
        categories: ["featured", "research"],
      }),
      "scient.curated/bare": entry("scient.curated/bare", {
        title: "Bare",
        remotes: [],
        installable: false,
      }),
    };
    await fixture.render(<ServerDetailPage name="io.example/full" />);
    expect(fixture.aboutTerms()).toEqual([
      "Category",
      "Website",
      "Repository",
      "Works with",
      "URL",
      "Registry name",
      "Version",
      "Source",
    ]);
    expect(fixture.aboutValue("Category")).toBe("Research");
    expect(fixture.aboutValue("Website")).toBe("full.example");
    expect(fixture.aboutValue("Source")).toBe("Scient catalog");

    await fixture.render(<ServerDetailPage name="scient.curated/bare" />);
    expect(fixture.aboutTerms()).toEqual(["Works with", "Source"]);

    await fixture.render(<ConnectorDetailPage connectorId="con_linear0001" />);
    expect(fixture.aboutTerms()).toEqual([
      "Added on",
      "Works with",
      "Sign-in used",
      "URL",
      "Server name",
      "Source",
    ]);
    expect(fixture.aboutValue("Sign-in used")).toBe("OAuth");
    expect(fixture.aboutValue("Server name")).toBe("linear0001");
    expect(fixture.aboutValue("Source")).toBe("Scient catalog");
  });

  const OPENCODE_REASON = "Only when Scient starts the OpenCode server";
  const withLimitedOpenCode = () =>
    inventory({
      providerSupport: [
        ...inventory().providerSupport,
        {
          providerInstanceId: ProviderInstanceId.make("opencode"),
          driver: ProviderDriverKind.make("opencode"),
          displayName: "OpenCode",
          status: "conditional",
          reason: OPENCODE_REASON,
        },
      ],
    });
  const agentsCard = () =>
    document.querySelector<HTMLElement>('[role="dialog"][aria-label="Agents"]');
  // A closed tooltip stays mounted until its exit transition ends, which fake
  // timers never finish; only an open popup counts as showing the reason.
  const reasonTooltip = () =>
    [...document.querySelectorAll<HTMLElement>('[data-slot="tooltip-popup"][data-open]')].find(
      (item) => item.textContent?.includes(OPENCODE_REASON),
    ) ?? null;
  const advance = (ms: number) => act(() => vi.advanceTimersByTimeAsync(ms));

  it("counts the agents that can use a connector and opens their tiles above after the hover delay", async () => {
    await using fixture = setup();
    state.inventory = withLimitedOpenCode();
    await fixture.render(<ConnectorDetailPage connectorId="con_linear0001" />);
    // Agents with limits count; Pi can't use connectors at all.
    expect(fixture.aboutValue("Works with")).toBe("3 agents");
    const trigger = buttonIn(fixture.section("About"), "Works with: 3 agents")!;
    expect(trigger.textContent).toBe("3 agents");
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    expect(fixture.section("About").querySelector("[data-support]")).toBeNull();

    using _timers = fakeTimers();
    await userEvent.hover(trigger);
    await advance(199);
    expect(agentsCard()).toBeNull();
    await advance(1);
    const card = agentsCard()!;
    expect(card).not.toBeNull();
    expect(card.getAttribute("data-side")).toBe("top");
    // Directly above the count, left edges aligned, never off to one side.
    await vi.waitFor(() => {
      const cardBox = card.getBoundingClientRect();
      const triggerBox = trigger.getBoundingClientRect();
      expect(Math.abs(cardBox.left - triggerBox.left)).toBeLessThanOrEqual(2);
      expect(cardBox.bottom).toBeLessThanOrEqual(triggerBox.top);
    });
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    expect(trigger.getAttribute("aria-controls")).toBe(card.id);
    const tiles = [...card.querySelectorAll<HTMLElement>("[data-support]")];
    expect(tiles.map((tile) => tile.textContent)).toEqual(["Codex", "Claude", "OpenCode"]);
    expect(
      tiles.map((tile) =>
        tile.querySelector("[data-provider-icon]")?.getAttribute("data-provider-icon"),
      ),
    ).toEqual(["Codex", "Claude", "OpenCode"]);
    expect(tiles.map((tile) => tile.querySelector("[data-status-dot]") !== null)).toEqual([
      false,
      false,
      true,
    ]);
    // Tiles only: no limitation or "not available" text in the card.
    expect(card.querySelector("p")).toBeNull();
    expect(card.textContent).toBe("CodexClaudeOpenCode");

    // The limited agent's tile explains itself, and the card stays open.
    const limited = buttonIn(card, `OpenCode: ${OPENCODE_REASON}`)!;
    await userEvent.hover(limited);
    await advance(1000);
    expect(reasonTooltip()).not.toBeNull();
    expect(agentsCard()).not.toBeNull();
    await userEvent.unhover(limited);
    await advance(1000);
    expect(reasonTooltip()).toBeNull();
  });

  it("opens the agents card with a touch tap, and a tap pins the limited agent's reason", async () => {
    await using fixture = setup();
    state.inventory = withLimitedOpenCode();
    await fixture.render(<ConnectorDetailPage connectorId="con_linear0001" />);
    // A touch screen has no pointer resting anywhere: park the test's mouse
    // where no card or tooltip will open under it.
    await userEvent.hover(fixture.container.querySelector("h1")!);
    const trigger = buttonIn(fixture.section("About"), "Works with: 3 agents")!;
    // A real tap: touch pointer events and a click with `detail: 1` (a click
    // with `detail: 0` reads as a keyboard press).
    const tap = async (target: HTMLElement) => {
      await act(async () => {
        const init = {
          bubbles: true,
          cancelable: true,
          pointerType: "touch",
          isPrimary: true,
          detail: 1,
        };
        target.dispatchEvent(new PointerEvent("pointerdown", init));
        target.dispatchEvent(new PointerEvent("pointerup", init));
        target.dispatchEvent(new PointerEvent("click", init));
      });
    };
    await tap(trigger);
    await expect.element(page.getByRole("dialog", { name: "Agents" })).toBeVisible();
    await expect.element(page.elementLocator(trigger)).toHaveAttribute("aria-expanded", "true");
    const limited = buttonIn(agentsCard()!, `OpenCode: ${OPENCODE_REASON}`)!;
    // A touch open leaves focus where it was, so nothing in the card opens by itself.
    expect(document.activeElement).not.toBe(limited);
    expect(limited.hasAttribute("data-popup-open")).toBe(false);

    // A tap on the limited agent shows its reason, and the card stays open;
    // the next tap hides it.
    await tap(limited);
    await expect.element(page.elementLocator(limited)).toHaveAttribute("data-popup-open");
    await vi.waitFor(() => expect(reasonTooltip()).not.toBeNull());
    expect(agentsCard()).not.toBeNull();
    await tap(limited);
    await expect.element(page.elementLocator(limited)).not.toHaveAttribute("data-popup-open");

    // A tap right after focus showed the reason keeps it showing.
    await act(async () => limited.focus({ focusVisible: true }));
    await tap(limited);
    await expect.element(page.elementLocator(limited)).toHaveAttribute("data-popup-open");

    // Tapping the count again closes the card.
    await tap(trigger);
    await expect.element(page.elementLocator(trigger)).toHaveAttribute("aria-expanded", "false");
  });

  it("reaches the agents card and the limited agent's reason with Tab and Enter", async () => {
    await using fixture = setup();
    state.inventory = withLimitedOpenCode();
    await fixture.render(<ConnectorDetailPage connectorId="con_linear0001" />);
    const trigger = buttonIn(fixture.section("About"), "Works with: 3 agents")!;
    for (let step = 0; step < 60 && document.activeElement !== trigger; step += 1) {
      await userEvent.tab();
    }
    expect(document.activeElement).toBe(trigger);
    await userEvent.keyboard("{Enter}");
    const card = agentsCard()!;
    expect(card).not.toBeNull();
    expect(trigger.getAttribute("aria-controls")).toBe(card.id);
    // Focus moves into the card, onto the limited agent, which tells why.
    expect(document.activeElement).toBe(buttonIn(card, `OpenCode: ${OPENCODE_REASON}`));
    expect(reasonTooltip()).not.toBeNull();
    await userEvent.keyboard("{Escape}");
    await userEvent.keyboard("{Escape}");
    expect(agentsCard()).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it("shows a plain count when none of the agents can use the connector", async () => {
    await using fixture = setup();
    state.inventory = inventory({
      providerSupport: inventory().providerSupport.map((entry) => ({
        ...entry,
        status: "unsupported" as const,
      })),
    });
    await fixture.render(<ConnectorDetailPage connectorId="con_linear0001" />);
    expect(fixture.aboutValue("Works with")).toBe("None of your agents");
    expect(buttonIn(fixture.section("About"), "Works with: None of your agents")).toBeNull();
  });

  it("lists tools only after See tools, grouped by kind", async () => {
    await using fixture = setup();
    state.commands.test.mockResolvedValueOnce(
      toolResult(LINEAR, [
        { name: "list_issues", readOnly: true, description: "List issues" },
        { name: "delete_issue", destructive: true },
        { name: "update_issue", readOnly: false },
        { name: "ping" },
      ]),
    );
    await fixture.render(<ConnectorDetailPage connectorId="con_linear0001" />);
    expect(state.commands.test).not.toHaveBeenCalled();
    await userEvent.click(buttonIn(fixture.section("Tools"), "See tools")!);
    expect(state.commands.test).toHaveBeenCalledExactlyOnceWith({
      environmentId: "local",
      input: { connectorId: LINEAR },
    });
    const tools = fixture.section("Tools");
    expect(
      ["Write", "Read", "Other"].map((label) => groupTrigger(tools, label)?.textContent),
    ).toEqual(["Write2", "Read1", "Other1"]);
    await userEvent.click(groupTrigger(tools, "Read")!);
    expect(tools.querySelector('[aria-label="Read"]')?.textContent).toBe("list_issuesList issues");
    await userEvent.click(groupTrigger(tools, "Write")!);
    expect(
      [...tools.querySelectorAll('[aria-label="Write"] li')].map((item) => item.textContent),
    ).toEqual(["delete_issue", "update_issue"]);

    // The result stays for this connector without testing again.
    await fixture.render(<ConnectorDetailPage connectorId="con_linear0001" />);
    expect(groupTrigger(fixture.section("Tools"), "Read")).not.toBeNull();
    expect(state.commands.test).toHaveBeenCalledOnce();
  });

  it("says tools appear after adding and signing in, without testing", async () => {
    await using fixture = setup();
    await fixture.render(<ServerDetailPage name="io.notion/notion" />);
    expect(fixture.section("Tools").textContent).toBe(
      "ToolsTools appear after you add and sign in.",
    );
    expect(fixture.section("Tools").querySelector("button")).toBeNull();

    state.inventory = inventory({
      connectors: [connector("linear0001", { displayName: "Linear", status: "needs-auth" })],
    });
    await fixture.render(<ConnectorDetailPage connectorId="con_linear0001" />);
    expect(fixture.section("Tools").textContent).toBe(
      "ToolsTools appear after you add and sign in.",
    );
    expect(state.commands.test).not.toHaveBeenCalled();
  });

  it("never shows one connector's tools on another connector's page", async () => {
    await using fixture = setup();
    const notes = connector("notes00001", { displayName: "Notes" });
    state.inventory = inventory({
      connectors: [connector("linear0001", { displayName: "Linear" }), notes],
    });
    state.commands.test.mockResolvedValueOnce(
      toolResult(LINEAR, [{ name: "list_issues", readOnly: true }]),
    );
    await fixture.render(<ConnectorDetailPage connectorId="con_linear0001" />);
    await userEvent.click(buttonIn(fixture.section("Tools"), "See tools")!);
    expect(groupTrigger(fixture.section("Tools"), "Read")).not.toBeNull();

    await fixture.render(<ConnectorDetailPage connectorId="con_notes00001" />);
    expect(groupTrigger(fixture.section("Tools"), "Read")).toBeNull();
    expect(buttonIn(fixture.section("Tools"), "See tools")).not.toBeNull();

    // An answer for Linear that lands after moving to Notes is ignored.
    const late = Promise.withResolvers<unknown>();
    state.commands.test.mockReturnValueOnce(late.promise);
    await fixture.render(<ConnectorDetailPage connectorId="con_linear0001" />);
    await userEvent.click(buttonIn(fixture.section("Tools"), "See tools")!);
    await fixture.render(<ConnectorDetailPage connectorId="con_notes00001" />);
    await act(async () =>
      late.resolve(toolResult(LINEAR, [{ name: "late_tool", readOnly: true }])),
    );
    expect(fixture.section("Tools").textContent).not.toContain("Read");
    expect(buttonIn(fixture.section("Tools"), "See tools")?.disabled).toBe(false);
  });

  it("deletes cached tools whenever the connector's sign-in changes, wherever it changed", async () => {
    await using fixture = setup();
    const linearAt = (authRevision: number, patch: Partial<ConnectorSummary> = {}) => {
      state.inventory = inventory({
        connectors: [connector("linear0001", { displayName: "Linear", authRevision, ...patch })],
      });
      return fixture.render(<ConnectorDetailPage connectorId="con_linear0001" />);
    };
    state.commands.test.mockResolvedValue(
      toolResult(LINEAR, [{ name: "list_issues", readOnly: true }]),
    );
    await linearAt(0);
    await userEvent.click(buttonIn(fixture.section("Tools"), "See tools")!);
    expect(groupTrigger(fixture.section("Tools"), "Read")).not.toBeNull();

    // Another client signed in again, to the same issuer and scopes: only the
    // revision says so.
    await linearAt(1);
    expect(groupTrigger(fixture.section("Tools"), "Read")).toBeNull();
    expect(buttonIn(fixture.section("Tools"), "See tools")).not.toBeNull();

    // connected → needs sign-in → connected never brings the old tools back.
    await userEvent.click(buttonIn(fixture.section("Tools"), "See tools")!);
    expect(groupTrigger(fixture.section("Tools"), "Read")).not.toBeNull();
    await linearAt(2, { status: "needs-auth" });
    await linearAt(3);
    expect(groupTrigger(fixture.section("Tools"), "Read")).toBeNull();
    expect(state.commands.test).toHaveBeenCalledTimes(2);

    // An answer that lands after the sign-in changed is dropped.
    const late = Promise.withResolvers<unknown>();
    state.commands.test.mockReturnValueOnce(late.promise);
    await userEvent.click(buttonIn(fixture.section("Tools"), "See tools")!);
    await linearAt(4);
    await act(async () =>
      late.resolve(toolResult(LINEAR, [{ name: "late_tool", readOnly: true }])),
    );
    expect(fixture.section("Tools").textContent).not.toContain("Read");
    expect(buttonIn(fixture.section("Tools"), "See tools")?.disabled).toBe(false);
  });

  it("draws built-in plugins with a glyph and bundles with a letter tile", async () => {
    await using fixture = setup();
    state.inventory = inventory({
      plugins: [
        plugin("scient.sources", { displayName: "Sources" }),
        plugin("scient.unknown", { displayName: "Unknown" }),
        plugin("lab-kit", { displayName: "Lab kit", origin: "bundle" }),
      ],
    });
    await fixture.render(<InstalledPage />);
    expect(fixture.row("Sources").querySelector('[data-extension-icon="glyph"]')).not.toBeNull();
    expect(fixture.row("Unknown").querySelector('[data-extension-icon="glyph"]')).not.toBeNull();
    expect(fixture.row("Lab kit").querySelector("[data-extension-icon]")).toBeNull();
  });

  it("lists a plugin's parts under Includes and links its skills to the Skills page", async () => {
    await using fixture = setup();
    state.inventory = inventory({
      plugins: [
        plugin("sources", {
          displayName: "Sources",
          components: [
            { type: "skill", name: "find-papers" },
            { type: "mcp-tools", name: "sources:read", detail: "sources_search" },
          ],
        }),
      ],
    });
    await fixture.render(<PluginDetailPage pluginId="sources" />);
    const includes = fixture.section("Includes");
    expect(groupTrigger(includes, "Skills")?.textContent).toBe("Skills1");
    await userEvent.click(groupTrigger(includes, "Skills")!);
    expect(linkIn(includes, "find-papers")?.getAttribute("href")).toBe("/settings/skills");
    await userEvent.click(groupTrigger(includes, "Tools")!);
    expect(includes.querySelector('[aria-label="Tools"]')?.textContent).toBe(
      "sources:readsources_search",
    );
    expect(groupTrigger(includes, "Connected services")).toBeNull();
  });

  it("keeps each provider-plugin installation's busy state and error apart", async () => {
    await using fixture = setup();
    const pluginOne = {
      id: "plugin-1",
      name: "Codex plugin 1",
      source: "remote" as const,
      enabled: true,
      canUninstall: true,
    };
    const snapshot = (cwd: string) => ({
      cwd,
      checkedAt: "2026-10-21T00:00:00.000Z",
      slashCommands: [],
      skills: [],
      plugins: [pluginOne],
    });
    state.providersByEnvironment = {
      local: [
        provider(codex, "codex", {
          plugins: [pluginOne],
          workspaceSnapshots: [snapshot("/work/a"), snapshot("/work/b")],
        }),
      ],
    };
    state.confirm.mockResolvedValue(true);
    const pending = Promise.withResolvers<unknown>();
    state.commands.providerAct.mockReturnValueOnce(pending.promise);
    const page = (workspace: string | undefined) => (
      <ProviderPluginDetailPage instanceId="codex" pluginId="plugin-1" workspace={workspace} />
    );
    await fixture.render(page("/work/a"));
    await userEvent.click(buttonIn(fixture.header(), "Uninstall")!);
    expect(state.commands.providerAct).toHaveBeenCalledExactlyOnceWith({
      environmentId: "local",
      input: {
        instanceId: codex,
        action: { type: "uninstall", pluginId: "plugin-1" },
        cwd: "/work/a",
      },
    });
    expect(buttonIn(fixture.header(), "Uninstall")?.disabled).toBe(true);
    await fixture.render(page("/work/b"));
    expect(buttonIn(fixture.header(), "Uninstall")?.disabled).toBe(false);
    await fixture.render(page(undefined));
    expect(buttonIn(fixture.header(), "Uninstall")?.disabled).toBe(false);

    await act(async () => pending.resolve(extensionsError("Codex refused.")));
    await fixture.render(page("/work/a"));
    expect(fixture.container.querySelector('[role="alert"]')?.textContent).toBe("Codex refused.");
    await fixture.render(page("/work/b"));
    expect(fixture.container.querySelector('[role="alert"]')).toBeNull();
    await fixture.render(page(undefined));
    expect(fixture.container.querySelector('[role="alert"]')).toBeNull();
  });

  it("uninstalls a provider plugin only when the provider allows it", async () => {
    await using fixture = setup();
    state.confirm.mockResolvedValueOnce(true);
    state.commands.providerAct.mockResolvedValueOnce(extensionsError("Codex refused."));
    await fixture.render(
      <ProviderPluginDetailPage instanceId="codex" pluginId="plugin-1" workspace={undefined} />,
    );
    await userEvent.click(buttonIn(fixture.header(), "Uninstall")!);
    expect(state.commands.providerAct).toHaveBeenCalledExactlyOnceWith({
      environmentId: "local",
      input: { instanceId: codex, action: { type: "uninstall", pluginId: "plugin-1" } },
    });
    expect(fixture.container.querySelector('[role="alert"]')?.textContent).toBe("Codex refused.");
    expect(fixture.aboutValue("Managed by")).toBe("Codex");
  });
});
