import * as NodeCrypto from "node:crypto";

import { describe, expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";

import { WorkspaceEntries } from "../../workspace/WorkspaceEntries.ts";
import { ManagedTree } from "./ManagedTree.ts";
import type { PersistedOverleafConnection, PersistedOverleafOperation } from "./model.ts";
import { OverleafMirror } from "./OverleafMirror.ts";
import { OverleafStateStore } from "./OverleafStateStore.ts";
import { make } from "./OverleafSyncService.ts";
import { WorkspaceProjector } from "./WorkspaceProjector.ts";

function operationFixture(
  phase: PersistedOverleafOperation["snapshot"]["phase"],
  context: PersistedOverleafOperation["context"] = {},
): PersistedOverleafOperation {
  return {
    snapshot: {
      operationId: NodeCrypto.randomUUID(),
      generation: 1,
      kind: "sync",
      connectStage: null,
      connectionId: NodeCrypto.randomUUID(),
      phase,
      startedAtEpochMs: 1,
      updatedAtEpochMs: 1,
      message: "test",
      review: null,
      conflicts: [],
      errorCode: null,
      retryable: false,
    },
    context,
  };
}

function connectionFixture(connectionId: string): PersistedOverleafConnection {
  return {
    connectionId,
    accountId: NodeCrypto.randomUUID(),
    label: "Paper",
    workspaceRoot: process.cwd(),
    relativeFolder: "",
    projectUrl: "https://www.overleaf.com/project/0123456789abcdef01234567",
    gitUrl: "https://git.overleaf.com/0123456789abcdef01234567",
    host: "git.overleaf.com",
    branch: "master",
    commitPolicy: { kind: "neutral" },
    suppressRenameWarning: false,
    state: "repair_required",
    remoteBaselineCommit: "0123456789abcdef0123456789abcdef01234567",
    lastConvergedCommit: null,
    localAhead: false,
    localOnlyCompanions: [],
    lastSyncedAtEpochMs: null,
    workspaceBaselineManifest: { files: [], totalBytes: 0 },
    pendingRemoteCommit: null,
    activeOperationId: null,
  };
}

function serviceWith(input: {
  readonly operation: PersistedOverleafOperation;
  readonly connection?: PersistedOverleafConnection;
  readonly onRemoveOperation?: () => void;
}) {
  const state = OverleafStateStore.of({
    getOperation: () => Effect.succeed(input.operation),
    getConnection: () =>
      input.connection === undefined
        ? Effect.die("unexpected connection read")
        : Effect.succeed(input.connection),
    removeOperation: () =>
      Effect.sync(() => {
        input.onRemoveOperation?.();
      }),
    overview: () => Effect.die("unexpected overview"),
    operationDirectory: () => process.cwd(),
    connectionDirectory: () => process.cwd(),
  } as unknown as OverleafStateStore["Service"]);
  return make().pipe(
    Effect.provideService(OverleafStateStore, state),
    Effect.provideService(OverleafMirror, OverleafMirror.of({} as OverleafMirror["Service"])),
    Effect.provideService(ManagedTree, ManagedTree.of({} as ManagedTree["Service"])),
    Effect.provideService(
      WorkspaceProjector,
      WorkspaceProjector.of({} as WorkspaceProjector["Service"]),
    ),
    Effect.provideService(
      WorkspaceEntries,
      WorkspaceEntries.of({
        refresh: () => Effect.void,
      } as unknown as WorkspaceEntries["Service"]),
    ),
  );
}

describe("OverleafSyncService state guards", () => {
  it.effect("does not continue a terminal operation as a rebase", () =>
    Effect.gen(function* () {
      const operation = operationFixture("succeeded");
      const service = yield* serviceWith({ operation });
      const failure = yield* service
        .continueOperation({ operationId: operation.snapshot.operationId })
        .pipe(Effect.flip);
      expect(failure).toMatchObject({ code: "invalid_request" });
    }),
  );

  it.effect("blocks Sync while the connection requires repair", () =>
    Effect.gen(function* () {
      const operation = operationFixture("failed");
      const connection = connectionFixture(operation.snapshot.connectionId!);
      const service = yield* serviceWith({ operation, connection });
      const failure = yield* service
        .startSync({ connectionId: connection.connectionId })
        .pipe(Effect.flip);
      expect(failure).toMatchObject({ code: "operation_active" });
    }),
  );

  it.effect("reports corrupt uncertain-push identity instead of dereferencing missing fields", () =>
    Effect.gen(function* () {
      const operation = operationFixture("push_outcome_unknown");
      const connection = {
        ...connectionFixture(operation.snapshot.connectionId!),
        state: "push_outcome_unknown" as const,
        pendingRemoteCommit: "0123456789abcdef0123456789abcdef01234567",
        activeOperationId: operation.snapshot.operationId,
      };
      const service = yield* serviceWith({ operation, connection });
      const failure = yield* service
        .retryOperation(operation.snapshot.operationId)
        .pipe(Effect.flip);
      expect(failure).toMatchObject({ code: "corrupt_state" });
    }),
  );

  it.effect("keeps operation status reads free of cleanup mutations", () =>
    Effect.gen(function* () {
      let removed = false;
      const operation = {
        ...operationFixture("succeeded"),
        snapshot: { ...operationFixture("succeeded").snapshot, kind: "disconnect" as const },
      };
      const service = yield* serviceWith({
        operation,
        onRemoveOperation: () => {
          removed = true;
        },
      });
      expect((yield* service.operationStatus(operation.snapshot.operationId)).phase).toBe(
        "succeeded",
      );
      expect(removed).toBe(false);
    }),
  );

  it.effect("rejects cancellation after an operation is terminal", () =>
    Effect.gen(function* () {
      const operation = operationFixture("cancelled");
      const service = yield* serviceWith({ operation });
      const failure = yield* service
        .cancelOperation(operation.snapshot.operationId)
        .pipe(Effect.flip);
      expect(failure).toMatchObject({ code: "invalid_request" });
    }),
  );

  it.effect("persists the canonical fetched head after a confirmed push rewrites the commit", () =>
    Effect.gen(function* () {
      const candidateCommit = "1111111111111111111111111111111111111111";
      const candidateTree = "2222222222222222222222222222222222222222";
      const prePushBase = "3333333333333333333333333333333333333333";
      const canonicalHead = "4444444444444444444444444444444444444444";
      const finished = yield* Deferred.make<void>();
      let operation = operationFixture("awaiting_push_confirmation", {
        clickManifest: { files: [], totalBytes: 0 },
        remoteManifest: { files: [], totalBytes: 0 },
        candidateCommit,
        candidateTree,
        prePushBase,
        review: {
          candidateCommit,
          changes: [{ kind: "deleted", path: "old.tex" }],
          warnings: [
            {
              kind: "deletion",
              message: "delete",
              paths: ["old.tex"],
              blocking: true,
              suppressible: false,
            },
          ],
          requiresConfirmation: true,
        },
      });
      operation = {
        ...operation,
        snapshot: {
          ...operation.snapshot,
          review: operation.context.review!,
          errorCode: "review_required",
        },
      };
      let connection: PersistedOverleafConnection = {
        ...connectionFixture(operation.snapshot.connectionId!),
        state: "operation_active" as const,
        activeOperationId: operation.snapshot.operationId,
      };
      const account = {
        accountId: connection.accountId,
        label: "Overleaf",
        kind: "cloud" as const,
        host: "git.overleaf.com",
        authorName: "Human Author",
        authorEmail: "human@example.com",
        credentialStatus: "saved" as const,
        createdAtEpochMs: 1,
        updatedAtEpochMs: 1,
        lastValidatedAtEpochMs: null,
        secretRef: "secret",
      };
      let verified = false;
      const state = OverleafStateStore.of({
        getOperation: () => Effect.succeed(operation),
        updateOperation: (
          _operationId: string,
          update: (current: PersistedOverleafOperation) => PersistedOverleafOperation,
        ) =>
          Effect.gen(function* () {
            operation = update(operation);
            if (operation.snapshot.phase === "succeeded")
              yield* Deferred.succeed(finished, undefined);
            return operation;
          }),
        getConnection: () => Effect.succeed(connection),
        saveConnection: (next: PersistedOverleafConnection) =>
          Effect.sync(() => {
            connection = next;
          }),
        accountWithToken: () =>
          Effect.succeed({ account, token: new TextEncoder().encode("token") }),
        operationDirectory: () => process.cwd(),
        connectionDirectory: () => process.cwd(),
        overview: () => Effect.die("unexpected overview"),
      } as unknown as OverleafStateStore["Service"]);
      const mirror = OverleafMirror.of({
        mirrorRoot: () => process.cwd(),
        treeHash: () => Effect.succeed(candidateTree),
        push: () => Effect.succeed("confirmed" as const),
        candidateAccepted: () =>
          Effect.sync(() => {
            verified = true;
            return { accepted: true, head: canonicalHead };
          }),
        manifest: () => Effect.succeed({ files: [], totalBytes: 0 }),
        releaseOperationRef: () => Effect.void,
      } as unknown as OverleafMirror["Service"]);
      const service = yield* make().pipe(
        Effect.provideService(OverleafStateStore, state),
        Effect.provideService(OverleafMirror, mirror),
        Effect.provideService(
          ManagedTree,
          ManagedTree.of({
            scan: () => Effect.succeed({ files: [], totalBytes: 0 }),
          } as unknown as ManagedTree["Service"]),
        ),
        Effect.provideService(
          WorkspaceProjector,
          WorkspaceProjector.of({} as WorkspaceProjector["Service"]),
        ),
        Effect.provideService(
          WorkspaceEntries,
          WorkspaceEntries.of({
            refresh: () => Effect.void,
          } as unknown as WorkspaceEntries["Service"]),
        ),
      );
      yield* service.confirmReview({
        operationId: operation.snapshot.operationId,
        generation: operation.snapshot.generation,
        candidateCommit,
        acknowledgeWarnings: true,
        suppressFutureRenameWarnings: false,
      });
      yield* Deferred.await(finished);
      expect(verified).toBe(true);
      expect(operation.snapshot.phase).toBe("succeeded");
      expect(connection.remoteBaselineCommit).toBe(canonicalHead);
      expect(connection.lastConvergedCommit).toBe(canonicalHead);
    }),
  );
});
