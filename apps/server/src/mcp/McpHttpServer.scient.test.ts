import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  AccountId,
  EnvironmentId,
  ProviderInstanceId,
  ThreadId,
  type PreviewAutomationStatus,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import { McpSchema, McpServer } from "effect/ai";

import * as ServerConfig from "../config.ts";
import { ProjectionStoreV2 } from "../orchestration-v2/ProjectionStore.ts";
import { makeHarness } from "../scient/accounts/Accounts.testkit.ts";
import { AccountsService } from "../scient/accounts/AccountsService.ts";
import { WorkspaceBindingResolver } from "../scient/projectScope/WorkspaceBindingResolver.ts";
import { workspaceResolverForTest } from "../scient/projectScope/WorkspaceBindingTestUtils.ts";
import * as McpHttpServer from "./McpHttpServer.ts";
import * as McpInvocationContext from "./McpInvocationContext.ts";
import * as McpToolAccessTestkit from "./McpToolAccess.testkit.ts";
import * as PreviewAutomationBroker from "./PreviewAutomationBroker.ts";

const environmentId = EnvironmentId.make("environment-signing-test");
const threadId = ThreadId.make("thread-signing-test");
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

it.effect("a snapshot of a tab the user signs in on says why it is refused", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { service } = yield* makeHarness();
      yield* service.setAttempt({
        attemptId: "attempt-1",
        threadId,
        tabId: "sign-in-tab",
        accountId: AccountId.make("acc_signing_fixture"),
        state: "person",
      });
      const status: PreviewAutomationStatus = {
        available: true,
        visible: true,
        tabId: "sign-in-tab",
        url: "https://example.com/login",
        title: "Sign in",
        loading: false,
        profiles: [{ id: "default", name: "Main" }],
        tabs: [{ tabId: "sign-in-tab", url: "https://example.com/login", profileId: "default" }],
      };
      const result = yield* Effect.gen(function* () {
        const broker = yield* PreviewAutomationBroker.PreviewAutomationBroker;
        const connected = yield* Deferred.make<void>();
        const events = yield* broker.connect({ clientId: "signing-client", environmentId });
        yield* Stream.runForEach(events, (event) =>
          event.type === "connected"
            ? Deferred.succeed(connected, undefined)
            : broker.respond({
                clientId: "signing-client",
                connectionId: event.connectionId,
                requestId: event.request.requestId,
                ok: true,
                result: status,
              }),
        ).pipe(Effect.forkScoped);
        yield* Deferred.await(connected);
        const server = yield* McpServer.McpServer;
        return yield* server.callTool({ name: "preview_snapshot", arguments: {} }).pipe(
          Effect.provideService(McpInvocationContext.McpInvocationContext, {
            environmentId,
            requestNamespace: "signing-test",
            thread: {
              threadId,
              providerSessionId: "signing-test",
              providerInstanceId: ProviderInstanceId.make("codex"),
            },
            client: undefined,
            capabilities: new Set(["preview"] as const),
            issuedAt: 1,
          }),
          Effect.provideService(McpSchema.McpServerClient, client),
        );
      }).pipe(
        Effect.provide(
          McpHttpServer.layerPreviewToolkit.pipe(
            Layer.provide(
              Layer.succeed(WorkspaceBindingResolver, workspaceResolverForTest(new Map())),
            ),
            Layer.provideMerge(McpHttpServer.layerInProcessMcpServer),
            Layer.provideMerge(McpToolAccessTestkit.liveThreadsLayer),
            Layer.provideMerge(PreviewAutomationBroker.layer),
            Layer.provideMerge(Layer.succeed(AccountsService, service)),
            Layer.provideMerge(
              Layer.mock(ProjectionStoreV2)({
                getThreadRecords: () =>
                  Effect.succeed(
                    McpToolAccessTestkit.idleThreadProjection(
                      McpToolAccessTestkit.liveThreadShell(threadId),
                    ),
                  ),
              }),
            ),
            Layer.provideMerge(
              ServerConfig.layerTest(process.cwd(), { prefix: "t3-mcp-signing-test-" }),
            ),
            Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
          ),
        ),
      );
      const message = "The user is signing in on this tab. Wait for scient_account_sign_in.";
      expect(result.isError).toBe(true);
      expect(result.content).toEqual([
        { type: "text", text: `Preview snapshot failed: ${message}` },
      ]);
    }),
  ),
);
