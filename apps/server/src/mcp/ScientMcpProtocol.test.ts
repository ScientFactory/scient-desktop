import { NodeHttpServer } from "@effect/platform-node";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { EnvironmentId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { McpProtocol, McpServer, Tool, Toolkit } from "effect/unstable/ai";
import * as Rpc from "effect/unstable/rpc/Rpc";
import { HttpBody, HttpClient, HttpRouter, HttpServerRequest } from "effect/unstable/http";

import {
  McpInvocationContext,
  type McpCapability,
  type McpInvocationScope,
} from "./McpInvocationContext.ts";
import { WorkspaceBindingResolver } from "../scient/projectScope/WorkspaceBindingResolver.ts";
import { WorkspaceBindingResolutionError } from "../scient/projectScope/WorkspaceBinding.ts";
import { workspaceResolverForTest } from "../scient/projectScope/WorkspaceBindingTestUtils.ts";
import {
  ScientSkillsToolkitRegistrationLive,
  PreviewToolkitRegistrationLive,
} from "./McpHttpServer.ts";
import * as PreviewAutomationBroker from "./PreviewAutomationBroker.ts";
import * as ServerConfig from "../config.ts";
import { ScientMcpProtocol, makeScientToolListLayer } from "./ScientMcpProtocol.ts";
import { registerScientToolkit } from "./ScientToolkitRegistration.ts";
import { ScientSourcesToolkit } from "./toolkits/sources/tools.ts";

const ScientSourcesListTool = ScientSourcesToolkit.tools.scient_sources_list;
class HostDenied extends Schema.TaggedError<HostDenied>()("HostDenied", {
  message: Schema.String,
}) {}
// A host-owned tool has no Scient annotation and retains its own call policy.
const HostStatus = Tool.make("host_status", {
  parameters: Schema.Struct({ detail: Schema.optional(Schema.Boolean) }),
  success: Schema.String,
  failure: HostDenied,
  dependencies: [McpInvocationContext],
});
const HostToolkit = Toolkit.make(HostStatus);
const deviceParameters = Schema.Struct({ target: Schema.optional(Schema.String) });
const makeDeviceTool = <const Name extends string>(name: Name) =>
  Tool.make(name, {
    parameters: deviceParameters,
    success: Schema.String,
    dependencies: [McpInvocationContext],
  });
const DeviceList = makeDeviceTool("device_list");
const DeviceOpen = makeDeviceTool("device_open");
const DeviceScreenshot = makeDeviceTool("device_screenshot");
const DeviceClose = makeDeviceTool("device_close");
const DeviceToolkit = Toolkit.make(DeviceList, DeviceOpen, DeviceScreenshot, DeviceClose);
const deviceTools = Object.values(DeviceToolkit.tools);

const scope = (actor: string): McpInvocationScope => ({
  environmentId: EnvironmentId.make("protocol-test"),
  threadId: ThreadId.make(actor),
  providerSessionId: actor,
  providerInstanceId: ProviderInstanceId.make("codex"),
  issuedAt: 1,
  capabilities: new Set<McpCapability>(
    actor === "browser"
      ? ["preview"]
      : actor === "workspace"
        ? ["sources:read"]
        : actor === "skills"
          ? ["skills:read"]
          : actor === "device"
            ? ["device"]
            : [],
  ),
  ...(actor === "skills"
    ? {
        skillScope: {
          catalog: { status: "complete" as const, digest: `sha256:${"a".repeat(64)}` },
          skills: [],
          releases: new Map(),
        },
      }
    : {}),
});

const decodeToolList = Schema.decodeUnknownEffect(
  Schema.fromJsonString(
    Schema.Struct({
      result: Schema.Struct({ tools: Schema.Array(Schema.Struct({ name: Schema.String })) }),
    }),
  ),
);

// Synthetic ingress and unavailable workspace; exercise actual MCP transport,
// schemas, registration, discovery middleware and call admission.
const Auth = HttpRouter.middleware<{ provides: McpInvocationContext }>()((effect) =>
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    return yield* effect.pipe(
      Effect.provideService(McpInvocationContext, scope(request.headers["x-test-actor"] ?? "none")),
    );
  }),
).layer;

const transport = McpServer.layerHttp({
  name: "Scient protocol test",
  version: "1",
  path: "/mcp",
  protocols: [ScientMcpProtocol],
}).pipe(
  Layer.provide(Auth),
  Layer.provide(makeScientToolListLayer([HostStatus, ...deviceTools], deviceTools)),
);
const workspaceToolkit = Toolkit.make(ScientSourcesListTool);
const routes = Layer.mergeAll(
  Layer.effectDiscard(McpServer.registerToolkit(HostToolkit)).pipe(
    Layer.provide(
      HostToolkit.toLayer({
        host_status: () =>
          Effect.gen(function* () {
            const invocation = yield* McpInvocationContext;
            return invocation.capabilities.has("preview")
              ? "host-ready"
              : yield* new HostDenied({ message: "Host policy denied this call." });
          }),
      }),
    ),
  ),
  Layer.effectDiscard(McpServer.registerToolkit(DeviceToolkit)).pipe(
    Layer.provide(
      DeviceToolkit.toLayer({
        device_list: () => Effect.succeed("devices"),
        device_open: () => Effect.succeed("opened"),
        device_screenshot: () => Effect.succeed("screenshot"),
        device_close: () => Effect.succeed("closed"),
      }),
    ),
  ),
  PreviewToolkitRegistrationLive,
  ScientSkillsToolkitRegistrationLive,
  registerScientToolkit(workspaceToolkit).pipe(
    Layer.provide(
      workspaceToolkit.toLayer({
        scient_sources_list: () =>
          Effect.die("Workspace admission must fail before the domain handler"),
      }),
    ),
  ),
).pipe(
  Layer.provideMerge(transport),
  Layer.provide(PreviewAutomationBroker.layer.pipe(Layer.provide(NodeServices.layer))),
  Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "scient-mcp-protocol-" })),
  Layer.provide(
    Layer.succeed(WorkspaceBindingResolver, {
      ...workspaceResolverForTest(new Map()),
      resolveThread: () =>
        Effect.fail(
          new WorkspaceBindingResolutionError({
            operation: "protocol-fixture",
            kind: "workspace-unavailable",
          }),
        ),
    }),
  ),
);

it("preserves the selected protocol's wire schemas and existing client middleware", () => {
  for (const [name, original] of McpProtocol.v2025_06_18.clientRpcs.requests) {
    const adapted = ScientMcpProtocol.clientRpcs.requests.get(name);
    if (name !== "tools/list") {
      expect(adapted).toBe(original);
      continue;
    }
    expect(Rpc.isRpc(original) && Rpc.isRpc(adapted)).toBe(true);
    if (!Rpc.isRpc(original) || !Rpc.isRpc(adapted)) throw new Error("Expected RPC definitions");
    expect(adapted.payloadSchema).toBe(original.payloadSchema);
    expect(adapted.successSchema).toBe(original.successSchema);
    expect(adapted.errorSchema).toBe(original.errorSchema);
    for (const middleware of original.middlewares)
      expect(adapted.middlewares.has(middleware)).toBe(true);
  }
});

it.effect("isolates concurrent MCP discovery and rejects calls outside each current view", () =>
  Effect.gen(function* () {
    yield* HttpRouter.serve(routes, { disableListenLog: true, disableLogger: true }).pipe(
      Layer.build,
    );
    const client = yield* HttpClient.HttpClient;
    const request = (actor: string, method: string, params: unknown, session?: string) =>
      client.post("/mcp", {
        headers: {
          accept: "application/json, text/event-stream",
          "x-test-actor": actor,
          "mcp-protocol-version": "2025-06-18",
          ...(session ? { "mcp-session-id": session } : {}),
        },
        body: HttpBody.text(
          JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
          "application/json",
        ),
      });
    const sessions = yield* Effect.forEach(
      ["browser", "skills", "device", "none"],
      (actor) =>
        Effect.gen(function* () {
          const initialized = yield* request(actor, "initialize", {
            protocolVersion: "2025-06-18",
            capabilities: {},
            clientInfo: { name: actor, version: "1" },
          });
          expect(initialized.status).toBe(200);
          return { actor, session: initialized.headers["mcp-session-id"]! };
        }),
      { concurrency: 2 },
    );
    const lists = yield* Effect.forEach(
      sessions,
      ({ actor, session }) =>
        Effect.gen(function* () {
          const response = yield* request(actor, "tools/list", {}, session);
          const body = yield* response.text;
          const data =
            body.startsWith("data:") || body.includes("\ndata:")
              ? body
                  .split("\n")
                  .find((line) => line.startsWith("data:"))!
                  .slice(5)
              : body;
          const decoded = yield* decodeToolList(data);
          return decoded.result.tools.map((tool) => tool.name);
        }),
      { concurrency: 2 },
    );
    expect(lists[0]).toContain("preview_snapshot");
    expect(lists[0]).not.toContain("scient_skill_load");
    expect(lists[1]?.sort()).toEqual([
      "host_status",
      "scient_skill_load",
      "scient_skill_read_resource",
      "scient_skills_list",
    ]);
    expect(lists[2]?.filter((name) => name.startsWith("device_")).toSorted()).toEqual([
      "device_close",
      "device_list",
      "device_open",
      "device_screenshot",
    ]);
    expect(lists[2]).toContain("host_status");
    expect(lists[2]).not.toContain("scient_skills_list");
    expect(lists[3]?.sort()).toEqual(["host_status"]);
    yield* Effect.forEach(
      Array.from({ length: 64 }, (_, index) => sessions[index % sessions.length]!),
      ({ actor, session }) =>
        Effect.gen(function* () {
          const response = yield* request(actor, "tools/list", {}, session);
          expect(response.status).toBe(200);
          const body = yield* response.text;
          expect(body.includes('"name":"preview_snapshot"')).toBe(actor === "browser");
          expect(body.includes('"name":"scient_skill_load"')).toBe(actor === "skills");
          expect(body.includes('"name":"device_list"')).toBe(actor === "device");
          expect(body.includes('"name":"device_open"')).toBe(actor === "device");
          expect(body.includes('"name":"device_screenshot"')).toBe(actor === "device");
          expect(body.includes('"name":"device_close"')).toBe(actor === "device");
        }),
      { concurrency: 8 },
    );
    // A provider settings change is applied when a fresh or resumed provider session receives
    // its credential. The same MCP transport session must use that credential's current scope.
    const deviceTransportSession = sessions[2]!.session;
    const disabledDeviceList = yield* request("none", "tools/list", {}, deviceTransportSession);
    const disabledDeviceBody = yield* disabledDeviceList.text;
    expect(disabledDeviceBody).not.toContain('"name":"device_list"');
    const enabledDeviceList = yield* request("device", "tools/list", {}, deviceTransportSession);
    const enabledDeviceBody = yield* enabledDeviceList.text;
    for (const name of ["device_list", "device_open", "device_screenshot", "device_close"])
      expect(enabledDeviceBody).toContain(`"name":"${name}"`);
    const denied = yield* request(
      "browser",
      "tools/call",
      { name: "scient_skills_list", arguments: {} },
      sessions[0]!.session,
    );
    const deniedBody = yield* denied.text;
    expect(deniedBody).toContain('"isError":true');
    expect(deniedBody).toContain("This Scient operation is not available in this agent session.");
    const allowed = yield* request(
      "skills",
      "tools/call",
      { name: "scient_skills_list", arguments: {} },
      sessions[1]!.session,
    );
    expect(yield* allowed.text).toContain('"skills":[]');
    // A transport session is not a cached grant. Re-evaluate each request.
    const withdrawn = yield* request("none", "tools/list", {}, sessions[1]!.session);
    const withdrawnList = yield* withdrawn.text;
    expect(withdrawnList).toContain('"name":"host_status"');
    expect(withdrawnList).not.toContain('"name":"scient_skill');
    const hostAllowed = yield* request(
      "browser",
      "tools/call",
      { name: "host_status", arguments: {} },
      sessions[0]!.session,
    );
    expect(yield* hostAllowed.text).toContain("host-ready");
    const hostDenied = yield* request(
      "none",
      "tools/call",
      { name: "host_status", arguments: {} },
      sessions[0]!.session,
    );
    expect(yield* hostDenied.text).toContain("Host policy denied this call.");
    const withdrawnCall = yield* request(
      "none",
      "tools/call",
      { name: "scient_skills_list", arguments: {} },
      sessions[1]!.session,
    );
    const withdrawnBody = yield* withdrawnCall.text;
    expect(withdrawnBody).toContain('"isError":true');
    expect(withdrawnBody).toContain(
      "This Scient operation is not available in this agent session.",
    );
    const workspaceCall = yield* request(
      "workspace",
      "tools/call",
      { name: "scient_sources_list", arguments: {} },
      sessions[1]!.session,
    );
    const workspaceBody = yield* workspaceCall.text;
    expect(workspaceBody).toContain('"isError":true');
    expect(workspaceBody).toContain("Scient could not verify the current project workspace.");
    expect(workspaceBody).not.toContain("Workspace admission must fail");
    const malformed = yield* request(
      "skills",
      "tools/call",
      { name: "scient_skills_list", arguments: { limit: -1 } },
      sessions[1]!.session,
    );
    expect(yield* malformed.text).toContain('"code":-32602');
  }).pipe(Effect.provide(NodeHttpServer.layerTest), Effect.scoped),
);

it("rejects ambiguous tool ownership at composition", () => {
  expect(() => makeScientToolListLayer([HostStatus, HostStatus])).toThrow(
    "Ambiguous MCP tool ownership",
  );
  expect(() => makeScientToolListLayer([ScientSourcesListTool])).toThrow(
    "Ambiguous MCP tool ownership",
  );
  expect(() => makeScientToolListLayer([HostStatus], [DeviceList])).toThrow(
    "MCP device tool is not declared as a host tool",
  );
});
