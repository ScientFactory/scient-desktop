import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { prepareTaskFolderForRewind } from "./TaskFolderRewind.ts";

class SiblingUnrestorable {
  readonly _tag = "SiblingUnrestorable";
}
class Shared {
  readonly _tag = "Shared";
}

const prepare = Effect.fnUntraced(function* (input: {
  readonly restoreFiles: boolean;
  readonly isolated: boolean;
  /** Whether the folder the provider works in is there before the rewind. */
  readonly present: boolean;
  /** Whether restoring puts that folder back before a sibling fails. */
  readonly restoresIt: boolean;
}) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "scient-task-rewind-" });
  const workingDirectory = path.join(root, "project");
  if (input.present) yield* fileSystem.makeDirectory(workingDirectory);
  let restored = 0;
  const result = yield* Effect.result(
    prepareTaskFolderForRewind({
      restore: Effect.gen(function* () {
        restored += 1;
        if (input.restoresIt) {
          yield* fileSystem.makeDirectory(workingDirectory, { recursive: true }).pipe(Effect.orDie);
        }
        return yield* Effect.fail(new SiblingUnrestorable());
      }),
      restoreFiles: input.restoreFiles,
      workingDirectory,
      isolated: Effect.succeed(input.isolated),
      shared: () => new Shared(),
      fileSystem,
    }),
  );
  return { failure: result._tag === "Failure" ? result.failure._tag : null, restored };
});

it.layer(NodeServices.layer)("prepareTaskFolderForRewind", (it) => {
  it.effect("a file rewind refuses a shared task folder before restoring anything", () =>
    Effect.gen(function* () {
      const { failure, restored } = yield* prepare({
        restoreFiles: true,
        isolated: false,
        present: false,
        restoresIt: true,
      });
      assert.equal(failure, "Shared");
      assert.equal(restored, 0);
    }).pipe(Effect.scoped),
  );

  it.effect("a file rewind is blocked by any checkout it cannot put back", () =>
    Effect.gen(function* () {
      const { failure, restored } = yield* prepare({
        restoreFiles: true,
        isolated: true,
        present: true,
        restoresIt: true,
      });
      assert.equal(failure, "SiblingUnrestorable");
      assert.equal(restored, 1);
    }).pipe(Effect.scoped),
  );

  it.effect(
    "a conversation-only rewind leaves the folder alone while its provider's is there",
    () =>
      Effect.gen(function* () {
        const { failure, restored } = yield* prepare({
          restoreFiles: false,
          isolated: false,
          present: true,
          restoresIt: false,
        });
        assert.equal(failure, null);
        assert.equal(restored, 0);
      }).pipe(Effect.scoped),
  );

  it.effect(
    "a conversation-only rewind that rebuilds its provider's folder stops on any failure",
    () =>
      Effect.gen(function* () {
        const { failure, restored } = yield* prepare({
          restoreFiles: false,
          isolated: false,
          present: false,
          restoresIt: true,
        });
        assert.equal(failure, "SiblingUnrestorable");
        assert.equal(restored, 1);
      }).pipe(Effect.scoped),
  );

  it.effect("a conversation-only rewind is blocked while its provider's folder is still gone", () =>
    Effect.gen(function* () {
      const { failure, restored } = yield* prepare({
        restoreFiles: false,
        isolated: false,
        present: false,
        restoresIt: false,
      });
      assert.equal(failure, "SiblingUnrestorable");
      assert.equal(restored, 1);
    }).pipe(Effect.scoped),
  );
});
