import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  ProviderInstanceId,
  ProviderSessionId,
  ProviderThreadId,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import * as ServerConfig from "../../../config.ts";
import * as ThreadMcpStatusRegistry from "../../../mcpApps/ThreadMcpStatusRegistry.ts";
import * as PreviewManager from "../../../preview/Manager.ts";
import { AgentInvocationContext } from "../../operations/AgentInvocationContext.ts";
import { agentServerSignIn, openForUser } from "./connectorAuthoring.ts";
import { ScientAccountsToolkit } from "./tools.ts";

const previews = PreviewManager.layer.pipe(
  Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "scient-connector-sign-in-" })),
  Layer.provide(NodeCrypto.layer),
  Layer.provide(NodeServices.layer),
);

const threadId = ThreadId.make("thread-sign-in");
const invocation = {
  environmentId: EnvironmentId.make("env-test"),
  threadId,
  providerSessionId: "provider-session",
  providerInstanceId: ProviderInstanceId.make("claude"),
  capabilities: new Set(["preview"] as const),
  issuedAt: 0,
};

describe("connector tools' inputs", () => {
  it("takes a blank list query, which lists as no query does", () => {
    const decode = Schema.decodeUnknownExit(
      ScientAccountsToolkit.tools.scient_connector_list.parametersSchema,
    );
    // regression: agents sent {"query": ""} and were refused ("Expected a non-blank string").
    expect(decode({ query: "" })._tag).toBe("Success");
  });
});

describe("a connector's sign-in for the user", () => {
  it.effect("opens as the user's own tab in the chat's browser, ready to finish", () =>
    Effect.gen(function* () {
      expect(yield* openForUser("https://vendor.example/authorize?state=1")).toBe(true);
      const { sessions } = yield* (yield* PreviewManager.PreviewManager).list({ threadId });
      expect(sessions).toMatchObject([
        {
          runtime: "server",
          reveal: true,
          navStatus: { url: "https://vendor.example/authorize?state=1" },
        },
      ]);
      // regression: the agent's browser held the tab, so the user had to take over first.
      expect(sessions[0]).not.toHaveProperty("automationOwner");
    }).pipe(Effect.provideService(AgentInvocationContext, invocation), Effect.provide(previews)),
  );
});

describe("a sign-in the agent asks for on one of its own MCP servers", () => {
  const reportNeedsSignIn = Effect.gen(function* () {
    const registry = yield* ThreadMcpStatusRegistry.ThreadMcpStatusRegistry;
    const attachment = yield* registry.attach({
      threadId,
      providerInstanceId: ProviderInstanceId.make("claude"),
      providerThreadId: ProviderThreadId.make("pt-1"),
      providerSessionId: ProviderSessionId.make("provider-session"),
    });
    yield* registry.replaceNative(attachment, [
      { name: "guru", source: "native", status: "needs-sign-in", action: "sign-in" },
      { name: "plugin:design:intercom", source: "native-plugin", status: "needs-sign-in" },
      { name: "claude.ai Gmail", source: "claudeai", status: "needs-sign-in" },
      { name: "deepwiki", source: "native", status: "ready" },
    ]);
  });

  it.effect(
    "tells the agent the user now has a Sign in button, for any server the chat reports",
    () =>
      Effect.gen(function* () {
        yield* reportNeedsSignIn;
        expect(yield* agentServerSignIn("Guru")).toMatchObject({
          connector: "guru",
          status: "needs-sign-in",
          message: expect.stringContaining("Sign in button for guru"),
        });
        expect(yield* agentServerSignIn("plugin:design:intercom")).toMatchObject({
          connector: "plugin:design:intercom",
        });
        // claude.ai connectors sign in on claude.ai, so no button is promised.
        expect((yield* agentServerSignIn("claude.ai Gmail"))?.message).toContain(
          "claude.ai connector settings",
        );
      }).pipe(
        Effect.provideService(AgentInvocationContext, invocation),
        Effect.provide(ThreadMcpStatusRegistry.layer),
      ),
  );

  it.effect("leaves Scient connectors and servers that need nothing to the connector tools", () =>
    Effect.gen(function* () {
      yield* reportNeedsSignIn;
      expect(yield* agentServerSignIn("deepwiki")).toBeUndefined();
      expect(yield* agentServerSignIn("notion")).toBeUndefined();
    }).pipe(
      Effect.provideService(AgentInvocationContext, invocation),
      Effect.provide(ThreadMcpStatusRegistry.layer),
    ),
  );

  it.effect("finds nothing where the server has no MCP status", () =>
    agentServerSignIn("guru").pipe(
      Effect.map((result) => expect(result).toBeUndefined()),
      Effect.provideService(AgentInvocationContext, invocation),
    ),
  );
});
