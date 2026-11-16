// @effect-diagnostics nodeBuiltinImport:off
// @effect-diagnostics preferSchemaOverJson:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import { expect, it, vi } from "vite-plus/test";

import { advertisedJsonSchema } from "../../mcp/advertisedJsonSchema.ts";
import { hostMcpTools } from "../../mcp/McpHttpServer.ts";
import { scientTools } from "../../mcp/ScientOperationCatalog.ts";
import { scientAgentToolCopy } from "../ScientAgentCopy.ts";
import { scientAgentTarget } from "../scient/ScientAgentTarget.ts";
import {
  SCIENT_ALWAYS_LOADED_TOOLS,
  SCIENT_CONNECTOR_LOAD_MODE_ENV,
  scientConnectorLoadMode,
} from "../scient/ScientAgentToolLoading.ts";
import { ompScientExtensionSource } from "./OmpScientExtension.ts";
import { ompTarget } from "./OmpTarget.ts";

type RegisteredTool = {
  name: string;
  description: string;
  parameters: unknown;
  loadMode: string;
  execute: (id: string, args: unknown) => Promise<{ content: unknown }>;
};

const connectors = [
  "github",
  "jira",
  "confluence",
  "slack",
  "drive",
  "gmail",
  "calendar",
  "notion",
  "linear",
  "figma",
  "dropbox",
  "salesforce",
  "hubspot",
  "airtable",
  "zendesk",
].map((serverName) => ({
  serverName,
  displayName: serverName,
  url: `https://fixture.invalid/${serverName}`,
}));

const connectorTools = Array.from({ length: 30 }, (_, index) => ({
  name: `${["search", "list", "get", "create", "update", "delete"][index % 6]}_${["records", "comments", "files", "members", "projects"][Math.floor(index / 6)]}`,
  description:
    "Find or manage workspace records using the connected account. Supply the workspace and record identifier when known. Search accepts a query and structured filters. Results include stable identifiers, titles, links, timestamps, owners, and a next-page cursor. Writes require the exact target identifier; omitted optional fields preserve existing values.",
  inputSchema: {
    type: "object",
    properties: {
      workspaceId: {
        type: "string",
        description: "Workspace or organization identifier returned by list workspaces.",
      },
      recordId: { type: "string", description: "Stable identifier of the existing target record." },
      query: {
        type: "string",
        description: "Search text; quote exact phrases and use field filters to narrow results.",
      },
      title: {
        type: "string",
        description: "Title for a new record or replacement title for an existing record.",
      },
      body: {
        type: "string",
        description:
          "Record content in Markdown. Preserve existing content unless replacing it was requested.",
      },
      filters: {
        type: "object",
        properties: {
          statuses: {
            type: "array",
            items: { type: "string", enum: ["open", "pending", "closed", "archived"] },
          },
          owners: { type: "array", items: { type: "string" } },
          updatedAfter: { type: "string", format: "date-time" },
          includeArchived: { type: "boolean", default: false },
        },
      },
      sort: {
        type: "object",
        properties: {
          field: { type: "string", enum: ["createdAt", "updatedAt", "title"] },
          direction: { type: "string", enum: ["asc", "desc"] },
        },
      },
      pageSize: {
        type: "integer",
        minimum: 1,
        maximum: 100,
        description: "Maximum records per page, default 25.",
      },
      cursor: {
        type: "string",
        description:
          "Opaque cursor returned by the previous page; leave absent for the first page.",
      },
      fields: {
        type: "array",
        items: { type: "string" },
        description: "Optional response fields to include. Identifiers are always returned.",
      },
    },
    required: ["workspaceId"],
    additionalProperties: false,
  },
}));

it("bounds always-sent schemas on capable runtimes and preserves deferred and legacy calls", async () => {
  const catalog = [...scientTools, ...hostMcpTools].map((tool) =>
    scientAgentToolCopy({
      name: tool.name,
      description: tool.description ?? tool.name,
      inputSchema: advertisedJsonSchema(tool),
    }),
  );
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "scient-tool-loading-"));
  const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const body = JSON.parse(String(init?.body)) as {
      id: number;
      method: string;
      params?: { name?: string };
    };
    if (body.method === "notifications/initialized") return new Response(null, { status: 202 });
    const result =
      body.method === "initialize"
        ? { protocolVersion: "2025-06-18" }
        : body.method === "tools/list"
          ? { tools: String(input).endsWith("/scient") ? catalog : connectorTools }
          : { content: [{ type: "text", text: `${String(input)}:${body.params?.name}` }] };
    return Response.json({ jsonrpc: "2.0", id: body.id, result });
  });
  try {
    const measurements: Array<{
      version: string;
      tools: number;
      alwaysSent: number;
      bytes: number;
      estimatedTokens: number;
    }> = [];
    for (const [version, runtimeVersion, target] of [
      ["0.1.4", "18.18.0", scientAgentTarget],
      ["0.1.3", "18.13.0", scientAgentTarget],
      ["0.1.4", "18.4.8", scientAgentTarget],
      ["18.18.0", "18.18.0", ompTarget],
      ["18.17.0", "18.17.0", ompTarget],
    ] as const) {
      const identity =
        target === scientAgentTarget
          ? target.identify(
              JSON.stringify({
                product: "scient-agent",
                version,
                upstream: { name: "oh-my-pi", version: runtimeVersion },
                rpcProtocolVersions: [2],
              }),
            )
          : target.identify(version);
      expect(identity).toBeDefined();
      const mode = scientConnectorLoadMode(target, identity!);
      vi.stubEnv(SCIENT_CONNECTOR_LOAD_MODE_ENV, mode);
      const bootstrapPath = NodePath.join(
        root,
        `${version}-${target.driverKind}-${runtimeVersion}.json`,
      );
      const extensionPath = `${bootstrapPath}.mjs`;
      NodeFS.writeFileSync(
        bootstrapPath,
        JSON.stringify({
          endpoint: "https://fixture.invalid/scient",
          authorization: "Bearer synthetic",
          awareness: "Scient",
          connectors,
        }),
      );
      NodeFS.writeFileSync(extensionPath, ompScientExtensionSource(target, bootstrapPath));
      const hosts = [];
      for (const load of [1, 2]) {
        const tools: Array<RegisteredTool> = [];
        const handlers = new Map<string, (event: { systemPrompt: string[] }) => unknown>();
        const extension = (await import(
          /* @vite-ignore */ `${NodeURL.pathToFileURL(extensionPath).href}?load=${load}`
        )) as {
          default: (api: unknown) => Promise<void>;
        };
        await extension.default({
          registerTool: (tool: RegisteredTool) => tools.push(tool),
          on: (name: string, handler: (event: { systemPrompt: string[] }) => unknown) =>
            handlers.set(name, handler),
          registerCommand: () => undefined,
        });
        hosts.push(tools);
        expect(tools).toHaveLength(catalog.length + 450);
        expect(tools.filter((tool) => tool.loadMode === "essential")).toHaveLength(
          mode === "discoverable" ? SCIENT_ALWAYS_LOADED_TOOLS.length : catalog.length + 450,
        );
        expect(tools.find((tool) => tool.name === "tool_search")?.loadMode).toBe(
          mode === "discoverable" ? "discoverable" : "essential",
        );
        expect(tools.find((tool) => tool.name === "delegate_task")?.loadMode).toBe("essential");
        expect(
          tools
            .filter((tool) => catalog.some(({ name }) => name === tool.name))
            .every(
              (tool) =>
                tool.loadMode ===
                (mode === "discoverable" && !SCIENT_ALWAYS_LOADED_TOOLS.includes(tool.name)
                  ? "discoverable"
                  : "essential"),
            ),
        ).toBe(true);
        const awareness = handlers.get("before_agent_start")!({ systemPrompt: ["base"] });
        expect(awareness).toBeDefined();
        // Both a continuation and a subagent re-import must retain executable connector routes.
        for (const prompt of ["first", "continue"]) {
          expect(
            await tools.find((tool) => tool.name === "scient_connector_list")!.execute("call", {}),
          ).toMatchObject({
            content: [
              { type: "text", text: "https://fixture.invalid/scient:scient_connector_list" },
            ],
          });
          handlers.get("before_agent_start")!({ systemPrompt: [prompt] });
          expect(
            await tools.find((tool) => tool.name === "github__search_records")!.execute("call", {}),
          ).toMatchObject({
            content: [{ type: "text", text: "https://fixture.invalid/github:search_records" }],
          });
        }
      }
      expect(hosts[0]!.map(({ name, loadMode }) => ({ name, loadMode }))).toEqual(
        hosts[1]!.map(({ name, loadMode }) => ({ name, loadMode })),
      );
      const alwaysSent = hosts[0]!.filter((tool) => tool.loadMode === "essential");
      const bytes = Buffer.byteLength(
        JSON.stringify(
          alwaysSent.map(({ name, description, parameters }) => ({
            name,
            description,
            input_schema: parameters,
          })),
        ),
      );
      measurements.push({
        version,
        tools: hosts[0]!.length,
        alwaysSent: alwaysSent.length,
        bytes,
        estimatedTokens: Math.ceil(bytes / 4),
      });
      if (mode === "discoverable") expect(bytes).toBeLessThan(32_000);
      else expect(bytes).toBeGreaterThan(800_000);
    }
    process.stdout.write(
      `Synthetic tool schemas (UTF-8 JSON bytes; tokens estimated at 4 bytes/token)\n${JSON.stringify(measurements, null, 2)}\n`,
    );
  } finally {
    fetchMock.mockRestore();
    vi.unstubAllEnvs();
    NodeFS.rmSync(root, { recursive: true, force: true });
  }
});
