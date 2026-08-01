import { assert, it } from "@effect/vitest";
import { Effect, Option } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import type { ProjectionSnapshotQueryShape } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import { makeEphemeralScientOperationExecutor } from "../scientOperations/Layers/ScientOperationExecutor.ts";
import { makeExternalIntegrationControlPlane } from "./controlPlane.ts";
import { ExternalIntegrationControlError, externalIntegrationThreadHash } from "./controlPlane.ts";
import {
  makeExternalIntegrationReadAdapter,
  makeProjectionExternalIntegrationReadBackend,
  verifyLocalPeerProof,
  type ExternalIntegrationReadBackend,
  type ExternalIntegrationReadCall,
} from "./readAdapter.ts";

const sqlite = it.layer(SqlitePersistenceMemory);
const NOW = 1_800_000_000_000;
let trustedNow = NOW;

const establish = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`DELETE FROM scient_external_integrations`;
  trustedNow = NOW;
  const control = yield* makeExternalIntegrationControlPlane({ now: () => trustedNow });
  const created = yield* control.createPending({
    externalIdentity: "integration-1",
    credentialReference: "keychain-ref:integration-1",
    peerIdentity: "unix-uid:501",
    projects: [{ projectId: "project-1", threadIds: ["thread-1"] }],
    capabilities: ["project:context:read", "thread:list", "thread:read"],
    rateLimit: { maxRequests: 20, windowMs: 60_000 },
  });
  trustedNow += 1;
  const paired = yield* control.completePairing({
    externalIdentity: "integration-1",
    pairingToken: created.pairingToken,
    credentialReference: "keychain-ref:integration-1",
    peerIdentity: "unix-uid:501",
  });
  return { control, accessToken: paired.accessToken } as const;
});

const call = {
  externalIdentity: "integration-1",
  credentialReference: "keychain-ref:integration-1",
  peerProof: {
    platform: "darwin" as const,
    kind: "unix-peer-credentials" as const,
    uid: 501,
    socketOwnerUid: 501,
  },
  projectId: "project-1",
};

sqlite("ExternalIntegrationReadAdapter", (it) => {
  it.effect("routes exact scoped reads through the Scient executor", () =>
    Effect.gen(function* () {
      const { control, accessToken } = yield* establish;
      let projectReads = 0;
      const backend: ExternalIntegrationReadBackend = {
        project: (projectId) => {
          projectReads += 1;
          return Effect.succeed({ projectId, title: "Project" });
        },
        listThreads: () => Effect.succeed({ threads: [] }),
        readThread: ({ threadId }) => Effect.succeed({ threadId, messages: [] }),
      };
      const adapter = makeExternalIntegrationReadAdapter({
        controlPlane: control,
        operationExecutor: makeEphemeralScientOperationExecutor({
          now: () => NOW + 2,
          randomId: () => "external-read-1",
        }),
        backend,
      });
      assert.isFalse("listSecurityEvents" in adapter);
      const forgedCallerTime = Number.MAX_SAFE_INTEGER;
      const forgedCall = {
        ...call,
        accessToken,
        // Deliberately smuggled as an excess property: the adapter must ignore
        // transport-owned time even when called from untyped JavaScript.
        now: forgedCallerTime,
        request: { operation: "project.list" },
      } as unknown as ExternalIntegrationReadCall;
      const outcome = yield* adapter.execute(forgedCall);
      assert.strictEqual(outcome.kind, "finished");
      if (outcome.kind === "finished") {
        assert.isNull(outcome.error);
        assert.deepEqual(outcome.result, {
          ok: true,
          value: { projectId: "project-1", title: "Project" },
        });
      }
      assert.strictEqual(projectReads, 1);
      const events = yield* control.listSecurityEvents("integration-1");
      assert.isFalse(events.events.some(({ occurredAt }) => occurredAt === forgedCallerTime));
      assert.isTrue(events.events.every(({ occurredAt }) => occurredAt <= trustedNow));
    }),
  );

  it.effect("withholds an in-flight read when revocation wins before release", () =>
    Effect.gen(function* () {
      const { control, accessToken } = yield* establish;
      const backend: ExternalIntegrationReadBackend = {
        project: () => Effect.succeed({}),
        listThreads: () => Effect.succeed({ threads: [] }),
        readThread: ({ threadId }) =>
          control
            .revoke("integration-1")
            .pipe(
              Effect.as({ threadId, messages: [{ role: "assistant", text: "must not escape" }] }),
            ),
      };
      const adapter = makeExternalIntegrationReadAdapter({
        controlPlane: control,
        operationExecutor: makeEphemeralScientOperationExecutor({
          now: () => NOW + 2,
          randomId: () => "external-read-revoked",
        }),
        backend,
      });
      const outcome = yield* adapter.execute({
        ...call,
        accessToken,
        request: { operation: "thread.read", threadId: "thread-1" },
      });
      assert.strictEqual(outcome.kind, "finished");
      if (outcome.kind === "finished") {
        assert.isNull(outcome.result);
        assert.instanceOf(outcome.error, Error);
        assert.strictEqual(
          outcome.error instanceof ExternalIntegrationControlError
            ? outcome.error.code
            : "unexpected_error",
          "stale_authority",
        );
      }
    }),
  );

  it.effect("production projection shaping returns one project without workspaceRoot", () =>
    Effect.gen(function* () {
      const backend = makeProjectionExternalIntegrationReadBackend(
        {
          getProjectShellById: () =>
            Effect.succeed(
              Option.some({
                id: "project-1",
                title: "Scoped",
                kind: "project",
                isPinned: false,
                workspaceRoot: "/secret/workspace",
              }),
            ),
        } as unknown as ProjectionSnapshotQueryShape,
        {
          readPage: () => Effect.die("not used"),
        },
      );
      const result = yield* backend.project("project-1");
      assert.deepEqual(result, {
        projectId: "project-1",
        title: "Scoped",
        kind: "project",
        isPinned: false,
      });
      assert.notInclude(JSON.stringify(result), "workspaceRoot");
      assert.notInclude(JSON.stringify(result), "/secret/workspace");
    }),
  );

  it.effect("withholds a parent thread that is outside the granted thread set", () =>
    Effect.gen(function* () {
      const snapshot = {
        threads: [
          {
            id: "child-thread",
            projectId: "project-1",
            title: "Child",
            parentThreadId: "parent-thread",
            archivedAt: null,
            updatedAt: "2026-01-01T00:00:00Z",
          },
        ],
      };
      const backend = makeProjectionExternalIntegrationReadBackend(
        {
          getShellSnapshot: () => Effect.succeed(snapshot),
        } as unknown as ProjectionSnapshotQueryShape,
        { readPage: () => Effect.die("not used") },
      );

      const childOnly = (yield* backend.listThreads({
        projectId: "project-1",
        scopedThreadHashes: [externalIntegrationThreadHash("child-thread")],
        includeArchived: false,
        limit: 20,
      })) as { readonly threads: ReadonlyArray<{ readonly parentThreadId: string | null }> };
      assert.strictEqual(childOnly.threads[0]?.parentThreadId, null);

      const parentAndChild = (yield* backend.listThreads({
        projectId: "project-1",
        scopedThreadHashes: [
          externalIntegrationThreadHash("child-thread"),
          externalIntegrationThreadHash("parent-thread"),
        ],
        includeArchived: false,
        limit: 20,
      })) as { readonly threads: ReadonlyArray<{ readonly parentThreadId: string | null }> };
      assert.strictEqual(parentAndChild.threads[0]?.parentThreadId, "parent-thread");
    }),
  );

  it.effect("delegates bounded thread reads and truncates only returned message text", () =>
    Effect.gen(function* () {
      let delegatedMaxMessageChars: number | undefined;
      const backend = makeProjectionExternalIntegrationReadBackend(
        {} as ProjectionSnapshotQueryShape,
        {
          readPage: (input) => {
            delegatedMaxMessageChars = input.maxMessageChars;
            return Effect.succeed({
              threadId: input.threadId,
              projectId: input.projectId,
              title: "Thread",
              status: "idle",
              archived: false,
              messages: [
                {
                  index: 2_104,
                  role: "assistant",
                  text: "abc",
                  truncated: true,
                  createdAt: "now",
                },
              ],
              totalMessages: 2_105,
              nextCursor: "opaque-keyset-cursor",
            });
          },
        },
      );
      const result = (yield* backend.readThread({
        projectId: "project-1",
        threadId: "thread-1",
        cursor: "2105",
        messageLimit: 1,
        maxMessageChars: 3,
      })) as {
        readonly totalMessages: number;
        readonly nextCursor: string | null;
        readonly messages: ReadonlyArray<{
          readonly index: number;
          readonly role: string;
          readonly text: string;
          readonly truncated: boolean;
          readonly createdAt: string;
        }>;
      };
      assert.strictEqual(delegatedMaxMessageChars, 3);
      assert.strictEqual(result.totalMessages, 2_105);
      assert.strictEqual(result.nextCursor, "opaque-keyset-cursor");
      assert.deepEqual(result.messages, [
        {
          index: 2_104,
          role: "assistant",
          text: "abc",
          truncated: true,
          createdAt: "now",
        },
      ]);
    }),
  );
});

it("fails Windows closed without matching local SID and named-pipe ACL", () => {
  assert.throws(() =>
    verifyLocalPeerProof({
      platform: "win32",
      kind: "windows-named-pipe-acl",
      clientSid: "S-1-5-21-client",
      aclOwnerSid: "S-1-5-21-owner",
      rejectsRemoteClients: true,
    }),
  );
  assert.throws(() =>
    verifyLocalPeerProof({
      platform: "win32",
      kind: "windows-named-pipe-acl",
      clientSid: "S-1-5-21-owner",
      aclOwnerSid: "S-1-5-21-owner",
      rejectsRemoteClients: false,
    }),
  );
  assert.strictEqual(
    verifyLocalPeerProof({
      platform: "win32",
      kind: "windows-named-pipe-acl",
      clientSid: "S-1-5-21-owner",
      aclOwnerSid: "S-1-5-21-owner",
      rejectsRemoteClients: true,
    }),
    "windows-sid:S-1-5-21-owner",
  );
});
