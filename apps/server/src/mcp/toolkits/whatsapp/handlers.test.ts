import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  ProviderInstanceId,
  ThreadId,
  type WhatsAppStatus,
  WhatsAppToolError,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { McpSchema, McpServer } from "effect/ai";

import * as ServerConfig from "../../../config.ts";
import { WhatsAppService } from "../../../scient/whatsapp/WhatsAppService.ts";
import * as McpHttpServer from "../../McpHttpServer.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccessTestkit from "../../McpToolAccess.testkit.ts";
import { summarizeStatus } from "./handlers.ts";

const threadId = ThreadId.make("thread-whatsapp-test");
const client = McpSchema.McpServerClient.of({
  clientId: 1,
  clientCapabilities: {},
  clientInfo: { name: "mcp-test", version: "1.0.0" },
  protocolVersion: "2025-06-18",
  initializePayload: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "mcp-test", version: "1.0.0" },
  },
  getClient: Effect.die("unused"),
});

const calls: Array<{ readonly operation: string; readonly input: unknown }> = [];
const layerWhatsAppMock = Layer.mock(WhatsAppService)({
  listChats: (input) => {
    calls.push({ operation: "listChats", input });
    return Effect.succeed([]);
  },
  listMessages: (input) => {
    calls.push({ operation: "listMessages", input });
    return Effect.succeed([]);
  },
  searchContacts: (input) => {
    calls.push({ operation: "searchContacts", input });
    return Effect.succeed([]);
  },
  sendText: (input) => {
    calls.push({ operation: "sendText", input });
    return Effect.fail(
      new WhatsAppToolError({
        code: "first-message-from-phone",
        message: "Send the first message to this person from your phone.",
      }),
    );
  },
});

const layerTest = McpHttpServer.layerWhatsAppToolkit.pipe(
  Layer.provideMerge(McpHttpServer.layerInProcessMcpServer),
  Layer.provideMerge(McpToolAccessTestkit.liveThreadsLayer),
  Layer.provideMerge(layerWhatsAppMock),
  Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "t3-mcp-whatsapp-test-" })),
  Layer.provide(NodeServices.layer),
);

const call = (
  name: string,
  args: Record<string, unknown>,
  capabilities: ReadonlyArray<McpInvocationContext.McpCapability> = ["whatsapp"],
) =>
  Effect.gen(function* () {
    const server = yield* McpServer.McpServer;
    return yield* server.callTool({ name, arguments: args }).pipe(
      Effect.provideService(McpInvocationContext.McpInvocationContext, {
        environmentId: EnvironmentId.make("environment-whatsapp-test"),
        requestNamespace: "provider-session-whatsapp-test",
        thread: {
          threadId,
          providerSessionId: "provider-session-whatsapp-test",
          providerInstanceId: ProviderInstanceId.make("codex"),
        },
        client: undefined,
        capabilities: new Set(capabilities),
        issuedAt: 1,
      }),
      Effect.provideService(McpSchema.McpServerClient, client),
    );
  });

it.effect("refuses every WhatsApp tool without the whatsapp grant", () =>
  Effect.gen(function* () {
    calls.length = 0;
    const read = yield* call("whatsapp_chats", {}, ["orchestration"]);
    const send = yield* call("whatsapp_send", { to: "+972501234567", text: "hi" }, [
      "orchestration",
    ]);
    expect(read.isError).toBe(true);
    expect(send.isError).toBe(true);
    expect(calls).toEqual([]);
  }).pipe(Effect.provide(layerTest)),
);

it.effect("applies default limits and caps larger ones before calling WhatsApp", () =>
  Effect.gen(function* () {
    calls.length = 0;
    expect((yield* call("whatsapp_chats", { unreadOnly: true })).isError).toBe(false);
    expect((yield* call("whatsapp_messages", { chat: "Mom", limit: 500 })).isError).toBe(false);
    expect((yield* call("whatsapp_contacts", { query: "Dana", limit: 7 })).isError).toBe(false);
    expect(calls).toEqual([
      { operation: "listChats", input: { query: undefined, unreadOnly: true, limit: 20 } },
      { operation: "listMessages", input: { chat: "Mom", limit: 100 } },
      { operation: "searchContacts", input: { query: "Dana", limit: 7 } },
    ]);
  }).pipe(Effect.provide(layerTest)),
);

it.effect("surfaces a WhatsApp failure as a tool error that names its code", () =>
  Effect.gen(function* () {
    const result = yield* call("whatsapp_send", { to: "+972501234567", text: "hi" });
    expect(result.isError).toBe(true);
    expect(result.content).toEqual([
      {
        type: "text",
        text: "first-message-from-phone: Send the first message to this person from your phone.",
      },
    ]);
  }).pipe(Effect.provide(layerTest)),
);

it.effect("sends to one recipient only", () =>
  Effect.gen(function* () {
    calls.length = 0;
    for (const to of ["Dana Levi", "+972501234567, +972507654321"]) {
      const refused = yield* call("whatsapp_send", { to, text: "hi" }).pipe(Effect.flip);
      expect(refused).toBeInstanceOf(McpSchema.InvalidParams);
    }
    expect(calls).toEqual([]);
  }).pipe(Effect.provide(layerTest)),
);

const status = (state: WhatsAppStatus["state"]): WhatsAppStatus => ({
  state,
  deviceName: "Test Mac",
  platformSupported: true,
});

it("never gives the agent the QR code, and states when a restriction ends", () => {
  const linking = summarizeStatus(status({ _tag: "AwaitingScan", qr: "2@secret", issuedAt: 1 }));
  expect(JSON.stringify(linking)).not.toContain("2@secret");
  expect(linking).toMatchObject({ linked: false, state: "awaiting-scan" });

  expect(
    summarizeStatus(status({ _tag: "Restricted", until: Date.UTC(2026, 11, 1, 9, 30) })),
  ).toMatchObject({ state: "restricted", restrictedUntil: "2026-12-01T09:30:00.000Z" });

  expect(summarizeStatus(status({ _tag: "Unlinked" })).next).toContain(
    "Settings → Extensions → WhatsApp",
  );
});
