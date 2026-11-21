import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { CheckpointRef, CheckpointScopeId, VcsProcessTimeoutError } from "@t3tools/contracts";
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
