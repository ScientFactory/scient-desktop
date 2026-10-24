import { describe, expect, it, vi } from "vite-plus/test";
import {
  EnvironmentId,
  makeProviderSettingsSchema,
  SourceControlProviderKind,
} from "@t3tools/contracts";
import { UNKNOWN_SOURCE_CONTROL_CLIENT } from "@t3tools/client-runtime/source-control-clients";
import * as Schema from "effect/Schema";

import {
  filterAvailableSettingsSearchItems,
  getSettingsSearchTargetScope,
  getThreadAutoSettlementSearchAvailability,
  isSettingsSearchScopeAvailable,
  searchableSetting,
  searchSettings,
  SETTINGS_SECTION_LABELS,
  SETTINGS_SEARCH_ITEMS,
  sourceControlHostSearchItems,
  sourceControlHostSettingsSearchId,
  type SettingsSearchItem,
} from "./settingsSearch";

const ITEMS: ReadonlyArray<SettingsSearchItem> = [
  {
    id: "word-wrap",
    title: "Word wrap",
    to: "/settings/general",
    searchTerms: ["long lines in code previews"],
  },
  {
    id: "network-access",
    title: "Network access",
    to: "/settings/connections",
    searchTerms: ["remote pairing backend"],
  },
  {
    id: "providers",
    title: "Providers",
    to: "/settings/providers",
    searchTerms: ["claude codex agents"],
  },
  {
    id: "provider-updates",
    title: "Update checks",
    to: "/settings/general",
  },
  {
    id: "automatic-updates",
    title: "Automatic updates",
    to: "/settings/general",
  },
];

describe("settings sidebar order", () => {
  it("finds the canonical Scient command and its former t3 name", () => {
    expect(searchableSetting("cli-command").title).toBe("scient command");
    const items = SETTINGS_SEARCH_ITEMS.filter((item) => item.id === "cli-command").map((item) => ({
      ...item,
      desktopOnly: false,
    }));
    expect(searchSettings("scient command", items).map((item) => item.id)).toEqual(["cli-command"]);
    expect(searchSettings("t3", items).map((item) => item.id)).toEqual(["cli-command"]);
  });

  it("keeps integrations prominent, Documents after Scientific Computing, then keybindings", () => {
    const paths = Object.keys(SETTINGS_SECTION_LABELS);

    expect(paths.indexOf("/settings/integrations")).toBe(paths.indexOf("/settings/projects") + 1);
    expect(paths.indexOf("/settings/documents")).toBe(
      paths.indexOf("/settings/scientific-computing") + 1,
    );
    expect(paths.indexOf("/settings/keybindings")).toBe(paths.indexOf("/settings/documents") + 1);
  });

  it("shows Shortcuts without changing the existing route", () => {
    expect(SETTINGS_SECTION_LABELS["/settings/keybindings"]).toBe("Shortcuts");
    expect(searchSettings("keybindings").some((item) => item.id === "keybindings")).toBe(true);
  });
});

describe("searchSettings", () => {
  it("does not offer the withheld privacy-policy link", () => {
    expect(SETTINGS_SEARCH_ITEMS.map((item) => item.id)).not.toContain("privacy-policy");
    expect(searchSettings("privacy policy")).toEqual([]);
    expect(searchSettings("diagnostics")[0]).toMatchObject({ id: "diagnostics" });
  });

  it("matches titles, sections, and remembered setting details", () => {
    expect(searchSettings("word", ITEMS).map((item) => item.id)).toEqual(["word-wrap"]);
    expect(searchSettings("network", ITEMS).map((item) => item.id)).toEqual(["network-access"]);
    expect(searchSettings("connections", ITEMS).map((item) => item.id)).toEqual(["network-access"]);
    expect(searchSettings("claude", ITEMS).map((item) => item.id)).toEqual(["providers"]);
    expect(searchSettings("long lines", ITEMS).map((item) => item.id)).toEqual(["word-wrap"]);
  });

  it("matches normalized title substrings", () => {
    expect(searchSettings("  WORD   WRAP  ", ITEMS).map((item) => item.id)).toEqual(["word-wrap"]);
    expect(searchSettings("glass").map((item) => item.id)).toEqual(["setting-glass-opacity"]);
    expect(searchSettings("panel animations").map((item) => item.id)).toEqual(["panel-animations"]);
    expect(searchSettings("thè\u{1ab0}mes")[0]?.id).toBe("theme");
    const localeLowerCase = vi.spyOn(String.prototype, "toLocaleLowerCase").mockReturnValue("gıt");
    try {
      expect(searchSettings("GIT")[0]?.id).toBe("git-fetch-interval");
      expect(localeLowerCase).not.toHaveBeenCalled();
    } finally {
      localeLowerCase.mockRestore();
    }
    expect(searchSettings("xyzzy")).toEqual([]);
  });

  it("matches query words across fields and ranks the strongest result first", () => {
    expect(searchSettings("pairing remote", ITEMS).map((item) => item.id)).toEqual([
      "network-access",
    ]);
    expect(
      searchSettings("remote pairing")
        .slice(0, 2)
        .map((item) => item.id),
    ).toEqual(["network-access", "connections-environment"]);
  });

  it.each(["font weight", "text thickness"])("finds interface typography by %s", (query) => {
    expect(searchSettings(query)[0]).toMatchObject({
      id: "interface-font",
      to: "/settings/appearance",
    });
  });

  it("hides desktop-only settings from browser search", () => {
    expect(SETTINGS_SEARCH_ITEMS.some((item) => item.id === "quit-confirmation")).toBe(true);
    expect(searchSettings("hold to quit")).toEqual([]);
    expect(searchSettings("wsl")).toEqual([]);
    expect(searchSettings("update track")).toEqual([]);
  });

  it("hides settings whose controls are unavailable", () => {
    const available = filterAvailableSettingsSearchItems({
      hasCloudPublicConfig: false,
      hasEnvironment: false,
      hasProviderSettingsEnvironment: false,
      hasMacProviderSettingsEnvironment: false,
      canManageLocalBackend: false,
      isWslSettingsRowVisible: false,
      hasThreadAutoSettlement: false,
    });

    const gatedIds = new Set<string>([
      "follow-change-request-templates",
      "git-fetch-interval",
      "network-access",
      "publish-agent-activity",
      "provider-health-check-interval",
      "cursor-keychain-usage",
      "source-control-writer-model",
      "review-guide-model",
      "review-guide-instructions",
      "source-control-writing-style",
      "t3-connect",
      "hold-webhooks-while-offline",
      "tailscale-https",
      "wsl-backend",
      "auto-settle-inactive-threads",
      "auto-settle-merged-threads",
      "days-before-auto-settle",
    ]);
    expect(available.map((item) => item.id).filter((id) => gatedIds.has(id))).toEqual([]);
  });

  it("finds keybinding commands by label, command id, and default key", () => {
    expect(searchSettings("toggle sidebar")[0]?.id).toBe("keybinding-sidebar.toggle");
    expect(searchSettings("sidebar.toggle")[0]?.id).toBe("keybinding-sidebar.toggle");
    expect(searchSettings("mod+b")[0]?.id).toBe("keybinding-sidebar.toggle");
    expect(searchSettings("copy link")[0]).toMatchObject({
      id: "keybinding-thread.copyReference",
      to: "/settings/keybindings",
    });
  });

  it("ranks keybinding commands after other settings", () => {
    const ids = searchSettings("model").map((item) => item.id);
    const commandIndex = ids.indexOf("keybinding-modelPicker.toggle");
    expect(commandIndex).toBeGreaterThan(-1);
    for (const id of ["custom-models", "default-model", "text-generation-model"]) {
      expect(ids.indexOf(id)).toBeGreaterThan(-1);
      expect(commandIndex).toBeGreaterThan(ids.indexOf(id));
    }
  });

  it("sends commands without a default binding to the section", () => {
    expect(searchSettings("thread.stop")[0]).toMatchObject({
      id: "keybinding-thread.stop",
      targetId: "keybindings",
    });
    expect(searchSettings("sidebar.toggle")[0]?.targetId).toBeUndefined();
  });

  it("keeps catalog result ids unique", () => {
    const ids = SETTINGS_SEARCH_ITEMS.map((item) => item.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("routes Scientific Computing to its dedicated settings page", () => {
    expect(searchSettings("scientific computing")[0]).toMatchObject({
      id: "scientific-computing",
      to: "/settings/scientific-computing",
    });
  });

  it("finds Word export by the words people look for it with", () => {
    for (const query of ["word export", "pandoc", "docx", "export"]) {
      expect(searchSettings(query)[0], query).toMatchObject({
        id: "word-export",
        to: "/settings/documents",
      });
    }
    expect(searchSettings("word wrap")[0]?.id).toBe("word-wrap");
  });

  it("finds the Documents page by format, engine, and template", () => {
    for (const [query, id] of [
      ["documents", "documents"],
      ["latex", "latex-installation"],
      ["tinytex", "latex-installation"],
      ["template", "new-document-template"],
    ] as const) {
      expect(searchSettings(query)[0], query).toMatchObject({ id, to: "/settings/documents" });
    }
    // Markdown shortcuts lead; the Documents page still answers.
    expect(searchSettings("markdown").some((item) => item.id === "documents")).toBe(true);
  });

  it("routes compiler status into technical details and installation into actionable tools", () => {
    for (const query of [
      "compiler status",
      "available compilers",
      "compiler versions",
      "executable paths",
    ]) {
      expect(searchSettings(query)[0], query).toMatchObject({
        id: "latex-compilers",
        to: "/settings/documents",
        targetId: "latex-compilers",
      });
    }
    for (const query of ["install latex", "additional compilers", "tinytex"]) {
      expect(searchSettings(query)[0], query).toMatchObject({
        id: "latex-installation",
        to: "/settings/documents",
        targetId: "latex-installation",
      });
    }
    expect(searchSettings("default latex compiler")[0]).toMatchObject({
      id: "new-document-compiler",
      targetId: "new-document-compiler",
    });
  });

  it("routes compilation modes to the Documents picker", () => {
    for (const query of ["autocompile", "auto-compile", "pdf compilation"]) {
      expect(searchSettings(query)[0], query).toMatchObject({
        id: "latex-compilation",
        to: "/settings/documents",
        targetId: "latex-compilation",
      });
    }
  });
});

describe("settings search targets", () => {
  it("keeps the safety-held telemetry export action out of settings search", () => {
    expect(searchSettings("OpenTelemetry export")).toEqual([]);
    expect(SETTINGS_SEARCH_ITEMS.map((item) => item.id)).not.toContain("telemetry-export");
  });

  it("keeps environment-wide settings out of project scopes", () => {
    const updates = getSettingsSearchTargetScope("provider-update-checks")!;
    expect(updates.scope).toBe("environment-defaults");
    expect(isSettingsSearchScopeAvailable(updates.scope, "environment")).toBe(true);
    expect(isSettingsSearchScopeAvailable(updates.scope, "all")).toBe(true);
    expect(isSettingsSearchScopeAvailable(updates.scope, "project")).toBe(false);
    const streaming = getSettingsSearchTargetScope("response-streaming")!;
    expect(streaming.scope).toBe("project-defaults");
    expect(isSettingsSearchScopeAvailable(streaming.scope, "project")).toBe(true);
    for (const id of ["legacy-plan-mode", "legacy-context-window-indicator", "legacy-sidebar"]) {
      expect(getSettingsSearchTargetScope(id)!.scope).toBeNull();
    }
  });
});

describe("auto-settlement search availability", () => {
  function environment(id: string, { connected = true, loaded = true, supported = true } = {}) {
    return {
      environmentId: EnvironmentId.make(id),
      connection: { phase: connected ? ("connected" as const) : ("offline" as const) },
      serverConfig: loaded
        ? { environment: { capabilities: { threadAutoSettlement: supported } } }
        : null,
    };
  }

  const capable = environment("capable");
  const unsupported = environment("unsupported", { supported: false });
  const offline = environment("offline", { connected: false });
  const loading = environment("loading", { loaded: false });
  const environments = [capable, unsupported, offline, loading];

  it("keeps results discoverable when one connected environment supports them", () => {
    const availability = getThreadAutoSettlementSearchAvailability(environments);
    expect(availability.eligibleEnvironmentIds).toEqual([capable.environmentId]);
    const items = filterAvailableSettingsSearchItems({
      hasCloudPublicConfig: false,
      hasEnvironment: true,
      hasProviderSettingsEnvironment: true,
      hasMacProviderSettingsEnvironment: false,
      canManageLocalBackend: false,
      isWslSettingsRowVisible: false,
      hasThreadAutoSettlement: availability.eligibleEnvironmentIds.length > 0,
    });
    expect(searchSettings("auto-settle", items).map((item) => item.id)).toEqual([
      "auto-settle-inactive-threads",
      "auto-settle-merged-threads",
      "days-before-auto-settle",
    ]);
  });

  it("offers only capable environments when an aggregate has mixed capabilities", () => {
    expect(
      getThreadAutoSettlementSearchAvailability(environments, {
        kind: "all",
        environmentIds: environments.map((entry) => entry.environmentId),
      }),
    ).toEqual({ eligibleEnvironmentIds: [capable.environmentId], isTargetAvailable: false });
  });

  it.each([unsupported, offline, loading])(
    "does not render the target on $environmentId or silently fall back",
    (selected) => {
      expect(
        getThreadAutoSettlementSearchAvailability(environments, {
          kind: "environment",
          environmentIds: [selected.environmentId],
        }),
      ).toEqual({ eligibleEnvironmentIds: [capable.environmentId], isTargetAvailable: false });
    },
  );

  it("ignores offline and unloaded targets when all connected targets support the setting", () => {
    const selected = [capable, offline, loading];
    expect(
      getThreadAutoSettlementSearchAvailability(selected, {
        kind: "all",
        environmentIds: selected.map((entry) => entry.environmentId),
      }).isTargetAvailable,
    ).toBe(true);
  });
});

describe("source control host search items", () => {
  const definition = {
    ...UNKNOWN_SOURCE_CONTROL_CLIENT,
    kind: SourceControlProviderKind.make("example"),
    label: "Example",
    searchKeywords: ["sample"],
    settings: makeProviderSettingsSchema({ apiToken: Schema.String }),
  };

  it("lists a host by its label, its keywords, and its settings fields", () => {
    const items = sourceControlHostSearchItems([UNKNOWN_SOURCE_CONTROL_CLIENT, definition]);
    expect(items.map((item) => item.title)).toEqual(["Example credentials"]);
    expect(searchSettings("sample apitoken", items).map((item) => item.id)).toEqual([
      sourceControlHostSettingsSearchId("example"),
    ]);
  });

  it("lists a host with credentials by its accounts, token and CLI", () => {
    const items = sourceControlHostSearchItems([
      {
        ...definition,
        credentials: {
          cliName: "ex",
          cliLabel: "Example CLI",
          loginCommand: "ex login",
          tokenEnvVar: "EX_TOKEN",
          tokenAccess: "access",
          newTokenUrl: (host) => `https://${host}/tokens`,
        },
      },
    ]);
    expect(items.map((item) => item.title)).toEqual(["Example accounts and token"]);
    expect(searchSettings("ex switch accounts", items)).toHaveLength(1);
  });

  it("finds the built-in hosts by their own words", () => {
    expect(searchSettings("codeberg").map((item) => item.id)).toContain("source-control");
    expect(searchSettings("ghes").map((item) => item.id)).toContain(
      sourceControlHostSettingsSearchId("github"),
    );
  });
});
