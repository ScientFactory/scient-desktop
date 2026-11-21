import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  CheckpointRef,
  CheckpointScopeId,
  NodeId,
  type OrchestrationV2CheckpointScope,
  ProviderThreadId,
  RunId,
  ThreadId,
  VcsProcessExitError,
  VcsProcessTimeoutError,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as CheckpointStore from "../checkpointing/CheckpointStore.ts";
import * as CheckpointService from "./CheckpointService.ts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as WorkspaceFolders from "../workspace/WorkspaceFolders.ts";

it.effect(
  "a retried rewind puts a folder back as the user left it, not as an older attempt",
  () => {
    const targets = ["first", "second"].map((name) => ({
      scope: { id: CheckpointScopeId.make(`checkpoint-scope:retry:${name}`), cwd: `/repo/${name}` },
      checkpoint: {
        ordinalWithinScope: 1,
        ref: CheckpointRef.make(`refs/scient/test/retry/${name}`),
        status: "ready" as const,
      },
    }));
    const failure = new VcsProcessTimeoutError({
      operation: "test.restore",
      command: "git",
      cwd: "/repo",
      timeoutMs: 30000,
    });
    // Each folder's files, and each snapshot of them, as one string.
    const folders = new Map([
      ["/repo/first", "first before"],
      ["/repo/second", "second before"],
    ]);
    const refs = new Map(
      targets.map((target) => [
        `${target.scope.cwd} ${target.checkpoint.ref}`,
        `${target.scope.cwd} target`,
      ]),
    );
    const isTarget = (ref: string) => targets.some((target) => target.checkpoint.ref === ref);
    // The second folder's rewind always fails; the first time, so does putting the first one back.
    let firstPutBackFails = true;
    const layerTest = CheckpointService.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          IdAllocator.layer,
          NodeServices.layer,
          Layer.mock(WorkspaceFolders.WorkspaceFolders)({
            forThread: () => Effect.succeed({ folders: [], extraRoots: [] }),
            submodules: () => Effect.succeed([]),
          }),
          Layer.mock(CheckpointStore.CheckpointStore)({
            hasCheckpointRef: (input) =>
              Effect.sync(() => refs.has(`${input.cwd} ${input.checkpointRef}`)),
            captureCheckpoint: (input) =>
              Effect.sync(() => {
                refs.set(`${input.cwd} ${input.checkpointRef}`, folders.get(input.cwd)!);
              }),
            restoreCheckpoint: (input) => {
              if (input.cwd === "/repo/second" && isTarget(input.checkpointRef)) {
                return Effect.fail(failure);
              }
              if (
                input.cwd === "/repo/first" &&
                !isTarget(input.checkpointRef) &&
                firstPutBackFails
              ) {
                return Effect.fail(failure);
              }
              return Effect.sync(() => {
                const files = refs.get(`${input.cwd} ${input.checkpointRef}`);
                if (files === undefined) return false;
                folders.set(input.cwd, files);
                return true;
              });
            },
            deleteCheckpointRefs: (input) =>
              Effect.sync(() => {
                for (const ref of input.checkpointRefs) refs.delete(`${input.cwd} ${ref}`);
              }),
          }),
        ),
      ),
      Layer.provideMerge(NodeCrypto.layer),
    );
    const kept = () =>
      [...refs].filter(([key]) => key.startsWith("/repo/first ") && !isTarget(key.split(" ")[1]!));
    return Effect.gen(function* () {
      const checkpoints = yield* CheckpointService.CheckpointServiceV2;
      const rewind = checkpoints.restore({
        targets,
        scopes: targets.map((target) => target.scope),
      });

      assert.strictEqual((yield* Effect.result(rewind))._tag, "Failure");
      // The first folder was left rewound, with its snapshot kept.
      assert.strictEqual(folders.get("/repo/first"), "/repo/first target");
      assert.deepEqual(
        kept().map(([, files]) => files),
        ["first before"],
      );

      // The user edits the first folder, then tries again; this time it can be put back.
      folders.set("/repo/first", "first edited");
      firstPutBackFails = false;
      assert.strictEqual((yield* Effect.result(rewind))._tag, "Failure");

      assert.strictEqual(folders.get("/repo/first"), "first edited");
      assert.strictEqual(folders.get("/repo/second"), "second before");
      // The earlier attempt's snapshot is still the only copy of how the folder was before it.
      assert.deepEqual(
        kept().map(([, files]) => files),
        ["first before"],
      );
    }).pipe(Effect.provide(layerTest));
  },
);

it.effect(
  "a run snapshot whose diff failed or had no earlier snapshot leaves its changes unknown",
  () => {
    const scope: OrchestrationV2CheckpointScope = {
      id: CheckpointScopeId.make("checkpoint-scope:changes-known"),
      threadId: ThreadId.make("thread:changes-known"),
      runId: RunId.make("run:changes-known:1"),
      nodeId: NodeId.make("node:changes-known:1"),
      parentScopeId: null,
      providerThreadId: ProviderThreadId.make("provider-thread:changes-known"),
      kind: "root_run",
      ordinalWithinParent: 0,
      advancesAppRunCount: true,
      cwd: "/repo/changes-known",
      createdAt: DateTime.makeUnsafe("2026-11-21T00:00:00.000Z"),
    };
    const captureWith = (store: {
      readonly previousExists: boolean;
      readonly diff: "fails" | "empty";
    }) =>
      Effect.gen(function* () {
        const checkpoints = yield* CheckpointService.CheckpointServiceV2;
        return yield* checkpoints.capture({
          scope,
          runId: scope.runId!,
          nodeId: scope.nodeId!,
          ordinalWithinScope: 1,
          appRunOrdinal: 1,
          capturedAt: scope.createdAt,
        });
      }).pipe(
        Effect.provide(
          CheckpointService.layer.pipe(
            Layer.provide(
              Layer.mergeAll(
                IdAllocator.layer,
                NodeServices.layer,
                Layer.mock(WorkspaceFolders.WorkspaceFolders)({
                  forThread: () => Effect.succeed({ folders: [], extraRoots: [] }),
                  submodules: () => Effect.succeed([]),
                }),
                Layer.mock(CheckpointStore.CheckpointStore)({
                  isGitRepository: () => Effect.succeed(true),
                  captureCheckpoint: () => Effect.void,
                  hasCheckpointRef: () => Effect.succeed(store.previousExists),
                  diffCheckpoints: ({ cwd }) =>
                    store.diff === "empty"
                      ? Effect.succeed("")
                      : Effect.fail(
                          new VcsProcessExitError({
                            operation: "test.diff",
                            command: "git",
                            cwd,
                            exitCode: 128,
                            detail: "fatal: unable to read tree",
                          }),
                        ),
                  listAuthoredPaths: () => Effect.succeed(null),
                }),
              ),
            ),
            Layer.provideMerge(NodeCrypto.layer),
          ),
        ),
      );
    return Effect.gen(function* () {
      const compared = yield* captureWith({ previousExists: true, diff: "empty" });
      const diffFailed = yield* captureWith({ previousExists: true, diff: "fails" });
      const nothingToCompare = yield* captureWith({ previousExists: false, diff: "empty" });

      // All three look the same by their file lists; only the first was compared.
      for (const checkpoint of [compared, diffFailed, nothingToCompare]) {
        assert.strictEqual(checkpoint.status, "ready");
        assert.deepEqual(checkpoint.files, []);
      }
      assert.strictEqual(compared.changesKnown, true);
      assert.strictEqual(diffFailed.changesKnown, undefined);
      assert.strictEqual(nothingToCompare.changesKnown, undefined);
    });
  },
);
