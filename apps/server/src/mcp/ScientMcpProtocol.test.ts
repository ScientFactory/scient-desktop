import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import { fullAccessCapturedPolicyLayer } from "./McpToolAccess.testkit.ts";
import { NodeHttpServer } from "@effect/platform-node";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { EnvironmentId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { McpProtocol, McpServer, Tool, Toolkit } from "effect/ai";
import * as Rpc from "effect/rpc/Rpc";
import { HttpBody, HttpClient, HttpRouter, HttpServerRequest } from "effect/http";

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
  hostMcpToolGrants,
  hostMcpTools,
  layerPreviewToolkit,
  registerScientToolkit,
  toolkitRegistration,
} from "./McpHttpServer.ts";
import * as PreviewAutomationBroker from "./PreviewAutomationBroker.ts";
import * as ServerConfig from "../config.ts";
import {
  ScientMcpProtocol,
  hostToolVisibility,
  makeScientToolListLayer,
} from "./ScientMcpProtocol.ts";
import * as McpToolAccess from "./McpToolAccess.ts";
import { ScientSourcesToolkit } from "./toolkits/sources/tools.ts";
import { PreviewToolkit } from "./toolkits/preview/tools.ts";

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
// Every call of this host tool needs `orchestration`, as upstream's thread tools do.
const HostThreads = Tool.make("host_threads", {
  parameters: Schema.Struct({ detail: Schema.optional(Schema.Boolean) }),
  success: Schema.String,
  dependencies: [McpInvocationContext],
});
const HostToolkit = Toolkit.make(HostStatus, HostThreads);
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
const previewTools = Object.values(PreviewToolkit.tools);

const scope = (actor: string): McpInvocationScope => ({
  environmentId: EnvironmentId.make("protocol-test"),
  requestNamespace: actor,
  // A thread-less OAuth client holds what McpOAuth grants it.
  ...(actor === "oauth"
    ? {
        thread: undefined,
        client: { sessionId: actor, label: actor, access: "full-access" as const },
      }
    : {
        thread: {
          threadId: ThreadId.make(actor),
          providerSessionId: actor,
          providerInstanceId: ProviderInstanceId.make("codex"),
        },
        client: undefined,
      }),
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
            : actor === "oauth"
              ? ["orchestration", "worktree", "pull-requests"]
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
  Layer.provide(
    makeScientToolListLayer([HostStatus, HostThreads, ...previewTools, ...deviceTools], {
      orchestration: [HostThreads],
      preview: previewTools,
      device: deviceTools,
    }),
  ),
);
const workspaceToolkit = Toolkit.make(ScientSourcesListTool);
const routes = Layer.mergeAll(
  toolkitRegistration(
    HostToolkit,
    McpToolAccess.toLayer(HostToolkit, {
      host_threads: McpToolAccess.reads(() => Effect.succeed("threads")),
      host_status: McpToolAccess.reads(() =>
        Effect.gen(function* () {
          const invocation = yield* McpInvocationContext;
          return invocation.capabilities.has("preview")
            ? "host-ready"
            : yield* new HostDenied({ message: "Host policy denied this call." });
        }),
      ),
    }),
  ),
  toolkitRegistration(
    DeviceToolkit,
    McpToolAccess.toLayer(DeviceToolkit, {
      device_list: McpToolAccess.reads(() => Effect.succeed("devices")),
      device_open: McpToolAccess.reads(() => Effect.succeed("opened")),
      device_screenshot: McpToolAccess.reads(() => Effect.succeed("screenshot")),
      device_close: McpToolAccess.reads(() => Effect.succeed("closed")),
    }),
  ),
  layerPreviewToolkit,
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
  Layer.provide(fullAccessCapturedPolicyLayer),
  Layer.provide(NodeCrypto.layer),
  Layer.provide(Layer.mock(ThreadManagement.ThreadManagementService)({})),
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
      ["browser", "skills", "device", "none", "oauth"],
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
    // A preview-only credential sees no orchestration-gated tool; a thread-less OAuth
    // client sees those it holds the grant for and no Scient tools.
    expect(lists[0]).not.toContain("host_threads");
    expect(lists[4]?.sort()).toEqual(["host_status", "host_threads"]);
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
  }).pipe(
    Effect.provide(Layer.mergeAll(NodeHttpServer.layerTest, NodeCrypto.layer)),
    Effect.scoped,
  ),
);

it("rejects ambiguous tool ownership at composition", () => {
  expect(() => makeScientToolListLayer([HostStatus, HostStatus])).toThrow(
    "Ambiguous MCP tool ownership",
  );
  expect(() => makeScientToolListLayer([ScientSourcesListTool])).toThrow(
    "Ambiguous MCP tool ownership",
  );
  expect(() => makeScientToolListLayer([HostStatus], { device: [DeviceList] })).toThrow(
    "MCP gated tool is not declared as a host tool",
  );
});

it("lists each upstream tool only for credentials holding its mandatory grant", () => {
  const visibility = hostToolVisibility(hostMcpTools, hostMcpToolGrants);
  const listed = (capabilities: ReadonlyArray<McpCapability>) =>
    new Set(
      hostMcpTools
        .map((tool) => tool.name)
        .filter((name) => visibility.listed(name, new Set(capabilities))),
    );
  // McpSessionRegistry's default credential: preview alone.
  const previewOnly = listed(["preview"]);
  // Pull-request tools and scient_worktree_list stay listed: forwarded to a linked
  // environment, they need only `orchestration` here.
  for (const name of [
    "preview_open",
    "scient_preview_list",
    "scient_preview_close",
    "html_render",
    "link_pull_request",
    "scient_worktree_list",
  ])
    expect(previewOnly).toContain(name);
  for (const name of [
    "scient_thread_list",
    "delegate_task",
    "scient_project_list",
    "scient_environment_read",
    "scient_attachment_prepare_upload",
    "scient_worktree_status",
    "device_list",
  ])
    expect(previewOnly).not.toContain(name);
  // McpOAuth's thread-less client: orchestration, worktree and pull requests.
  const oauth = listed(["orchestration", "worktree", "pull-requests"]);
  for (const name of [
    "scient_thread_list",
    "scient_project_list",
    "link_pull_request",
    "read_pull_request_guide",
    "scient_worktree_status",
    "html_render",
  ])
    expect(oauth).toContain(name);
  for (const name of ["preview_open", "scient_preview_list", "device_list"])
    expect(oauth).not.toContain(name);
});
