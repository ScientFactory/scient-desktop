import {
  type ConnectorAuthSummary,
  ConnectorId,
  type ConnectorSummary,
  ProviderInstanceId,
} from "@t3tools/contracts";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { expect } from "vite-plus/test";

import { McpInvocationContext } from "../../../mcp/McpInvocationContext.ts";
import { ProjectionStoreV2 } from "../../../orchestration-v2/ProjectionStore.ts";
import { OrchestratorMcpService } from "../../../mcp/OrchestratorMcpService.ts";
import { SecretRequests } from "../../../secrets/SecretRequests.ts";
import { ConnectorRuntime } from "../../extensions/ExtensionsServices.ts";
import { setupAdvice } from "../../extensions/connectors/agentStatus.ts";
import { AgentInvocationContext } from "../../operations/AgentInvocationContext.ts";
import { AccountsService } from "../AccountsService.ts";
import { setUpConnector } from "./connectorSetup.ts";

const hosted = (
  serverName: string,
  auth: ConnectorAuthSummary,
  status: ConnectorSummary["status"],
): ConnectorSummary => ({
  connectorId: ConnectorId.make(`con_${serverName.padEnd(12, "0")}`),
  serverName,
  displayName: serverName.toUpperCase(),
  url: `https://${serverName}.example/mcp`,
  source: { type: "url" },
  auth,
  status,
  enabled: true,
  authRevision: 0,
  availability: { type: "all-projects" },
  createdAt: "2026-11-15T00:00:00.000Z",
  updatedAt: "2026-11-15T00:00:00.000Z",
});

const open = hosted("pubmed", { type: "none" }, "connected");
const oauth = hosted("notion", { type: "oauth", usesOwnClient: false }, "needs-auth");
const keyGone = hosted(
  "brave",
  { type: "credential", strategy: "bearer", storage: "bound" },
  "needs-credential",
);
const github = hosted(
  "github",
  { type: "source-control", host: "github.com", account: "octo" },
  "needs-credential",
);

// A hosted connector has nothing set up here: no card, no account, no change.
const untouched = Layer.mergeAll(
  Layer.mock(AccountsService)({}),
  Layer.mock(OrchestratorMcpService)({}),
  Layer.mock(SecretRequests)({}),
  Layer.succeed(McpInvocationContext)({} as never),
  Layer.mock(ProjectionStoreV2)({}),
);

const setUp = (connector: string) =>
  setUpConnector({ connector }).pipe(
    Effect.provide(
      Layer.mergeAll(
        untouched,
        Layer.mock(ConnectorRuntime)({
          list: () =>
            Effect.succeed({
              revision: 0,
              connectors: [open, oauth, keyGone, github],
              diagnostics: [],
            } as never),
        }),
        Layer.succeed(AgentInvocationContext)({
          providerInstanceId: ProviderInstanceId.make("antigravity"),
        } as AgentInvocationContext["Service"]),
      ),
    ),
  );

it.effect("answers setup for a hosted connector with what it needs and who gives it", () =>
  Effect.gen(function* () {
    // regression: setup refused every hosted connector ("No local connector is named pubmed").
    expect(yield* setUp("pubmed")).toEqual({
      status: "ready",
      missing: [],
      message:
        'PUBMED needs no setup; it\'s ready. scient_connector_check {"connector":"pubmed"} lists its tools.',
    });
    expect((yield* setUp("notion")).message).toContain(
      'scient_connector_control {"connector":"notion","action":"sign-in"}',
    );
    for (const name of ["brave", "github"]) {
      const answer = yield* setUp(name);
      expect(answer.status).toBe("needs");
      expect(answer.message).toContain("Ask the user");
    }
    const missing = yield* setUp("nothing-here").pipe(Effect.flip);
    expect(missing.message).toContain("No connector is named nothing-here");
  }),
);

it("never sends an agent to setup for a connector setup cannot fix", () => {
  for (const summary of [open, oauth, keyGone, github])
    expect(setupAdvice(summary)).not.toContain("scient_connector_setup");
  const local: ConnectorSummary = {
    ...open,
    local: {
      version: "1.0.0",
      running: 0,
      missing: ["API key"],
      setup: [],
    } as unknown as NonNullable<ConnectorSummary["local"]>,
  };
  expect(setupAdvice(local)).toContain('scient_connector_setup {"connector":"pubmed"}');
});
