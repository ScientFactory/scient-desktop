// @effect-diagnostics nodeBuiltinImport:off -- Real folders, macOS access lists and native publication.
/**
 * The applier writes manuscript bytes into private folders only: one that an
 * access list opens to everyone is refused before anything is written there,
 * however closed its mode bits look.
 */
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import * as HostProcess from "@t3tools/shared/HostProcess";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { canApply, read, run, world } from "./OverleafCoordinator.testkit.ts";

describe.skipIf(!canApply || HostProcess.Platform.defaultValue() !== "darwin")(
  "Overleaf apply privacy",
  () => {
    it.live("refuses an apply folder 0700 that an access list opens to everyone", () =>
      run(
        Effect.gen(function* () {
          let planPath = "";
          const w = yield* world({
            synced: { "main.tex": "A" },
            remote: { "main.tex": "PRIVATE_MANUSCRIPT" },
            applier: (real) => ({
              ...real,
              apply: (input) =>
                Effect.gen(function* () {
                  const directory = NodePath.join(input.applicationDirectory, input.id);
                  planPath = NodePath.join(directory, "plan.json");
                  yield* Effect.promise(async () => {
                    await NodeFSP.mkdir(directory, { recursive: true, mode: 0o700 });
                    NodeChildProcess.execFileSync("/bin/chmod", [
                      "+a",
                      "everyone allow list,search,read,readattr,readextattr,readsecurity,file_inherit,directory_inherit",
                      directory,
                    ]);
                  });
                  return yield* real.apply(input);
                }),
            }),
          });
          expect((yield* w.sync().pipe(Effect.exit))._tag).toBe("Failure");
          expect(
            yield* Effect.promise(() =>
              NodeFSP.access(planPath).then(
                () => true,
                () => false,
              ),
            ),
          ).toBe(false);
          expect(yield* read(w.folder, "main.tex")).toBe("A");
        }),
      ),
    );
  },
);
