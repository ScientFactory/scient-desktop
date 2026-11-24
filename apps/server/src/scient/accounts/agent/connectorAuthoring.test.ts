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
import { ConnectorRuntime } from "../../extensions/ExtensionsServices.ts";
import { isScientConnector } from "../../extensions/ConnectorAgentControl.ts";
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
  const reportNeedsSignIn = (shows: "shown" | "unavailable") =>
    Effect.gen(function* () {
      const registry = yield* ThreadMcpStatusRegistry.ThreadMcpStatusRegistry;
      const attachment = yield* registry.attach({
        threadId,
        providerInstanceId: ProviderInstanceId.make("claude"),
        providerThreadId: ProviderThreadId.make("pt-1"),
        providerSessionId: ProviderSessionId.make("provider-session"),
        showSignIn: () => Effect.succeed(shows),
      });
      yield* registry.replaceNative(attachment, [
        { name: "guru", source: "native", status: "needs-sign-in", action: "sign-in" },
        { name: "claude.ai Gmail", source: "claudeai", status: "needs-sign-in" },
        { name: "deepwiki", source: "native", status: "ready" },
      ]);
    });
  const inThisChat = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(
      Effect.provideService(AgentInvocationContext, invocation),
      Effect.provide(ThreadMcpStatusRegistry.layer),
    );

  it.effect("tells the agent the chat now shows the user a Sign in row", () =>
    inThisChat(
      Effect.gen(function* () {
        yield* reportNeedsSignIn("shown");
        expect(yield* agentServerSignIn("Guru")).toMatchObject({
          connector: "guru",
          status: "needs-sign-in",
          message: expect.stringContaining("Sign in row for guru"),
        });
        // claude.ai connectors sign in on claude.ai, so no row is promised.
        expect((yield* agentServerSignIn("claude.ai Gmail"))?.message).toContain(
          "claude.ai connector settings",
        );
      }),
    ),
  );

  it.effect("points to the plug button when the session can't show a row", () =>
    inThisChat(
      Effect.gen(function* () {
        yield* reportNeedsSignIn("unavailable");
        expect((yield* agentServerSignIn("guru"))?.message).toContain("plug button");
      }),
    ),
  );

  it.effect("tells the agent a connected server is ready, and leaves unknown names alone", () =>
    inThisChat(
      Effect.gen(function* () {
        yield* reportNeedsSignIn("shown");
        expect(yield* agentServerSignIn("deepwiki")).toMatchObject({
          connector: "deepwiki",
          status: "ready",
        });
        expect(yield* agentServerSignIn("notion")).toBeUndefined();
      }),
    ),
  );

  it.effect("says a turned-off server can't be signed in to", () =>
    inThisChat(
      Effect.gen(function* () {
        const registry = yield* ThreadMcpStatusRegistry.ThreadMcpStatusRegistry;
        const attachment = yield* registry.attach({
          threadId,
          providerInstanceId: ProviderInstanceId.make("claude"),
          providerThreadId: ProviderThreadId.make("pt-1"),
          providerSessionId: ProviderSessionId.make("provider-session"),
          showSignIn: () => Effect.succeed("not-available" as const),
        });
        yield* registry.replaceNative(attachment, [
          { name: "guru", source: "native", status: "needs-sign-in" },
        ]);
        expect(yield* agentServerSignIn("guru")).toMatchObject({
          status: "error",
          message: expect.stringContaining("turned off or failed"),
        });
        yield* registry.detach(attachment);
        expect((yield* agentServerSignIn("guru"))?.message).toContain("has ended");
      }),
    ),
  );

  it.effect("finds nothing where the server has no MCP status", () =>
    agentServerSignIn("guru").pipe(
      Effect.map((result) => expect(result).toBeUndefined()),
      Effect.provideService(AgentInvocationContext, invocation),
    ),
  );
});

describe("a Scient connector named like one of the agent's own servers", () => {
  it.effect("keeps its own sign-in", () =>
    Effect.gen(function* () {
      expect(yield* isScientConnector("Linear")).toBe(true);
      expect(yield* isScientConnector("guru")).toBe(false);
    }).pipe(
      Effect.provide(
        Layer.mock(ConnectorRuntime)({
          list: () =>
            Effect.succeed({
              connectors: [
                { connectorId: "con_linear", serverName: "linear", displayName: "Linear" },
              ],
            } as never),
        }),
      ),
    ),
  );

  it.effect("is never assumed where Scient has no connectors", () =>
    isScientConnector("linear").pipe(Effect.map((found) => expect(found).toBe(false))),
  );
});
