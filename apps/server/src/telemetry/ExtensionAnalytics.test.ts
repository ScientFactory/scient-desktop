import type { ServerProvider } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import type { ConnectorRecord } from "../scient/extensions/connectors/ConnectorStateStore.ts";
import {
  connectorChangeEvents,
  connectorFacts,
  createProviderExtensionAnalyticsMapper,
  pluginFacts,
} from "./ExtensionAnalytics.ts";

const record = (
  overrides: Omit<Partial<ConnectorRecord>, "connectorId"> & { readonly connectorId?: string },
): ConnectorRecord =>
  ({
    connectorId: "c1",
    serverName: "notion",
    displayName: "Notion",
    url: "https://mcp.notion.com/mcp?token=secret",
    source: { type: "url" },
    auth: { type: "oauth" },
    status: "needs-auth",
    enabled: true,
    authRevision: 0,
    availability: { type: "all-projects" },
    createdAt: "2026-11-17T00:00:00.000Z",
    updatedAt: "2026-11-17T00:00:00.000Z",
    ...overrides,
  }) as ConnectorRecord;

describe("connectorFacts", () => {
  it("names a hosted connector by its host, never its address", () => {
    expect(connectorFacts(record({}))).toEqual({
      extensionKind: "connector",
      connector: "mcp.notion.com",
      connectorSource: "url",
      connectorServer: "notion",
      extensionName: "Notion",
      connectorHost: "mcp.notion.com",
    });
  });

  it("names registry, plugin and local connectors by their public identity", () => {
    expect(
      connectorFacts(
        record({ source: { type: "registry", name: "io.github.acme/search", version: "1.0.0" } }),
      ).connector,
    ).toBe("io.github.acme/search");
    expect(
      connectorFacts(record({ source: { type: "plugin", pluginId: "scient.zotero" } as never })),
    ).toMatchObject({ connector: "notion", plugin: "scient.zotero" });
    const local = connectorFacts(
      record({
        url: "scient-local:c1",
        source: { type: "local" },
        local: { kind: "bundle" } as ConnectorRecord["local"],
      }),
    );
    expect(local).toMatchObject({ connector: "notion", localKind: "bundle" });
    expect(local).not.toHaveProperty("connectorHost");
  });
});

describe("connectorChangeEvents", () => {
  it("reports adds, sign-ins, switches and removals", () => {
    const notion = record({});
    const github = record({ connectorId: "c2", serverName: "github", displayName: "GitHub" });
    const changes = connectorChangeEvents(
      [notion, github],
      [
        { ...notion, status: "connected", authRevision: 1, enabled: false },
        record({ connectorId: "c3", serverName: "gmail", displayName: "Gmail" }),
      ],
    ).map((event) => [event.properties.change, event.properties.connectorServer]);
    expect(changes).toEqual([
      ["connected", "notion"],
      ["disabled", "notion"],
      ["added", "gmail"],
      ["removed", "github"],
    ]);
  });

  it("tells a lost sign-in from a replaced one", () => {
    const connected = record({ status: "connected", authRevision: 1 });
    expect(
      connectorChangeEvents([connected], [{ ...connected, status: "needs-auth" }])[0]?.properties,
    ).toMatchObject({ change: "needs_sign_in", previousStatus: "connected" });
    expect(
      connectorChangeEvents([connected], [{ ...connected, authRevision: 2 }])[0]?.properties.change,
    ).toBe("credential_replaced");
  });
});

describe("createProviderExtensionAnalyticsMapper", () => {
  const provider = {
    driver: "codex",
    instanceId: "codex",
    plugins: [
      {
        id: "gmail@openai-curated",
        name: "gmail",
        displayName: "Gmail",
        source: "remote",
        enabled: true,
      },
    ],
    mcpServers: [{ name: "linear", status: "needs-auth", toolCount: 12 }],
  } as unknown as ServerProvider;

  it("reports each plugin and server once per state", () => {
    const mapper = createProviderExtensionAnalyticsMapper();
    expect(mapper.observe([provider]).map((event) => event.properties)).toEqual([
      {
        owner: "codex",
        providerInstance: "codex",
        extensionKind: "plugin",
        plugin: "gmail",
        marketplace: "openai-curated",
        extensionName: "Gmail",
        pluginSource: "remote",
        enabled: true,
      },
      {
        owner: "codex",
        providerInstance: "codex",
        extensionKind: "mcp_server",
        mcpServer: "linear",
        status: "needs-auth",
        toolCount: 12,
      },
    ]);
    expect(mapper.observe([provider])).toEqual([]);
    const signedIn = {
      ...provider,
      mcpServers: [{ name: "linear", status: "connected", toolCount: 12 }],
    } as unknown as ServerProvider;
    expect(mapper.observe([signedIn]).map((event) => event.properties.status)).toEqual([
      "connected",
    ]);
  });
});

describe("pluginFacts", () => {
  it("splits a marketplace id so it never reads as an address", () => {
    expect(pluginFacts("notion@claude-plugins.dev")).toEqual({
      plugin: "notion",
      marketplace: "claude-plugins.dev",
    });
    expect(pluginFacts("scient.zotero")).toEqual({ plugin: "scient.zotero" });
    expect(pluginFacts(undefined)).toEqual({});
  });
});
