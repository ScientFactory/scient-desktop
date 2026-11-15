import {
  type ConnectorAuthSummary,
  ConnectorId,
  type ConnectorSummary,
  type OrchestratorMcpRequestSecretInput,
  ProjectId,
  ProviderInstanceId,
  SecretRef,
  ThreadId,
} from "@t3tools/contracts";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";
import { expect } from "vite-plus/test";

import { McpInvocationContext } from "../../../mcp/McpInvocationContext.ts";
import { ProjectionStoreV2 } from "../../../orchestration-v2/ProjectionStore.ts";
import { OrchestratorMcpService } from "../../../mcp/OrchestratorMcpService.ts";
import { SecretRequests } from "../../../secrets/SecretRequests.ts";
import { ConnectorRuntime } from "../../extensions/ExtensionsServices.ts";
import { setupAdvice } from "../../extensions/connectors/agentStatus.ts";
import { AgentInvocationContext } from "../../operations/AgentInvocationContext.ts";
import { ProviderRegistry } from "../../../provider/ProviderRegistry.ts";
import { fakeAccounts } from "../Accounts.testkit.ts";
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

const keyField = (key: string, title: string) => ({
  field: {
    key,
    type: "string" as const,
    title,
    required: true,
    sensitive: true,
    multiple: false,
  },
});

/** A local connector with two required keys, set up by Antigravity, whose call ends at 180 s. */
const setUpTwoKeys = (
  answers: ReadonlyArray<{ readonly afterMs?: number; readonly saved: boolean }>,
) => {
  const cards: Array<OrchestratorMcpRequestSecretInput> = [];
  const local: ConnectorSummary = {
    ...open,
    serverName: "twokeys",
    displayName: "Two Keys",
    local: {
      kind: "bundle",
      directory: "/connectors/twokeys",
      setup: [keyField("first", "First key"), keyField("second", "Second key")],
      missing: ["First key", "Second key"],
      running: 0,
    } as unknown as NonNullable<ConnectorSummary["local"]>,
  };
  const antigravity = ProviderInstanceId.make("antigravity");
  const threadId = ThreadId.make("thread-1");
  return setUpConnector({ connector: "twokeys" }).pipe(
    Effect.provide(
      Layer.mergeAll(
        Layer.succeed(AccountsService)(fakeAccounts().service),
        Layer.mock(OrchestratorMcpService)({
          requestSecret: (_scope: unknown, card: OrchestratorMcpRequestSecretInput) => {
            const answer = answers[cards.length];
            cards.push(card);
            // The person answers after `afterMs`, or the card waits its whole time.
            return TestClock.adjust(answer?.afterMs ?? card.timeoutMs ?? 0).pipe(
              Effect.as(
                answer?.saved === true
                  ? {
                      status: "saved" as const,
                      secretRef: SecretRef.make(`secret-ref:${"a".repeat(32)}`),
                    }
                  : { status: "timed_out" as const },
              ),
            );
          },
        } as never),
        Layer.mock(SecretRequests)({
          consume: () => Effect.succeed("sk-synthetic-value-0001"),
        } as never),
        Layer.succeed(McpInvocationContext)({
          thread: { threadId, providerSessionId: "s", providerInstanceId: antigravity },
        } as never),
        Layer.mock(ProjectionStoreV2)({
          getThreadRecords: () =>
            Effect.succeed({
              thread: { projectId: ProjectId.make("project-1") },
              runs: [{ id: "run-1", ordinal: 1, status: "running", userMessageId: "m-1" }],
              messages: [{ id: "m-1" }],
            }),
        } as never),
        Layer.mock(ProviderRegistry)({
          getProviders: Effect.succeed([{ instanceId: antigravity, driver: "antigravity" }]),
        } as never),
        Layer.mock(ConnectorRuntime)({
          list: () =>
            Effect.succeed({ revision: 0, connectors: [local], diagnostics: [] } as never),
          update: () => Effect.succeed({} as never),
        }),
        Layer.succeed(AgentInvocationContext)({
          providerInstanceId: antigravity,
          threadId,
        } as AgentInvocationContext["Service"]),
      ),
    ),
    Effect.map((result) => ({ result, cards })),
  );
};

it.effect("gives the cards of one setup call one deadline, inside Antigravity's 180 s", () =>
  Effect.gen(function* () {
    // regression: each card got the full 150 s, so a first key saved after 100 s left a second
    // card open past the 180 s at which Antigravity drops the call.
    const slow = yield* setUpTwoKeys([{ afterMs: 100_000, saved: true }, { saved: false }]);
    expect(slow.cards).toHaveLength(2);
    expect(100_000 + (slow.cards[1]?.timeoutMs ?? Infinity)).toBeLessThan(150_000);
    expect(slow.result.missing).toEqual([expect.stringMatching(/^Second key: .*ran out/)]);

    // A card that got no answer spends the call's time: the next key gets no card.
    const unanswered = yield* setUpTwoKeys([{ saved: false }]);
    expect(unanswered.cards).toHaveLength(1);
    expect(unanswered.cards[0]?.timeoutMs).toBeLessThan(150_000);
    expect(unanswered.result.missing).toEqual([
      expect.stringMatching(/^First key: .*ran out/),
      expect.stringMatching(/^Second key: .*ran out/),
    ]);
  }),
);
