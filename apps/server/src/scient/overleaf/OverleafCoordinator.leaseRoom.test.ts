// @effect-diagnostics nodeBuiltinImport:off -- Real folders, Git and native publication.
/** A sync or restore that could not finish its writes is refused before anything is
 * written, never stopped part way through. */
import * as HostProcess from "@t3tools/shared/HostProcess";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import {
  CONNECTION,
  hasPrivateFoldersAndIdentity,
  read,
  run,
  world,
} from "./OverleafCoordinator.testkit.ts";

describe.skipIf(!hasPrivateFoldersAndIdentity)("Overleaf writes refused up front", () => {
  // A manuscript path holds at most 4 096 characters, far below Windows' budget.
  it.live.skipIf(HostProcess.Platform.defaultValue() === "win32")(
    "refuses a path over the host's budget before linking an apply",
    () =>
      run(
        Effect.gen(function* () {
          // Within the manuscript limit, but over 4 KiB once inside the folder. 511 levels
          // stay far under Git's tree depth limit.
          const path = `${"abcdefg/".repeat(510)}main.tex`;
          const w = yield* world({
            synced: { "main.tex": "before" },
            remote: { "main.tex": "after", [path]: "new" },
          });
          expect(yield* Effect.flip(w.sync())).toMatchObject({
            _tag: "OverleafFilesystemError",
            reason: "path-too-long",
          });
          expect(yield* read(w.folder, "main.tex")).toBe("before");
          expect((yield* w.connection).activeApply).toBeNull();
        }),
      ),
  );

  it.live("refuses a restore whose write could not be leased, before recording anything", () =>
    run(
      Effect.gen(function* () {
        let room = true,
          asked = 0;
        const w = yield* world({
          synced: { "main.tex": "A" },
          remote: { "main.tex": "B" },
          applier: (real) => ({
            ...real,
            fits: (input) =>
              Effect.suspend(() => {
                asked += 1;
                return room ? real.fits(input) : Effect.succeed(false);
              }),
          }),
        });
        yield* w.sync();
        const [copy] = yield* w.coordinator.keptCopies({ connectionId: CONNECTION });
        room = false;
        const before = asked;
        expect(
          yield* Effect.flip(
            w.coordinator.restoreKept({
              connectionId: CONNECTION,
              requestId: "restore",
              applyId: copy!.applyId,
              kept: copy!.kept,
              keptRevision: copy!.keptRevision!,
              currentRevision: copy!.currentRevision,
            }),
          ),
        ).toMatchObject({ _tag: "OverleafRetainedLimitError", limit: "folder-depth" });
        expect(asked).toBe(before + 1);
        expect(yield* read(w.folder, "main.tex")).toBe("B");
        expect((yield* w.connection).activeApply).toBeNull();
      }),
    ),
  );
});
