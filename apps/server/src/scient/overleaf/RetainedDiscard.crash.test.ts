// @effect-diagnostics nodeBuiltinImport:off
/**
 * A discard of a kept version after real process death. A child discards and
 * kills itself before the copy goes, between the copy and its view, or after
 * both before the folder is synced and the mark dropped; a fresh file layer
 * then finds the marked record on its next settled read and finishes the
 * discard, so no hidden copy keeps the bytes or the room.
 */
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import {
  filePublicationTestHelper,
  nativePublicationHost,
} from "../workspace/fileExchange.testkit.ts";
import { bytesRevision, readRetainedRecord } from "../workspace/RetainedFileMutation.ts";
import type { DiscardCrashJob } from "./RetainedDiscard.crash-child.ts";
import { makeApplierFiles } from "./WorkspaceApplier.files.testkit.ts";
import { fixture } from "./WorkspaceApplier.testkit.ts";

const canPublish = await nativePublicationHost();
const child = NodePath.join(import.meta.dirname, "RetainedDiscard.crash-child.ts");
const exists = (path: string) =>
  NodeFSP.lstat(path).then(
    () => true,
    () => false,
  );

describe.skipIf(!canPublish)("a discard after real process death", () => {
  it.live.each([
    { point: "before the copy goes", file: "copy", when: "before" },
    { point: "between the copy and its view", file: "copy", when: "after" },
    { point: "after both, before the sync", file: "view", when: "after" },
  ] as const)("is finished by the next settled read, killed $point", ({ file, when }) =>
    fixture(async (h) => {
      const helper = (await filePublicationTestHelper())!;
      const previous = "earlier\n".repeat(8192);
      await NodeFSP.writeFile(NodePath.join(h.cwd, "main.tex"), previous);
      await h.run(
        h.files.writeFile({
          cwd: h.cwd,
          relativePath: "main.tex",
          contents: "now\n",
          expectedRevision: bytesRevision(Buffer.from(previous)),
          mutationId: "save",
        }),
      );
      const listed = await h.run(
        h.files.listFileVersions({ cwd: h.cwd, relativePath: "main.tex" }),
      );
      const version = listed.versions.find(
        (candidate) => candidate.revision === bytesRevision(Buffer.from(previous)),
      )!;
      const view = version.retainedPath,
        directory = NodePath.dirname(view),
        copy = NodePath.join(directory, version.versionId.split(":")[1]!);
      expect(await exists(copy)).toBe(true);
      const job: DiscardCrashJob = {
        root: h.root,
        cwd: h.cwd,
        helper,
        relativePath: "main.tex",
        versionId: version.versionId,
        kill: { when, path: file === "copy" ? copy : view },
      };
      const jobPath = NodePath.join(h.root, "discard-crash.json");
      await NodeFSP.writeFile(jobPath, JSON.stringify(job));
      const run = NodeChildProcess.spawnSync(process.execPath, [child, jobPath], {
        encoding: "utf8",
        timeout: 60_000,
      });
      expect(run.signal, run.stderr).toBe("SIGKILL");
      // The crash left the mark: the discard is found, not hidden.
      expect(await readRetainedRecord(directory)).toMatchObject({
        discarding: [version.versionId.split(":")[1]],
      });
      // A fresh file layer, as after a restart: its next settled read finishes it.
      const fresh = await h.run(
        makeApplierFiles({ root: h.root, helper, retainedHooks: {} }).pipe(
          Effect.provide(NodeServices.layer),
        ),
      );
      await h.run(fresh.withSettledWorkspaceRead({ cwd: h.cwd }, () => Effect.void));
      expect(await exists(copy)).toBe(false);
      expect(await exists(view)).toBe(false);
      const record = await readRetainedRecord(directory);
      expect(record).toMatchObject({ discarded: [version.versionId.split(":")[1]] });
      expect(record.version === 2 && record.discarding).toBeUndefined();
      const after = await h.run(fresh.listFileVersions({ cwd: h.cwd, relativePath: "main.tex" }));
      expect(after.versions.map((candidate) => candidate.versionId)).not.toContain(
        version.versionId,
      );
      expect(await NodeFSP.readFile(NodePath.join(h.cwd, "main.tex"), "utf8")).toBe("now\n");
    }),
  );
});
