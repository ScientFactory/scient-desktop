import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import { EnvironmentId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import * as ServerConfig from "../../../config.ts";
import * as PreviewManager from "../../../preview/Manager.ts";
import { AgentInvocationContext } from "../../operations/AgentInvocationContext.ts";
import { openForUser } from "./connectorAuthoring.ts";
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
