import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import { ServerConfig } from "../../../config.ts";
import { resolveAttachmentPath } from "../../../attachmentStore.ts";
import { nativeImportRuntimeTestLayer } from "../../../scient/conversationImport/conversationImport.native-test-harness.ts";
import { seed, fork, remove, inertRegistry, runtimeOptions } from "./stressHarness.ts";

// Files are released after deletions commit, so concurrent last deletions each
// see the other's commit when they decide.
it.live(
  "two concurrent last deletions release shared files",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        let decisions = 0;
        const runtime = nativeImportRuntimeTestLayer(inertRegistry, {
          ...runtimeOptions,
          decorateProjectionStore: (store) => ({
            ...store,
            getReleasableFiles: (threadId) =>
              store.getReleasableFiles(threadId).pipe(
                Effect.tap(() =>
                  Effect.sync(() => {
                    decisions++;
                  }),
                ),
              ),
          }),
        });
        yield* Effect.gen(function* () {
          const source = yield* seed({ turns: 2, attachments: true });
          const a = (yield* fork(source.thread.id, "barrier-a")).projection;
          const b = (yield* fork(source.thread.id, "barrier-b")).projection;
          const config = yield* ServerConfig;
          const fs = yield* FileSystem.FileSystem;
          const paths = source.messages
            .flatMap((m) => m.attachments)
            .map((attachment) =>
              resolveAttachmentPath({ attachmentsDir: config.attachmentsDir, attachment })!,
            );
          yield* remove(source.thread.id);
          for (const path of paths) assert.isTrue(yield* fs.exists(path));
          yield* Effect.all([remove(a.thread.id), remove(b.thread.id)], {
            concurrency: "unbounded",
          });
          assert.isAtLeast(decisions, 3);
          for (const path of paths)
            assert.isFalse(
              yield* fs.exists(path),
              "No live thread remains to release the leaked source file later",
            );
        }).pipe(Effect.provide(runtime));
      }).pipe(Effect.provide(NodeServices.layer), Effect.timeout("15 seconds")),
    ),
  30000,
);
