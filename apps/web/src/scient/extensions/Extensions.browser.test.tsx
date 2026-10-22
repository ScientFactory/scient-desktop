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
import { RegistryContext } from "@effect/atom-react";
import * as Cause from "effect/Cause";
import { AtomRegistry } from "effect/reactivity";
import { act, cloneElement, type ReactElement, useSyncExternalStore } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

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
vi.mock("@tanstack/react-router", () => ({
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

let root: Root;
let container: HTMLDivElement;

async function render(element: ReactElement) {
  await act(async () => {
    state.version += 1;
    for (const listener of state.listeners) listener();
    root.render(<RegistryContext value={state.registry!}>{element}</RegistryContext>);
  });
}

const rowNames = (scope: ParentNode = container) =>
  [...scope.querySelectorAll<HTMLElement>("[data-extension-row]")].map(
    (row) => row.dataset.extensionRow,
  );
const row = (name: string) =>
  container.querySelector<HTMLElement>(`[data-extension-row="${name}"]`)!;
const section = (label: string) => container.querySelector<HTMLElement>(`[aria-label="${label}"]`)!;
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

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
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
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("Discover", () => {
  it("shows each catalog section with a link to its category, built-ins and Browse all", async () => {
    await render(<DiscoverPage />);
    const popular = section("Popular");
    expect(linkIn(container, "Popular")?.getAttribute("href")).toBe(
      "/settings/extensions/category/featured",
    );
    expect(rowNames(popular)).toEqual(["Linear", "Notion", "Local tool"]);
    expect(rowNames(section("Built into Scient"))).toEqual(["Sources"]);
    expect(linkIn(container, "Browse all MCP servers")?.getAttribute("href")).toBe(
      "/settings/extensions/all",
    );
    expect(linkIn(row("Notion"), "Notion")?.getAttribute("href")).toBe(
      "/settings/extensions/item/server/io.notion/notion",
    );
    expect(linkIn(row("Linear"), "Linear")?.getAttribute("href")).toBe(
      "/settings/extensions/item/connector/con_linear0001",
    );
    expect(row("Notion").textContent).toContain("Notes and docs");
  });

  it("offers + for servers not added and ⋯ for added ones", async () => {
    await render(<DiscoverPage />);
    expect(buttonIn(row("Linear"), "More for Linear")).not.toBeNull();
    expect(buttonIn(row("Linear"), "Add Linear")).toBeNull();
    expect(buttonIn(row("Notion"), "Add Notion")).not.toBeNull();
    expect(buttonIn(row("Notion"), "More for Notion")).toBeNull();

    await userEvent.click(buttonIn(row("Local tool"), "Why Local tool can't be added")!);
    expect(state.commands.add).not.toHaveBeenCalled();
    expect(state.navigate).toHaveBeenCalledWith({
      to: "/settings/extensions/item/server/$",
      params: { _splat: "io.github.acme/local" },
    });
  });

  it("adds with + and opens sign-in when the server asks for it", async () => {
    const reserved = { opener: {}, location: { href: "" }, close: vi.fn(), closed: false };
    vi.stubGlobal(
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
    await render(<DiscoverPage />);
    await userEvent.click(buttonIn(row("Notion"), "Add Notion")!);
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
    // The browser refuses the sign-in window.
    vi.stubGlobal(
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
    await render(<DiscoverPage />);
    await userEvent.click(buttonIn(row("Notion"), "Add Notion")!);
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
    await render(<DiscoverPage />);
    expect(buttonIn(row("Notion"), "More for Notion")).not.toBeNull();
    expect(row("Notion").querySelector("[data-extension-status]")?.textContent).toBe(
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
    expect(linkIn(row("Notion"), "Open sign-in page")?.getAttribute("href")).toBe(
      "https://auth.notion.so/authorize",
    );
    expect(row("Notion").querySelector("[data-extension-status]")?.textContent).toBe(
      "Needs sign-in",
    );

    await render(<ConnectorDetailPage connectorId="con_notion0001" />);
    expect(linkIn(section("Connection"), "Open sign-in page")?.getAttribute("href")).toBe(
      "https://auth.notion.so/authorize",
    );
  });

  it("draws a letter tile for an icon that is not an allowed inline image", async () => {
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
    await render(<DiscoverPage />);
    expect(row("Odd").querySelector("img")).toBeNull();
    expect(row("Odd").querySelector("[data-extension-icon]")).toBeNull();
    expect(row("Fine").querySelector('[data-extension-icon="image"] img')).not.toBeNull();
  });

  it("shows a failed add on its row", async () => {
    state.commands.add.mockResolvedValueOnce(extensionsError("The server did not answer."));
    await render(<DiscoverPage />);
    await userEvent.click(buttonIn(row("Notion"), "Add Notion")!);
    expect(row("Notion").querySelector('[role="alert"]')?.textContent).toBe(
      "The server did not answer.",
    );
  });

  it("mixes installed, built-in, curated and registry matches in one grid, each once", async () => {
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
    await render(<DiscoverPage />);
    await userEvent.type(
      container.querySelector<HTMLInputElement>('input[aria-label="Search extensions"]')!,
      "note",
    );
    expect(section("Popular")).toBeNull();
    expect(rowNames(section("Search results"))).toEqual(["Team notes", "Sources"]);

    state.discoverOutcomes = {};
    await render(<DiscoverPage />);
    expect(rowNames(section("Search results"))).toEqual([
      "Team notes",
      "Sources",
      "Notion",
      "Notes server",
    ]);
    expect(buttonIn(row("Team notes"), "More for Team notes")).not.toBeNull();
    expect(buttonIn(row("Notes server"), "Add Notes server")).not.toBeNull();

    // A later registry page skips what earlier rows already listed.
    await userEvent.click(buttonIn(section("Search results"), "Load more")!);
    expect(rowNames(section("Search results"))).toEqual([
      "Team notes",
      "Sources",
      "Notion",
      "Notes server",
      "Notebook",
    ]);
  });

  it("shows catalog matches at once while the registry is slow, then on failure", async () => {
    const curatedKey = JSON.stringify({ scope: "curated", query: "granola" });
    const registryKey = JSON.stringify({ scope: "registry", query: "granola" });
    state.discoverPages = {
      [curatedKey]: {
        fetchedAt: "2026-10-21T00:00:00.000Z",
        entries: [entry("scient.curated/granola", { title: "Granola", categories: ["writing"] })],
      },
    };
    state.discoverOutcomes = { [registryKey]: "pending" };
    await render(<DiscoverPage />);
    await userEvent.type(
      container.querySelector<HTMLInputElement>('input[aria-label="Search extensions"]')!,
      "granola",
    );
    const results = () => section("Search results");
    expect(rowNames(results())).toEqual(["Granola"]);
    expect(results().querySelector('[data-discover-pending="registry"]')?.textContent).toBe(
      "Searching the MCP Registry…",
    );

    // The registry fails: the catalog row stays and one line says why.
    state.discoverOutcomes = { [registryKey]: { error: "The MCP Registry did not answer." } };
    await render(<DiscoverPage />);
    expect(rowNames(results())).toEqual(["Granola"]);
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
    await render(<DiscoverPage />);
    expect(rowNames(results())).toEqual(["Granola", "Granola notes"]);
    expect(results().querySelector("[data-discover-error]")).toBeNull();
  });

  it("queries the registry for All MCP servers and the catalog for categories", async () => {
    await render(<AllServersPage />);
    expect(state.queryTargets).toContainEqual({
      kind: "discover",
      environmentId: "local",
      input: { scope: "registry" },
    });
    await render(<CategoryPage category="research" />);
    expect(state.queryTargets).toContainEqual({
      kind: "discover",
      environmentId: "local",
      input: { scope: "curated", category: "research" },
    });
  });

  it("lists every registry result on All MCP servers, catalog servers included", async () => {
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
    await render(<AllServersPage />);
    const all = () => section("All MCP servers");
    expect(rowNames(all())).toEqual(["Alpha", "Granola"]);
    expect(row("Granola").textContent).toContain("Meeting notes");
    await userEvent.type(
      container.querySelector<HTMLInputElement>('input[aria-label="Search MCP servers"]')!,
      "granola",
    );
    expect(rowNames(all())).toEqual(["Granola"]);
    // This page never asks the catalog: the registry's list is complete here.
    expect(JSON.stringify(state.queryTargets)).not.toContain('"scope":"curated"');
  });

  it("forwards an Installed search result to the Installed page", async () => {
    state.hash = "#extensions-connected-services";
    await render(<DiscoverPage />);
    const redirect = container.querySelector<HTMLElement>("[data-navigate]");
    expect(redirect?.dataset.navigate).toBe("/settings/extensions/installed");
    expect(redirect?.dataset.hash).toBe("extensions-connected-services");
  });

  it("lists a category with a way back, and rejects unknown categories", async () => {
    state.discoverPages = {
      [JSON.stringify({ scope: "curated", category: "featured" })]: {
        fetchedAt: "2026-10-21T00:00:00.000Z",
        entries: [entry("io.notion/notion", { title: "Notion" })],
        nextCursor: "page-2",
      },
    };
    await render(<CategoryPage category="featured" />);
    expect(linkIn(container, "Discover")?.getAttribute("href")).toBe("/settings/extensions");
    expect(rowNames(section("Popular"))).toEqual(["Notion"]);
    expect(buttonIn(container, "Load more")).not.toBeNull();

    await render(<CategoryPage category="nonsense" />);
    expect(container.textContent).toContain("This category does not exist.");
  });
});

describe("Installed", () => {
  it("groups connectors, Scient plugins and each agent's own items, six rows until Show all", async () => {
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
    await render(<InstalledPage />);
    expect(rowNames(section("Connected services"))).toEqual(["Linear"]);
    expect(rowNames(section("Scient plugins"))).toEqual(["Lab kit", "Sources"]);
    expect(row("Lab kit").querySelector("[data-extension-status]")?.textContent).toBe("Off");

    // The toggle sits in the section header, beside its heading.
    const fromCodex = section("From Codex");
    expect(rowNames(fromCodex)).toHaveLength(6);
    const toggle = buttonIn(fromCodex, "Show all 8")!;
    expect(toggle.parentElement?.querySelector("h2")?.textContent).toBe("From Codex");
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    await userEvent.click(toggle);
    expect(rowNames(fromCodex)).toHaveLength(8);
    expect(rowNames(fromCodex).at(-1)).toBe("github");
    expect(toggle.textContent).toBe("Show less");
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    await userEvent.click(toggle);
    expect(rowNames(fromCodex)).toHaveLength(6);
    expect(toggle.textContent).toBe("Show all 8");

    // Six or fewer: everything shows and there is nothing to toggle.
    const fromClaude = section("From Claude");
    expect(rowNames(fromClaude)).toHaveLength(6);
    expect(
      [...fromClaude.querySelectorAll("button")].some((button) =>
        /^Show (all|less)/.test(button.textContent ?? ""),
      ),
    ).toBe(false);
  });

  it("filters by Works with and explains when an agent cannot use connected services", async () => {
    await render(<InstalledPage />);
    const worksWith = container.querySelector<HTMLSelectElement>(
      'select[aria-label="Works with"]',
    )!;
    expect([...worksWith.options].map((option) => option.textContent)).toEqual([
      "Works with any agent",
      "Codex",
      "Claude",
      "Pi",
    ]);
    await userEvent.selectOptions(worksWith, "claude");
    expect(section("From Codex")).toBeNull();
    expect(rowNames(section("From Claude"))).toEqual(["superpowers"]);
    expect(rowNames(section("Connected services"))).toEqual(["Linear"]);

    await userEvent.selectOptions(worksWith, "pi");
    expect(rowNames(section("Connected services"))).toEqual([]);
    expect(section("Connected services").textContent).toContain(
      "Pi cannot reach remote MCP servers.",
    );
  });

  it("runs row menu actions against the server and shows its refusal inline", async () => {
    state.commands.update.mockResolvedValueOnce(extensionsError("Locked by a plugin."));
    await render(<InstalledPage />);
    await userEvent.click(buttonIn(row("Linear"), "Turn off")!);
    expect(state.commands.update).toHaveBeenCalledExactlyOnceWith({
      environmentId: "local",
      input: { connectorId: LINEAR, enabled: false },
    });
    expect(row("Linear").querySelector('[role="alert"]')?.textContent).toBe("Locked by a plugin.");
  });

  it("disables changes without settings permission but still opens items", async () => {
    state.canWrite = false;
    await render(<InstalledPage />);
    expect(buttonIn(row("Linear"), "Turn off")?.disabled).toBe(true);
    expect(buttonIn(row("Linear"), "Remove")?.disabled).toBe(true);
    expect(buttonIn(row("Linear"), "Open")?.disabled).toBe(false);
    expect(buttonIn(section("Connected services"), "Add by URL")?.disabled).toBe(true);
    expect(container.textContent).toContain(
      "This connection can view extensions but not change them.",
    );
  });

  it("reads and changes the environment chosen in the settings picker", async () => {
    state.scopeEnvironmentId = "remote-ssh";
    state.httpBaseUrls = {
      local: "http://127.0.0.1:3773/",
      "remote-ssh": "http://127.0.0.1:41234/",
    };
    state.inventory = inventory({
      connectors: [connector("linear0001", { displayName: "Linear", status: "needs-auth" })],
    });
    state.commands.startSignIn.mockResolvedValueOnce({ _tag: "Failure", cause: Cause.interrupt() });
    vi.stubGlobal(
      "open",
      vi.fn(() => ({ opener: {}, location: { href: "" }, close: vi.fn(), closed: false })),
    );
    await render(<InstalledPage />);
    expect(state.queryTargets).toContainEqual({ kind: "inventory", environmentId: "remote-ssh" });
    expect(state.queryTargets).not.toContainEqual({ kind: "inventory", environmentId: "local" });
    await userEvent.click(buttonIn(row("Linear"), "Sign in")!);
    expect(state.commands.startSignIn).toHaveBeenCalledExactlyOnceWith({
      environmentId: "remote-ssh",
      input: { connectorId: LINEAR, callbackOrigin: "http://127.0.0.1:41234" },
    });
  });
});

const header = () => container.querySelector("header")!;
const headerButtons = () =>
  [...header().querySelectorAll("button")].map(
    (item) => item.getAttribute("aria-label") ?? item.textContent,
  );
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
const aboutTerms = () =>
  [...section("About").querySelectorAll("dt")].map((item) => item.textContent);
const aboutValue = (label: string) =>
  [...section("About").querySelectorAll("dt")].find((item) => item.textContent === label)
    ?.nextElementSibling?.textContent;
const projectA = ProjectId.make("project-a");
const projectB = ProjectId.make("project-b");
const projectC = ProjectId.make("project-c");

describe("Detail pages", () => {
  it("shows each kind's header actions", async () => {
    await render(<ConnectorDetailPage connectorId="con_linear0001" />);
    expect(headerButtons()).toEqual(["Remove"]);

    await render(<ServerDetailPage name="io.notion/notion" />);
    expect(headerButtons()).toEqual(["Add", "More for Notion", "Add with options…"]);

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
    await render(<PluginDetailPage pluginId="scient.sources" />);
    expect(headerButtons()).toEqual([]);
    await render(<PluginDetailPage pluginId="lab-kit" />);
    expect(headerButtons()).toEqual(["Turn off Lab kit", "Uninstall"]);

    await render(
      <ProviderPluginDetailPage instanceId="codex" pluginId="plugin-1" workspace={undefined} />,
    );
    expect(headerButtons()).toEqual(["Uninstall"]);
    await render(
      <ProviderPluginDetailPage instanceId="codex" pluginId="plugin-2" workspace={undefined} />,
    );
    expect(headerButtons()).toEqual([]);
    expect(header().textContent).toContain("Managed by Codex");
  });

  it("draws Add, Sign in and Reconnect like the provider Install button", async () => {
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
    await render(<ServerDetailPage name="io.notion/notion" />);
    expect(primary(header(), "Add")).toEqual({
      variant: "ghost-primary",
      icon: "lucide-download",
    });

    state.inventory = inventory({
      connectors: [connector("linear0001", { displayName: "Linear", status: "needs-auth" })],
    });
    await render(<ConnectorDetailPage connectorId="con_linear0001" />);
    expect(primary(section("Connection"), "Sign in")).toEqual({
      variant: "ghost-primary",
      icon: "lucide-log-in",
    });

    state.inventory = inventory();
    await render(<ConnectorDetailPage connectorId="con_linear0001" />);
    expect(primary(section("Connection"), "Reconnect")).toEqual({
      variant: "ghost-primary",
      icon: "lucide-refresh-cw",
    });
    expect(buttonIn(header(), "Remove")?.dataset.variant).toBe("destructive-outline");
  });

  it("shows the connection with its sign-in, menu and On/Off switch", async () => {
    state.inventory = inventory({
      connectors: [connector("linear0001", { displayName: "Linear", status: "needs-auth" })],
    });
    await render(<ConnectorDetailPage connectorId="con_linear0001" />);
    const connection = section("Connection");
    expect(connection.textContent).toContain("Needs sign-in");
    expect(buttonIn(connection, "Sign in")?.disabled).toBe(false);
    expect(buttonIn(connection, "Test")?.disabled).toBe(true);
    expect(buttonIn(header(), "Sign in")).toBeNull();
    expect(linkIn(container, "Installed")?.getAttribute("href")).toBe(
      "/settings/extensions/installed",
    );

    state.inventory = inventory({
      connectors: [connector("linear0001", { displayName: "Linear", enabled: false })],
    });
    state.commands.update.mockResolvedValueOnce(extensionsError("Locked by a plugin."));
    await render(<ConnectorDetailPage connectorId="con_linear0001" />);
    expect(section("Connection").textContent).toContain("Signed in");
    expect(buttonIn(section("Connection"), "Sign in")).toBeNull();
    expect(buttonIn(section("Connection"), "Reconnect")).not.toBeNull();
    const toggle = buttonIn(section("Connection"), "Turn on Linear")!;
    expect(toggle.getAttribute("aria-checked")).toBe("false");
    await userEvent.click(toggle);
    expect(state.commands.update).toHaveBeenCalledExactlyOnceWith({
      environmentId: "local",
      input: { connectorId: LINEAR, enabled: true },
    });
    expect(section("Connection").querySelector('[role="alert"]')?.textContent).toBe(
      "Locked by a plugin.",
    );
    expect(toggle.getAttribute("aria-checked")).toBe("false");
  });

  it("sends the whole project list for each availability change", async () => {
    state.projects = [
      { environmentId: "local", id: "project-a", title: "Alpha" },
      { environmentId: "local", id: "project-b", title: "Beta" },
      { environmentId: "local", id: "scratch", title: "Scratch", isScratch: true },
      { environmentId: "remote", id: "project-c", title: "Remote" },
    ];
    state.commands.update.mockResolvedValue({ _tag: "Success", value: inventory() });
    await render(<ConnectorDetailPage connectorId="con_linear0001" />);
    await userEvent.selectOptions(section("Available in").querySelector("select")!, "projects");
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
    await render(<ConnectorDetailPage connectorId="con_linear0001" />);
    expect(section("Available in").textContent).toContain("Not available in any project.");
    const switches = () => [
      ...section("Available in").querySelectorAll<HTMLButtonElement>('[role="switch"]'),
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
    await render(<ConnectorDetailPage connectorId="con_linear0001" />);
    expect(section("Available in").textContent).not.toContain("Not available in any project.");
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
    await render(<ConnectorDetailPage connectorId="con_linear0001" />);
    const available = section("Available in");
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
    await render(<ConnectorDetailPage connectorId="con_linear0001" />);
    expect(section("Available in").textContent).not.toContain("Deleted project");
    expect(section("Available in").textContent).toContain("Loading projects…");
  });

  it("removes a connector only after confirmation", async () => {
    state.confirm.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    state.commands.remove.mockResolvedValue({ _tag: "Success", value: inventory() });
    await render(<ConnectorDetailPage connectorId="con_linear0001" />);
    await userEvent.click(buttonIn(header(), "Remove")!);
    expect(state.commands.remove).not.toHaveBeenCalled();
    await userEvent.click(buttonIn(header(), "Remove")!);
    expect(state.commands.remove).toHaveBeenCalledExactlyOnceWith({
      environmentId: "local",
      input: { connectorId: LINEAR },
    });
  });

  it("explains why a server cannot be added and adds one that can", async () => {
    await render(<ServerDetailPage name="io.github.acme/local" />);
    expect(buttonIn(header(), "Add")?.disabled).toBe(true);
    expect(container.textContent).toContain("Runs locally, not supported.");

    state.commands.add.mockResolvedValueOnce({
      _tag: "Success",
      value: { connector: connector("notion0001", { displayName: "Notion" }), nextStep: "ready" },
    });
    await render(<ServerDetailPage name="io.notion/notion" />);
    await userEvent.click(buttonIn(header(), "Add")!);
    expect(state.commands.add).toHaveBeenCalledOnce();
    expect(state.toast).toHaveBeenCalledWith({ type: "success", title: "Notion added" });
  });

  it("shows an added catalog server as its connector", async () => {
    await render(<ServerDetailPage name="app.linear/linear" />);
    expect(container.querySelector("h1")?.textContent).toBe("Linear");
    expect(buttonIn(section("Connection"), "Turn off Linear")).not.toBeNull();
    expect(header().querySelector("img")).not.toBeNull();
    expect(section("Available in")).not.toBeNull();
  });

  it("opens a catalog entry that no preview lists, by link, reload and search", async () => {
    const synapse = entry("scient.curated/synapse", {
      title: "Synapse",
      tagline: "Biomedical research data",
      categories: ["research"],
    });
    state.entries = { [synapse.name]: synapse };
    await render(<ServerDetailPage name="scient.curated/synapse" />);
    expect(container.querySelector("h1")?.textContent).toBe("Synapse");
    expect(state.queryTargets).toContainEqual({
      kind: "entry",
      environmentId: "local",
      input: { name: "scient.curated/synapse" },
    });

    await act(async () => root.unmount());
    root = createRoot(container);
    await render(<ServerDetailPage name="scient.curated/synapse" />);
    expect(container.querySelector("h1")?.textContent).toBe("Synapse");

    await render(<ServerDetailPage name="io.nowhere/missing" />);
    expect(container.textContent).toContain("This server was not found.");

    state.discoverPages = {
      [JSON.stringify({ scope: "curated", query: "synapse" })]: {
        fetchedAt: "2026-10-21T00:00:00.000Z",
        entries: [synapse],
      },
    };
    await render(<DiscoverPage />);
    await userEvent.type(
      container.querySelector<HTMLInputElement>('input[aria-label="Search extensions"]')!,
      "synapse",
    );
    expect(rowNames(section("Search results"))).toEqual(["Synapse"]);
    expect(linkIn(row("Synapse"), "Synapse")?.getAttribute("href")).toBe(
      "/settings/extensions/item/server/scient.curated/synapse",
    );
  });

  it("lists only the About rows it has data for", async () => {
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
    await render(<ServerDetailPage name="io.example/full" />);
    expect(aboutTerms()).toEqual([
      "Category",
      "Website",
      "Repository",
      "Works with",
      "URL",
      "Registry name",
      "Version",
      "Source",
    ]);
    expect(aboutValue("Category")).toBe("Research");
    expect(aboutValue("Website")).toBe("full.example");
    expect(aboutValue("Source")).toBe("Scient catalog");

    await render(<ServerDetailPage name="scient.curated/bare" />);
    expect(aboutTerms()).toEqual(["Works with", "Source"]);

    await render(<ConnectorDetailPage connectorId="con_linear0001" />);
    expect(aboutTerms()).toEqual([
      "Added on",
      "Works with",
      "Sign-in used",
      "URL",
      "Server name",
      "Source",
    ]);
    expect(aboutValue("Sign-in used")).toBe("OAuth");
    expect(aboutValue("Server name")).toBe("linear0001");
    expect(aboutValue("Source")).toBe("Scient catalog");
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
  const advance = (ms: number) => act(async () => vi.advanceTimersByTime(ms));

  it("counts the agents that can use a connector and opens their tiles above after the hover delay", async () => {
    state.inventory = withLimitedOpenCode();
    await render(<ConnectorDetailPage connectorId="con_linear0001" />);
    // Agents with limits count; Pi can't use connectors at all.
    expect(aboutValue("Works with")).toBe("3 agents");
    const trigger = buttonIn(section("About"), "Works with: 3 agents")!;
    expect(trigger.textContent).toBe("3 agents");
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    expect(section("About").querySelector("[data-support]")).toBeNull();

    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    await userEvent.hover(trigger);
    await advance(199);
    expect(agentsCard()).toBeNull();
    await advance(1);
    const card = agentsCard()!;
    expect(card).not.toBeNull();
    expect(card.getAttribute("data-side")).toBe("top");
    // Directly above the count, left edges aligned, never off to one side.
    const cardBox = card.getBoundingClientRect();
    const triggerBox = trigger.getBoundingClientRect();
    expect(Math.abs(cardBox.left - triggerBox.left)).toBeLessThanOrEqual(2);
    expect(cardBox.bottom).toBeLessThanOrEqual(triggerBox.top);
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
    vi.useRealTimers();
  });

  it("opens the agents card with a touch tap, and a tap pins the limited agent's reason", async () => {
    state.inventory = withLimitedOpenCode();
    await render(<ConnectorDetailPage connectorId="con_linear0001" />);
    // A touch screen has no pointer resting anywhere: park the test's mouse
    // where no card or tooltip will open under it.
    await userEvent.hover(container.querySelector("h1")!);
    const trigger = buttonIn(section("About"), "Works with: 3 agents")!;
    // A real tap: touch pointer events and a click with `detail: 1` (a click
    // with `detail: 0` reads as a keyboard press).
    const tap = async (target: HTMLElement) => {
      const frame = Promise.withResolvers<number>();
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
        requestAnimationFrame(frame.resolve);
        await frame.promise;
      });
    };
    await tap(trigger);
    expect(agentsCard()).not.toBeNull();
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    const limited = buttonIn(agentsCard()!, `OpenCode: ${OPENCODE_REASON}`)!;
    // A touch open leaves focus where it was, so nothing in the card opens by itself.
    expect(document.activeElement).not.toBe(limited);
    expect(limited.hasAttribute("data-popup-open")).toBe(false);

    // A tap on the limited agent shows its reason, and the card stays open;
    // the next tap hides it.
    await tap(limited);
    expect(limited.hasAttribute("data-popup-open")).toBe(true);
    expect(reasonTooltip()).not.toBeNull();
    expect(agentsCard()).not.toBeNull();
    await tap(limited);
    expect(limited.hasAttribute("data-popup-open")).toBe(false);

    // A tap right after focus showed the reason keeps it showing.
    await act(async () => limited.focus({ focusVisible: true }));
    await tap(limited);
    expect(limited.hasAttribute("data-popup-open")).toBe(true);

    // Tapping the count again closes the card.
    await tap(trigger);
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
  });

  it("reaches the agents card and the limited agent's reason with Tab and Enter", async () => {
    state.inventory = withLimitedOpenCode();
    await render(<ConnectorDetailPage connectorId="con_linear0001" />);
    const trigger = buttonIn(section("About"), "Works with: 3 agents")!;
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
    state.inventory = inventory({
      providerSupport: inventory().providerSupport.map((entry) => ({
        ...entry,
        status: "unsupported" as const,
      })),
    });
    await render(<ConnectorDetailPage connectorId="con_linear0001" />);
    expect(aboutValue("Works with")).toBe("None of your agents");
    expect(buttonIn(section("About"), "Works with: None of your agents")).toBeNull();
  });

  it("lists tools only after See tools, grouped by kind", async () => {
    state.commands.test.mockResolvedValueOnce(
      toolResult(LINEAR, [
        { name: "list_issues", readOnly: true, description: "List issues" },
        { name: "delete_issue", destructive: true },
        { name: "update_issue", readOnly: false },
        { name: "ping" },
      ]),
    );
    await render(<ConnectorDetailPage connectorId="con_linear0001" />);
    expect(state.commands.test).not.toHaveBeenCalled();
    await userEvent.click(buttonIn(section("Tools"), "See tools")!);
    expect(state.commands.test).toHaveBeenCalledExactlyOnceWith({
      environmentId: "local",
      input: { connectorId: LINEAR },
    });
    const tools = section("Tools");
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
    await render(<ConnectorDetailPage connectorId="con_linear0001" />);
    expect(groupTrigger(section("Tools"), "Read")).not.toBeNull();
    expect(state.commands.test).toHaveBeenCalledOnce();
  });

  it("says tools appear after adding and signing in, without testing", async () => {
    await render(<ServerDetailPage name="io.notion/notion" />);
    expect(section("Tools").textContent).toBe("ToolsTools appear after you add and sign in.");
    expect(section("Tools").querySelector("button")).toBeNull();

    state.inventory = inventory({
      connectors: [connector("linear0001", { displayName: "Linear", status: "needs-auth" })],
    });
    await render(<ConnectorDetailPage connectorId="con_linear0001" />);
    expect(section("Tools").textContent).toBe("ToolsTools appear after you add and sign in.");
    expect(state.commands.test).not.toHaveBeenCalled();
  });

  it("never shows one connector's tools on another connector's page", async () => {
    const notes = connector("notes00001", { displayName: "Notes" });
    state.inventory = inventory({
      connectors: [connector("linear0001", { displayName: "Linear" }), notes],
    });
    state.commands.test.mockResolvedValueOnce(
      toolResult(LINEAR, [{ name: "list_issues", readOnly: true }]),
    );
    await render(<ConnectorDetailPage connectorId="con_linear0001" />);
    await userEvent.click(buttonIn(section("Tools"), "See tools")!);
    expect(groupTrigger(section("Tools"), "Read")).not.toBeNull();

    await render(<ConnectorDetailPage connectorId="con_notes00001" />);
    expect(groupTrigger(section("Tools"), "Read")).toBeNull();
    expect(buttonIn(section("Tools"), "See tools")).not.toBeNull();

    // An answer for Linear that lands after moving to Notes is ignored.
    const late = Promise.withResolvers<unknown>();
    state.commands.test.mockReturnValueOnce(late.promise);
    await render(<ConnectorDetailPage connectorId="con_linear0001" />);
    await userEvent.click(buttonIn(section("Tools"), "See tools")!);
    await render(<ConnectorDetailPage connectorId="con_notes00001" />);
    await act(async () =>
      late.resolve(toolResult(LINEAR, [{ name: "late_tool", readOnly: true }])),
    );
    expect(section("Tools").textContent).not.toContain("Read");
    expect(buttonIn(section("Tools"), "See tools")?.disabled).toBe(false);
  });

  it("deletes cached tools whenever the connector's sign-in changes, wherever it changed", async () => {
    const linearAt = (authRevision: number, patch: Partial<ConnectorSummary> = {}) => {
      state.inventory = inventory({
        connectors: [connector("linear0001", { displayName: "Linear", authRevision, ...patch })],
      });
      return render(<ConnectorDetailPage connectorId="con_linear0001" />);
    };
    state.commands.test.mockResolvedValue(
      toolResult(LINEAR, [{ name: "list_issues", readOnly: true }]),
    );
    await linearAt(0);
    await userEvent.click(buttonIn(section("Tools"), "See tools")!);
    expect(groupTrigger(section("Tools"), "Read")).not.toBeNull();

    // Another client signed in again, to the same issuer and scopes: only the
    // revision says so.
    await linearAt(1);
    expect(groupTrigger(section("Tools"), "Read")).toBeNull();
    expect(buttonIn(section("Tools"), "See tools")).not.toBeNull();

    // connected → needs sign-in → connected never brings the old tools back.
    await userEvent.click(buttonIn(section("Tools"), "See tools")!);
    expect(groupTrigger(section("Tools"), "Read")).not.toBeNull();
    await linearAt(2, { status: "needs-auth" });
    await linearAt(3);
    expect(groupTrigger(section("Tools"), "Read")).toBeNull();
    expect(state.commands.test).toHaveBeenCalledTimes(2);

    // An answer that lands after the sign-in changed is dropped.
    const late = Promise.withResolvers<unknown>();
    state.commands.test.mockReturnValueOnce(late.promise);
    await userEvent.click(buttonIn(section("Tools"), "See tools")!);
    await linearAt(4);
    await act(async () =>
      late.resolve(toolResult(LINEAR, [{ name: "late_tool", readOnly: true }])),
    );
    expect(section("Tools").textContent).not.toContain("Read");
    expect(buttonIn(section("Tools"), "See tools")?.disabled).toBe(false);
  });

  it("draws built-in plugins with a glyph and bundles with a letter tile", async () => {
    state.inventory = inventory({
      plugins: [
        plugin("scient.sources", { displayName: "Sources" }),
        plugin("scient.unknown", { displayName: "Unknown" }),
        plugin("lab-kit", { displayName: "Lab kit", origin: "bundle" }),
      ],
    });
    await render(<InstalledPage />);
    expect(row("Sources").querySelector('[data-extension-icon="glyph"]')).not.toBeNull();
    expect(row("Unknown").querySelector('[data-extension-icon="glyph"]')).not.toBeNull();
    expect(row("Lab kit").querySelector("[data-extension-icon]")).toBeNull();
  });

  it("lists a plugin's parts under Includes and links its skills to the Skills page", async () => {
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
    await render(<PluginDetailPage pluginId="sources" />);
    const includes = section("Includes");
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
    await render(page("/work/a"));
    await userEvent.click(buttonIn(header(), "Uninstall")!);
    expect(state.commands.providerAct).toHaveBeenCalledExactlyOnceWith({
      environmentId: "local",
      input: {
        instanceId: codex,
        action: { type: "uninstall", pluginId: "plugin-1" },
        cwd: "/work/a",
      },
    });
    expect(buttonIn(header(), "Uninstall")?.disabled).toBe(true);
    await render(page("/work/b"));
    expect(buttonIn(header(), "Uninstall")?.disabled).toBe(false);
    await render(page(undefined));
    expect(buttonIn(header(), "Uninstall")?.disabled).toBe(false);

    await act(async () => pending.resolve(extensionsError("Codex refused.")));
    await render(page("/work/a"));
    expect(container.querySelector('[role="alert"]')?.textContent).toBe("Codex refused.");
    await render(page("/work/b"));
    expect(container.querySelector('[role="alert"]')).toBeNull();
    await render(page(undefined));
    expect(container.querySelector('[role="alert"]')).toBeNull();
  });

  it("uninstalls a provider plugin only when the provider allows it", async () => {
    state.confirm.mockResolvedValueOnce(true);
    state.commands.providerAct.mockResolvedValueOnce(extensionsError("Codex refused."));
    await render(
      <ProviderPluginDetailPage instanceId="codex" pluginId="plugin-1" workspace={undefined} />,
    );
    await userEvent.click(buttonIn(header(), "Uninstall")!);
    expect(state.commands.providerAct).toHaveBeenCalledExactlyOnceWith({
      environmentId: "local",
      input: { instanceId: codex, action: { type: "uninstall", pluginId: "plugin-1" } },
    });
    expect(container.querySelector('[role="alert"]')?.textContent).toBe("Codex refused.");
    expect(aboutValue("Managed by")).toBe("Codex");
  });
});
