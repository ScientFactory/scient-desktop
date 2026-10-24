// @effect-diagnostics nodeBuiltinImport:off
/**
 * A discard of a kept version after real process death, for a record with a
 * current journal and for a legacy one. A child discards and kills itself
 * before the copy goes, between the copy and its view, or after both before
 * the folder is synced (and, for a current record, the mark dropped); a fresh
 * file layer then finds the marked record on its next settled read and
 * finishes the discard, so no hidden copy keeps the bytes or the room. A kept
 * copy that is a folder goes with everything in it, also when killed between
 * its files; one that cannot be removed stays listed without failing anything
 * else, and goes when discarded again.
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
import { ensureNativePrivateRetentionDirectory } from "../workspace/NativeFilePublication.ts";
import {
  bytesRevision,
  durableJson,
  readRetainedRecord,
} from "../workspace/RetainedFileMutation.ts";
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

type Harness = Parameters<Parameters<typeof fixture>[0]>[0];
const previous = "earlier\n".repeat(8192);

/** A kept version of `main.tex` from a save, its record journal version 2. */
async function savedVersion(h: Harness) {
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
  const listed = await h.run(h.files.listFileVersions({ cwd: h.cwd, relativePath: "main.tex" }));
  return listed.versions.find(
    (candidate) => candidate.revision === bytesRevision(Buffer.from(previous)),
  )!;
}

/** A kept version of `main.tex` in a legacy record (journal version 1), accepted as reviewed. */
async function legacyVersion(h: Harness, helper: string) {
  await NodeFSP.writeFile(NodePath.join(h.cwd, "main.tex"), "now\n");
  const folder = await NodeFSP.stat(h.cwd);
  const store = await ensureNativePrivateRetentionDirectory(
    helper,
    NodePath.join(h.root, "shared-retention"),
  );
  const parent = await ensureNativePrivateRetentionDirectory(
    helper,
    NodePath.join(store, `${folder.dev}-${folder.ino}`),
  );
  const directory = await ensureNativePrivateRetentionDirectory(
    helper,
    NodePath.join(parent, "legacy"),
  );
  await NodeFSP.writeFile(NodePath.join(directory, "slot"), previous);
  await durableJson(NodePath.join(directory, "record.json"), {
    version: 1,
    target: NodePath.join(h.cwd, "main.tex"),
    expected: bytesRevision(Buffer.from(previous)),
    desired: bytesRevision(Buffer.from("now\n")),
    mechanism: "move-aside",
    phase: "done",
    stagedIdentity: null,
    restoreSlot: null,
    restoreTarget: null,
    restoreSlotRevision: null,
    restoreTargetRevision: null,
    rounds: 0,
    visibleRetentionPath: null,
    outcome: "done",
  });
  const listed = await h.run(h.files.listFileVersions({ cwd: h.cwd, relativePath: "main.tex" }));
  await h.run(
    h.files.resolveFileMutation({
      cwd: h.cwd,
      relativePath: "main.tex",
      recoveryId: "legacy",
      choice: "accept-current",
      currentRevision: bytesRevision(Buffer.from("now\n")),
    }),
  );
  return listed.versions[0]!;
}

describe.skipIf(!canPublish)("a discard after real process death", () => {
  it.live.each(
    (["current", "legacy"] as const).flatMap((kind) =>
      (
        [
          { point: "before the copy goes", file: "copy", when: "before" },
          { point: "between the copy and its view", file: "copy", when: "after" },
          { point: "after both, before the sync", file: "view", when: "after" },
        ] as const
      ).map((crash) => ({ kind, ...crash })),
    ),
  )(
    "of a $kind record is finished by the next settled read, killed $point",
    ({ kind, file, when }) =>
      fixture(async (h) => {
        const helper = (await filePublicationTestHelper())!;
        const version = kind === "current" ? await savedVersion(h) : await legacyVersion(h, helper);
        const view = version.retainedPath,
          directory = NodePath.dirname(view),
          leaf = version.versionId.split(":")[1]!,
          copy = NodePath.join(directory, leaf);
        expect(await exists(copy)).toBe(true);
        expect(await exists(view)).toBe(true);
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
        if (kind === "current")
          expect(await readRetainedRecord(directory)).toMatchObject({ discarding: [leaf] });
        else expect(await exists(NodePath.join(directory, `discard-${leaf}.json`))).toBe(true);
        // A fresh file layer, as after a restart: its next settled read finishes it.
        const fresh = await h.run(
          makeApplierFiles({ root: h.root, helper, retainedHooks: {} }).pipe(
            Effect.provide(NodeServices.layer),
          ),
        );
        await h.run(fresh.withSettledWorkspaceRead({ cwd: h.cwd }, () => Effect.void));
        expect(await exists(copy)).toBe(false);
        expect(await exists(view)).toBe(false);
        if (kind === "current") {
          const record = await readRetainedRecord(directory);
          expect(record).toMatchObject({ discarded: [leaf] });
          expect(record.version === 2 && record.discarding).toBeUndefined();
        }
        const after = await h.run(fresh.listFileVersions({ cwd: h.cwd, relativePath: "main.tex" }));
        expect(after.versions.map((candidate) => candidate.versionId)).not.toContain(
          version.versionId,
        );
        expect(await NodeFSP.readFile(NodePath.join(h.cwd, "main.tex"), "utf8")).toBe("now\n");
      }),
  );

  /**
   * The version of `main.tex` a record of `kind` keeps, made a folder holding
   * two files: a folder that stood where the file was is kept as it stood.
   */
  const folderVersion = async (h: Harness, helper: string, kind: "current" | "legacy") => {
    const kept = kind === "current" ? await savedVersion(h) : await legacyVersion(h, helper);
    const directory = NodePath.dirname(kept.retainedPath),
      leaf = kept.versionId.split(":")[1]!,
      copy = NodePath.join(directory, leaf);
    await NodeFSP.rm(copy);
    await NodeFSP.rm(kept.retainedPath, { force: true });
    await NodeFSP.mkdir(NodePath.join(copy, "inner"), { recursive: true });
    await NodeFSP.writeFile(NodePath.join(copy, "a.tex"), "kept a\n");
    await NodeFSP.writeFile(NodePath.join(copy, "inner", "b.tex"), "kept b\n");
    return { versionId: kept.versionId, directory, copy };
  };
  /** A fresh file layer, as after a restart, and the work that must go on beside a kept folder. */
  const goesOn = async (h: Harness, helper: string) => {
    const fresh = await h.run(
      makeApplierFiles({ root: h.root, helper, retainedHooks: {} }).pipe(
        Effect.provide(NodeServices.layer),
      ),
    );
    await h.run(fresh.withSettledWorkspaceRead({ cwd: h.cwd }, () => Effect.void));
    await h.run(fresh.getMutationEpoch({ cwd: h.cwd }));
    const listed = await h.run(fresh.listFileVersions({ cwd: h.cwd, relativePath: "main.tex" }));
    await h.run(
      fresh.writeFile({
        cwd: h.cwd,
        relativePath: `beside-${listed.versions.length}.tex`,
        contents: "new\n",
        createOnly: true,
        mutationId: `beside-${listed.versions.length}`,
      }),
    );
    expect(await NodeFSP.readFile(NodePath.join(h.cwd, "main.tex"), "utf8")).toBe("now\n");
    return { fresh, listed };
  };

  it.live.each(["current", "legacy"] as const)(
    "discards a kept folder of a %s record, and everything after goes on",
    (kind) =>
      fixture(async (h) => {
        const helper = (await filePublicationTestHelper())!;
        const kept = await folderVersion(h, helper, kind);
        await h.run(
          h.files.discardFileVersion({
            cwd: h.cwd,
            relativePath: "main.tex",
            versionId: kept.versionId,
          }),
        );
        expect(await exists(kept.copy)).toBe(false);
        const { listed } = await goesOn(h, helper);
        expect(listed.versions.map((version) => version.versionId)).not.toContain(kept.versionId);
      }),
  );

  it.live.each(["current", "legacy"] as const)(
    "finishes the discard of a kept folder of a %s record killed between its files",
    (kind) =>
      fixture(async (h) => {
        const helper = (await filePublicationTestHelper())!;
        const kept = await folderVersion(h, helper, kind);
        const first = NodePath.join(kept.copy, "a.tex");
        const job: DiscardCrashJob = {
          root: h.root,
          cwd: h.cwd,
          helper,
          relativePath: "main.tex",
          versionId: kept.versionId,
          kill: { when: "after", path: first },
        };
        const jobPath = NodePath.join(h.root, "discard-crash.json");
        await NodeFSP.writeFile(jobPath, JSON.stringify(job));
        const run = NodeChildProcess.spawnSync(process.execPath, [child, jobPath], {
          encoding: "utf8",
          timeout: 60_000,
        });
        expect(run.signal, run.stderr).toBe("SIGKILL");
        expect(await exists(first)).toBe(false);
        expect(await exists(NodePath.join(kept.copy, "inner", "b.tex"))).toBe(true);
        const { listed } = await goesOn(h, helper);
        expect(await exists(kept.copy)).toBe(false);
        expect(listed.versions.map((version) => version.versionId)).not.toContain(kept.versionId);
      }),
  );

  it.live.each(["current", "legacy"] as const)(
    "a %s discard that cannot finish stays listed, fails nothing else, and finishes when asked again",
    (kind) =>
      fixture(async (h) => {
        const helper = (await filePublicationTestHelper())!;
        const kept = await folderVersion(h, helper, kind);
        // Nothing can be removed from `inner` while it is closed to writing.
        const inner = NodePath.join(kept.copy, "inner");
        await NodeFSP.chmod(inner, 0o500);
        try {
          const refused = await h.run(
            Effect.result(
              h.files.discardFileVersion({
                cwd: h.cwd,
                relativePath: "main.tex",
                versionId: kept.versionId,
              }),
            ),
          );
          expect(refused._tag).toBe("Failure");
          const { listed } = await goesOn(h, helper);
          expect(listed.versions.map((version) => version.versionId)).toContain(kept.versionId);
          expect(await NodeFSP.readFile(NodePath.join(inner, "b.tex"), "utf8")).toBe("kept b\n");
        } finally {
          await NodeFSP.chmod(inner, 0o700);
        }
        await h.run(
          h.files.discardFileVersion({
            cwd: h.cwd,
            relativePath: "main.tex",
            versionId: kept.versionId,
          }),
        );
        expect(await exists(kept.copy)).toBe(false);
        const { listed } = await goesOn(h, helper);
        expect(listed.versions.map((version) => version.versionId)).not.toContain(kept.versionId);
      }),
  );
});
