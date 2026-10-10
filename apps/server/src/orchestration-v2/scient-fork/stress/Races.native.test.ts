import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import { ThreadId } from "@t3tools/contracts";
import { ServerConfig } from "../../../config.ts";
import { resolveAttachmentPath } from "../../../attachmentStore.ts";
import { ProjectionStoreV2 } from "../../ProjectionStore.ts";
import { fork, remove, run, seed } from "./stressHarness.ts";

it.live.each(["fork-first", "delete-first", "concurrent"] as const)(
  "fork vs deletion: %s",
  (order) =>
    run(
      Effect.gen(function* () {
        const source = yield* seed({ turns: 3, attachments: true });
        const store = yield* ProjectionStoreV2;
        const fs = yield* FileSystem.FileSystem;
        const config = yield* ServerConfig;
        const attachments = source.messages.flatMap((m) => m.attachments);
        const paths = attachments.map((attachment) =>
          resolveAttachmentPath({ attachmentsDir: config.attachmentsDir, attachment })!,
        );
        let accepted = false;
        if (order === "fork-first") {
          yield* fork(source.thread.id, "race-child");
          accepted = true;
          yield* remove(source.thread.id);
        } else if (order === "delete-first") {
          yield* remove(source.thread.id);
          assert.equal((yield* Effect.exit(fork(source.thread.id, "race-child")))._tag, "Failure");
        } else {
          const result = yield* Effect.all(
            [fork(source.thread.id, "race-child").pipe(Effect.exit), remove(source.thread.id)],
            { concurrency: "unbounded" },
          );
          accepted = result[0]._tag === "Success";
        }
        if (accepted) {
          const child = yield* store.getThreadProjection(ThreadId.make("race-child"));
          assert.deepEqual(
            child.messages.map((m) => m.text),
            source.messages.map((m) => m.text),
          );
          for (const path of paths) assert.isTrue(yield* fs.exists(path));
          yield* remove(child.thread.id);
        }
        for (const path of paths) assert.isFalse(yield* fs.exists(path));
      }),
    ),
  120000,
);

it.live(
  "two simultaneous forks get unique sibling names and deleting all but one retains shared files",
  () =>
    run(
      Effect.gen(function* () {
        const source = yield* seed({ turns: 3, attachments: true });
        const forks = yield* Effect.all(
          Array.from({ length: 12 }, (_, index) => fork(source.thread.id, `parallel-${index}`)),
          { concurrency: "unbounded" },
        );
        assert.equal(new Set(forks.map((f) => f.projection.thread.title)).size, forks.length);
        const fs = yield* FileSystem.FileSystem;
        const config = yield* ServerConfig;
        const paths = source.messages
          .flatMap((m) => m.attachments)
          .map((attachment) =>
            resolveAttachmentPath({ attachmentsDir: config.attachmentsDir, attachment })!,
          );
        yield* remove(source.thread.id);
        yield* Effect.all(
          forks.slice(0, -1).map((f) => remove(f.projection.thread.id)),
          { concurrency: "unbounded" },
        );
        for (const path of paths) assert.isTrue(yield* fs.exists(path));
        const store = yield* ProjectionStoreV2;
        assert.deepEqual(
          (yield* store.getThreadProjection(forks.at(-1)!.projection.thread.id)).messages,
          forks.at(-1)!.projection.messages,
        );
        yield* remove(forks.at(-1)!.projection.thread.id);
        for (const path of paths) assert.isFalse(yield* fs.exists(path));
      }),
    ),
  120000,
);

it.live(
  "forking a fork while deleting the parent leaves accepted descendants intact",
  () =>
    run(
      Effect.gen(function* () {
        const source = yield* seed({ turns: 3, attachments: true });
        const parent = (yield* fork(source.thread.id, "parent")).projection;
        yield* remove(source.thread.id);
        const [result] = yield* Effect.all(
          [fork(parent.thread.id, "grandchild").pipe(Effect.exit), remove(parent.thread.id)],
          { concurrency: "unbounded" },
        );
        const fs = yield* FileSystem.FileSystem;
        const config = yield* ServerConfig;
        const paths = source.messages
          .flatMap((m) => m.attachments)
          .map((attachment) =>
            resolveAttachmentPath({ attachmentsDir: config.attachmentsDir, attachment })!,
          );
        if (result._tag === "Success") {
          assert.deepEqual(
            result.value.projection.messages.map((m) => m.text),
            parent.messages.map((m) => m.text),
          );
          for (const path of paths) assert.isTrue(yield* fs.exists(path));
          yield* remove(result.value.projection.thread.id);
        }
        for (const path of paths) assert.isFalse(yield* fs.exists(path));
      }),
    ),
  120000,
);

it.live(
  "all last forks deleted concurrently release files without leaks",
  () =>
    run(
      Effect.gen(function* () {
        const source = yield* seed({ turns: 3, attachments: true });
        const forks = yield* Effect.all(
          Array.from({ length: 12 }, (_, index) => fork(source.thread.id, `last-${index}`)),
          { concurrency: "unbounded" },
        );
        const config = yield* ServerConfig;
        const fs = yield* FileSystem.FileSystem;
        const paths = source.messages
          .flatMap((m) => m.attachments)
          .map((attachment) =>
            resolveAttachmentPath({ attachmentsDir: config.attachmentsDir, attachment })!,
          );
        yield* remove(source.thread.id);
        yield* Effect.all(
          forks.map((f) => remove(f.projection.thread.id)),
          { concurrency: "unbounded" },
        );
        for (const path of paths) assert.isFalse(yield* fs.exists(path));
      }),
    ),
  120000,
);
