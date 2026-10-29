// @effect-diagnostics nodeBuiltinImport:off -- Verify credential delivery against temporary real files.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import {
  AccountId,
  EnvironmentId,
  EventId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type AccountSummary,
} from "@t3tools/contracts";
import { it } from "@effect/vitest";
import { expect } from "vite-plus/test";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import {
  ProjectionStoreV2,
  layer as projectionStoreLayer,
} from "../../../orchestration-v2/ProjectionStore.ts";
import { layerMemory as sqlitePersistenceMemory } from "../../../persistence/Sqlite.ts";
import * as Layer from "effect/Layer";
import { AgentInvocationContext } from "../../operations/AgentInvocationContext.ts";
import { AccountsService } from "../AccountsService.ts";
import { accountAgentOperations } from "./AccountAgentService.ts";
import { fakeAccounts } from "./AccountsService.testkit.ts";
import { AccountSessionFiles, makeSessionFiles } from "./sessionFiles.ts";

it.effect(
  "authorizes before secret resolution, refuses hidden credentials, and returns only paths after a recorded private delivery",
  () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("thread-agent-fixture");
      const providerInstanceId = ProviderInstanceId.make("codex");
      const now = DateTime.makeUnsafe(0);
      const projection = yield* ProjectionStoreV2;
      yield* projection.apply({
        id: EventId.make("event-agent-fixture"),
        type: "thread.created",
        threadId,
        occurredAt: now,
        payload: {
          id: threadId,
          projectId: ProjectId.make("project-fixture"),
          createdBy: "user",
          creationSource: "web",
          title: "Fixture",
          providerInstanceId,
          modelSelection: { instanceId: providerInstanceId, model: "fixture" },
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          activeProviderThreadId: null,
          lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
          forkedFrom: null,
          createdAt: now,
          updatedAt: now,
          archivedAt: null,
          settledOverride: null,
          settledAt: null,
          lastVisitedAt: null,
          deletedAt: null,
        },
      });
      const account: AccountSummary = {
        accountId: AccountId.make("acc_fixture1"),
        name: "Fixture",
        details: {
          kind: "api-key",
          sites: ["example.com"],
          auth: { type: "bearer" },
          envName: "FIXTURE_TOKEN",
        },
        secrets: { token: { source: { type: "scient" } } },
        controls: {
          access: "allowed",
          permission: "full",
          visibility: "readable",
          scope: { type: "all-projects" },
        },
        status: "ready",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      };
      const root = yield* Effect.promise(() =>
        NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "account-delivery-")),
      );
      try {
        const files = yield* makeSessionFiles(root);
        const invocation = {
          environmentId: EnvironmentId.make("env-fixture"),
          threadId,
          providerSessionId: "session-fixture",
          providerInstanceId,
          capabilities: new Set(["accounts" as const]),
          issuedAt: 0,
        };
        const run = (fake: ReturnType<typeof fakeAccounts>) =>
          accountAgentOperations
            .scient_account_credentials({ accountId: account.accountId })
            .pipe(
              Effect.provideService(AccountsService, fake.service),
              Effect.provideService(AccountSessionFiles, files),
              Effect.provideService(AgentInvocationContext, invocation),
            );
        const denied = fakeAccounts({
          accounts: [account],
          denied: true,
          values: { token: "synthetic-token" },
        });
        expect((yield* Effect.flip(run(denied))).reason).toBe("denied");
        expect(denied.calls).not.toContain("resolve");
        const hidden = fakeAccounts({
          accounts: [{ ...account, controls: { ...account.controls, visibility: "hidden" } }],
          values: { token: "synthetic-token" },
        });
        expect((yield* Effect.flip(run(hidden))).message).toContain("make it readable");
        expect(hidden.calls).not.toContain("resolve");
        expect(hidden.uses[0]?.outcome).toBe("error");
        const allowed = fakeAccounts({ accounts: [account], values: { token: "synthetic-token" } });
        const result = yield* run(allowed);
        expect(allowed.calls).toEqual(["authorize:account:credentials", "resolve"]);
        expect(allowed.uses[0]).toMatchObject({ action: "credentials", outcome: "ok", threadId });
        expect(result.usage).not.toContain("synthetic-token");
        expect(yield* Effect.promise(() => NodeFSP.readFile(result.paths[0]!, "utf8"))).toContain(
          "synthetic-token",
        );
      } finally {
        yield* Effect.promise(() => NodeFSP.rm(root, { recursive: true, force: true }));
      }
    }).pipe(Effect.provide(projectionStoreLayer.pipe(Layer.provide(sqlitePersistenceMemory)))),
);
