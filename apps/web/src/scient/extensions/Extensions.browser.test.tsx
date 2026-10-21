import {
  ConnectorId,
  type ConnectorSummary,
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
      const page = state.discoverPages[JSON.stringify(atom.input ?? {})];
      return {
        data: page ?? { entries: [], fetchedAt: "2026-10-21T00:00:00.000Z" },
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

import { CategoryPage, DiscoverPage } from "./DiscoverPages";
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
    state.discoverPages = {
      [JSON.stringify({ query: "note" })]: {
        fetchedAt: "2026-10-21T00:00:00.000Z",
        entries: [
          entry("io.notion/notion", { title: "Notion" }),
          entry("io.github.x/notes", { title: "Notes server", categories: [] }),
        ],
      },
    };
    await render(<DiscoverPage />);
    await userEvent.type(
      container.querySelector<HTMLInputElement>('input[aria-label="Search extensions"]')!,
      "note",
    );
    expect(section("Popular")).toBeNull();
    expect(rowNames(section("Search results"))).toEqual([
      "Team notes",
      "Sources",
      "Notion",
      "Notes server",
    ]);
    expect(buttonIn(row("Team notes"), "More for Team notes")).not.toBeNull();
    expect(buttonIn(row("Notes server"), "Add Notes server")).not.toBeNull();
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
      [JSON.stringify({ category: "featured" })]: {
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
  it("groups connectors, Scient plugins and each agent's own items, six rows before Show all", async () => {
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
    await render(<InstalledPage />);
    expect(rowNames(section("Connected services"))).toEqual(["Linear"]);
    expect(rowNames(section("Scient plugins"))).toEqual(["Lab kit", "Sources"]);
    expect(row("Lab kit").querySelector("[data-extension-status]")?.textContent).toBe("Off");

    const fromCodex = section("From Codex");
    expect(rowNames(fromCodex)).toHaveLength(6);
    await userEvent.click(buttonIn(fromCodex, "Show all 8")!);
    expect(rowNames(fromCodex)).toHaveLength(8);
    expect(rowNames(fromCodex).at(-1)).toBe("github");
    expect(buttonIn(fromCodex, "Show all 8")).toBeNull();
    expect(rowNames(section("From Claude"))).toEqual(["superpowers"]);
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
const detailsDialog = () => document.querySelector<HTMLElement>('[role="dialog"]')!;
const groupTrigger = (label: string) =>
  [...detailsDialog().querySelectorAll("button")].find((item) =>
    item.textContent?.startsWith(label),
  ) ?? null;
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
    expect(headerButtons()).toEqual(["View details", "Remove"]);

    await render(<ServerDetailPage name="io.notion/notion" />);
    expect(headerButtons()).toEqual([
      "View details",
      "Add",
      "More for Notion",
      "Add with options…",
    ]);

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
    expect(headerButtons()).toEqual(["View details"]);
    await render(<PluginDetailPage pluginId="lab-kit" />);
    expect(headerButtons()).toEqual(["Turn off Lab kit", "View details", "Uninstall"]);

    await render(
      <ProviderPluginDetailPage instanceId="codex" pluginId="plugin-1" workspace={undefined} />,
    );
    expect(headerButtons()).toEqual(["View details", "Uninstall"]);
    await render(
      <ProviderPluginDetailPage instanceId="codex" pluginId="plugin-2" workspace={undefined} />,
    );
    expect(headerButtons()).toEqual(["View details"]);
    expect(header().textContent).toContain("Managed by Codex");
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
      [JSON.stringify({ query: "synapse" })]: {
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

  it("summarizes which agents a connector works with and lists them on demand", async () => {
    await render(<ConnectorDetailPage connectorId="con_linear0001" />);
    expect(aboutValue("Works with")).toContain("2 of 3 agents");
    const listed = () =>
      [...section("About").querySelectorAll<HTMLElement>("[data-support]")].map(
        (item) => item.textContent,
      );
    expect(listed()).toEqual([]);
    await userEvent.click(buttonIn(section("About"), "Show agents")!);
    expect(listed()).toEqual([
      "Codex — Works",
      "Claude — Works",
      "Pi — Pi cannot reach remote MCP servers.",
    ]);

    state.inventory = inventory({
      providerSupport: inventory().providerSupport.filter((entry) => entry.status === "supported"),
    });
    await render(<ConnectorDetailPage connectorId="con_linear0001" />);
    expect(aboutValue("Works with")).toContain("All your agents");
  });

  it("tests on View details and groups a connector's tools by kind", async () => {
    state.commands.test.mockResolvedValueOnce({
      _tag: "Success",
      value: {
        connectorId: LINEAR,
        outcome: "ok",
        checkedAt: "2026-10-21T00:00:00.000Z",
        tools: [
          { name: "list_issues", readOnly: true, description: "List issues" },
          { name: "delete_issue", destructive: true },
          { name: "update_issue", readOnly: false },
          { name: "ping" },
        ],
      },
    });
    await render(<ConnectorDetailPage connectorId="con_linear0001" />);
    await userEvent.click(buttonIn(header(), "View details")!);
    expect(state.commands.test).toHaveBeenCalledExactlyOnceWith({
      environmentId: "local",
      input: { connectorId: LINEAR },
    });
    expect(detailsDialog().querySelector("[data-details-summary]")?.textContent).toBe(
      "The Linear app contains 4 tools (2 write, 1 read, 1 other)",
    );
    expect(
      ["Write", "Read", "Other", "Works with"].map((label) => groupTrigger(label)?.textContent),
    ).toEqual(["Write2", "Read1", "Other1", "Works with3"]);
    await userEvent.click(groupTrigger("Read")!);
    expect(detailsDialog().querySelector('[aria-label="Read"]')?.textContent).toBe(
      "list_issuesList issues",
    );
    await userEvent.click(groupTrigger("Write")!);
    expect(
      [...detailsDialog().querySelectorAll('[aria-label="Write"] li')].map(
        (item) => item.textContent,
      ),
    ).toEqual(["delete_issue", "update_issue"]);
  });

  it("says tools appear after adding and signing in, without testing", async () => {
    await render(<ServerDetailPage name="io.notion/notion" />);
    await userEvent.click(buttonIn(header(), "View details")!);
    expect(detailsDialog().querySelector("[data-details-summary]")?.textContent).toBe(
      "Tools appear after you add and sign in.",
    );
    expect(groupTrigger("Works with")).not.toBeNull();
    expect(groupTrigger("Write")).toBeNull();

    state.inventory = inventory({
      connectors: [connector("linear0001", { displayName: "Linear", status: "needs-auth" })],
    });
    await render(<ConnectorDetailPage connectorId="con_linear0001" />);
    await userEvent.click(buttonIn(header(), "View details")!);
    expect(detailsDialog().querySelector("[data-details-summary]")?.textContent).toBe(
      "Tools appear after you add and sign in.",
    );
    expect(state.commands.test).not.toHaveBeenCalled();
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

  it("lists a plugin's parts in View details and links its skills to the Skills page", async () => {
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
    await userEvent.click(buttonIn(header(), "View details")!);
    expect(detailsDialog().querySelector("[data-details-summary]")?.textContent).toBe(
      "The Sources plugin contains 1 skill and 1 tool set",
    );
    await userEvent.click(groupTrigger("Skills")!);
    expect(linkIn(detailsDialog(), "find-papers")?.getAttribute("href")).toBe("/settings/skills");
    await userEvent.click(groupTrigger("Tools")!);
    expect(detailsDialog().querySelector('[aria-label="Tools"]')?.textContent).toBe(
      "sources:readsources_search",
    );
    expect(groupTrigger("Connected services")).toBeNull();
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
