// @effect-diagnostics nodeBuiltinImport:off -- Real helper on real folders.
/**
 * How many folders one native lease binds. A lease can bind at most 256, so it
 * must not grow with the records kept from earlier writes: every save leaves
 * one behind in its folder's retention, for good.
 */
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { bytesRevision } from "./RetainedFileMutation.ts";
import { fileMutationFixture, nativePublicationHost } from "./fileExchange.testkit.ts";

const native = await nativePublicationHost();

/** A helper that notes how many folders each lease asks for, one line per lease. */
const countingHelper = (log: string) => async (helper: string) => {
  const wrapper = NodePath.join(NodePath.dirname(log), "scient-file-publication");
  await NodeFSP.writeFile(
    wrapper,
    // A lease is `--lease=1 <mode>` and then seven arguments per folder.
    `#!/bin/sh\nif [ "$1" = --lease=1 ]; then echo $(( ($# - 2) / 7 )) >> "${log}"; fi\nexec "${helper}" "$@"\n`,
    { mode: 0o755 },
  );
  return wrapper;
};

describe.skipIf(!native)("native publication lease", () => {
  it.live("holds as many folders however many records earlier writes kept", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "scient-lease-log-"))),
      (directory) => {
        const log = NodePath.join(directory, "leases.log");
        const leases = async () =>
          (await NodeFSP.readFile(log, "utf8").catch(() => ""))
            .split("\n")
            .filter(Boolean)
            .map(Number);
        /** The largest lease `work` takes. */
        const largest = async (work: () => Promise<unknown>) => {
          const before = (await leases()).length;
          await work();
          return Math.max(...(await leases()).slice(before));
        };
        return fileMutationFixture(
          async (h) => {
            const folder = NodePath.join(h.cwd, "chapters");
            await NodeFSP.mkdir(folder);
            const names = Array.from({ length: 6 }, (_, index) => `chapters/part-${index}.tex`);
            for (const name of names) await NodeFSP.writeFile(NodePath.join(h.cwd, name), "0");
            const read = () =>
              largest(() =>
                h.run(h.methods.withSettledWorkspaceRead({ cwd: h.cwd }, () => Effect.void)),
              );
            const readBefore = await read();
            // Twice over every file: each save keeps a record beside the others in
            // the folder, and the second round also beside its own file's first.
            const saves: number[] = [];
            for (const round of [1, 2])
              for (const name of names)
                saves.push(
                  await largest(() =>
                    h.run(
                      h.methods.writeFile({
                        cwd: h.cwd,
                        relativePath: name,
                        contents: String(round),
                        expectedRevision: bytesRevision(Buffer.from(String(round - 1))),
                        mutationId: `${name}-${round}`,
                      }),
                    ),
                  ),
                );
            for (const name of names)
              expect(await NodeFSP.readFile(NodePath.join(h.cwd, name), "utf8")).toBe("2");
            expect(saves).toEqual(saves.map(() => saves[0]));
            expect(await read()).toBe(readBefore);
          },
          {},
          null,
          countingHelper(log),
        );
      },
      (directory) => Effect.promise(() => NodeFSP.rm(directory, { recursive: true, force: true })),
    ),
  );

  it.live("saves into a folder that already keeps more records than one lease can bind", () =>
    fileMutationFixture(async (h) => {
      await NodeFSP.writeFile(NodePath.join(h.cwd, "kept.tex"), "0");
      await h.run(
        h.methods.writeFile({
          cwd: h.cwd,
          relativePath: "kept.tex",
          contents: "1",
          expectedRevision: bytesRevision(Buffer.from("0")),
          mutationId: "kept-1",
        }),
      );
      // The folder's store now holds that save's record; 300 more like it, finished.
      const folder = await NodeFSP.stat(h.cwd);
      const storage = NodePath.join(h.retentionRoot, `${folder.dev}-${folder.ino}`);
      const [record] = await NodeFSP.readdir(storage);
      for (let index = 0; index < 300; index++)
        await NodeFSP.cp(NodePath.join(storage, record!), NodePath.join(storage, `copy-${index}`), {
          recursive: true,
        });
      await NodeFSP.writeFile(NodePath.join(h.cwd, "next.tex"), "0");
      await h.run(
        h.methods.writeFile({
          cwd: h.cwd,
          relativePath: "next.tex",
          contents: "1",
          expectedRevision: bytesRevision(Buffer.from("0")),
          mutationId: "next-1",
        }),
      );
      expect(await NodeFSP.readFile(NodePath.join(h.cwd, "next.tex"), "utf8")).toBe("1");
      expect((await h.settledRead("kept.tex")).contents).toBe("1");
    }),
  );
});
