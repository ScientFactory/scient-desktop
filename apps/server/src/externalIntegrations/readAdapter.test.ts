import { assert, it } from "@effect/vitest";
import { Effect, Option } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import type { ProjectionSnapshotQueryShape } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import { makeEphemeralScientOperationExecutor } from "../scientOperations/Layers/ScientOperationExecutor.ts";
import { makeExternalIntegrationControlPlane } from "./controlPlane.ts";
import { ExternalIntegrationControlError } from "./controlPlane.ts";
import {
  makeExternalIntegrationReadAdapter,
  makeProjectionExternalIntegrationReadBackend,
  verifyLocalPeerProof,
  type ExternalIntegrationReadBackend,
} from "./readAdapter.ts";

const sqlite = it.layer(SqlitePersistenceMemory);
const NOW = 1_800_000_000_000;

const establish = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`DELETE FROM scient_external_integrations`;
  const control = yield* makeExternalIntegrationControlPlane;
  const created = yield* control.createPending({
    externalIdentity: "integration-1",
    credentialReference: "keychain-ref:integration-1",
    peerIdentity: "unix-uid:501",
    projects: [{ projectId: "project-1", threadIds: ["thread-1"] }],
    capabilities: ["project:context:read", "thread:list", "thread:read"],
    rateLimit: { maxRequests: 20, windowMs: 60_000 },
    now: NOW,
  });
  yield* control.completePairing({
    externalIdentity: "integration-1",
    pairingToken: created.pairingToken,
    credentialReference: "keychain-ref:integration-1",
    peerIdentity: "unix-uid:501",
    now: NOW + 1,
  });
  return control;
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
  now: NOW + 2,
};

sqlite("ExternalIntegrationReadAdapter", (it) => {
  it.effect("routes exact scoped reads through the Scient executor", () =>
    Effect.gen(function* () {
      const control = yield* establish;
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
      const outcome = yield* adapter.execute({
        ...call,
        request: { operation: "project.list" },
      });
      assert.strictEqual(outcome.kind, "finished");
      if (outcome.kind === "finished") {
        assert.isNull(outcome.error);
        assert.deepEqual(outcome.result, {
          ok: true,
          value: { projectId: "project-1", title: "Project" },
        });
      }
      assert.strictEqual(projectReads, 1);
    }),
  );

  it.effect("withholds an in-flight read when revocation wins before release", () =>
    Effect.gen(function* () {
      const control = yield* establish;
      const backend: ExternalIntegrationReadBackend = {
        project: () => Effect.succeed({}),
        listThreads: () => Effect.succeed({ threads: [] }),
        readThread: ({ threadId }) =>
          control
            .revoke("integration-1", NOW + 3)
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
      const backend = makeProjectionExternalIntegrationReadBackend({
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
      } as unknown as ProjectionSnapshotQueryShape);
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
