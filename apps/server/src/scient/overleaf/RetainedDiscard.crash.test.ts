// @effect-diagnostics nodeBuiltinImport:off
/** Discard of a kept version after real process death (current and legacy records):
 * a fresh file layer finishes a marked discard on its next settled read. A kept
 * copy that is a folder goes only while empty; a non-empty one is refused/left
 * listed without failing anything else. */
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import * as HostProcess from "@t3tools/shared/HostProcess";
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
/** macOS can mount a disk image in a test. */
const diskImages =
  HostProcess.Platform.defaultValue() === "darwin" &&
  NodeChildProcess.spawnSync("/usr/bin/hdiutil", ["help"]).status !== null;
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

/**
 * The version of `main.tex` a record of `kind` keeps, made a folder (a folder
 * that stood where the file was is kept as it stood), holding `files`.
 */
const folderVersion = async (
  h: Harness,
  helper: string,
  kind: "current" | "legacy",
  files: Record<string, string> = {},
) => {
  const kept = kind === "current" ? await savedVersion(h) : await legacyVersion(h, helper);
  const directory = NodePath.dirname(kept.retainedPath),
    leaf = kept.versionId.split(":")[1]!,
    copy = NodePath.join(directory, leaf);
  await NodeFSP.rm(copy);
  await NodeFSP.rm(kept.retainedPath, { force: true });
  await NodeFSP.mkdir(copy);
  for (const [name, text] of Object.entries(files)) {
    await NodeFSP.mkdir(NodePath.dirname(NodePath.join(copy, name)), { recursive: true });
    await NodeFSP.writeFile(NodePath.join(copy, name), text);
  }
  return { versionId: kept.versionId, directory, leaf, copy };
};
type Kept = Awaited<ReturnType<typeof folderVersion>>;
/** The discard mark a crashed (or older) discard left: the journal's, or a legacy tombstone. */
const markDiscard = async (kind: "current" | "legacy", kept: Kept) => {
  if (kind === "legacy")
    return durableJson(NodePath.join(kept.directory, `discard-${kept.leaf}.json`), {
      version: 1,
      discarded: true,
    });
  const record = await readRetainedRecord(kept.directory);
  if (record.version !== 2) throw new Error("A current record was expected.");
  await durableJson(NodePath.join(kept.directory, "record.json"), {
    ...record,
    discarded: [...record.discarded, kept.leaf],
    discarding: [kept.leaf],
    generation: record.generation + 1,
  });
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
  return listed.versions.map((version) => version.versionId);
};
const kinds = ["current", "legacy"] as const;

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

  it.live.each(kinds)("discards an empty kept folder of a %s record", (kind) =>
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
      expect(await goesOn(h, helper)).not.toContain(kept.versionId);
    }),
  );

  it.live.each(kinds)(
    "refuses a kept folder of a %s record with files in it before marking anything",
    (kind) =>
      fixture(async (h) => {
        const helper = (await filePublicationTestHelper())!;
        const kept = await folderVersion(h, helper, kind, { "inner/b.tex": "kept b\n" });
        const before = await NodeFSP.readFile(NodePath.join(kept.directory, "record.json"), "utf8");
        const refused = await h.run(
          Effect.flip(
            h.files.discardFileVersion({
              cwd: h.cwd,
              relativePath: "main.tex",
              versionId: kept.versionId,
            }),
          ),
        );
        expect(refused).toMatchObject({
          _tag: "WorkspaceFileMutationUnavailableError",
          reason: "kept-folder-not-empty",
          publicationOutcome: "unchanged",
        });
        expect(await NodeFSP.readFile(NodePath.join(kept.directory, "record.json"), "utf8")).toBe(
          before,
        );
        expect(await exists(NodePath.join(kept.directory, `discard-${kept.leaf}.json`))).toBe(
          false,
        );
        expect(await NodeFSP.readFile(NodePath.join(kept.copy, "inner", "b.tex"), "utf8")).toBe(
          "kept b\n",
        );
        expect(await goesOn(h, helper)).toContain(kept.versionId);
      }),
  );

  it.live.each(kinds)(
    "leaves a marked kept folder of a %s record with anything in it, never reaching through it, and fails nothing else",
    (kind) =>
      fixture(async (h) => {
        const helper = (await filePublicationTestHelper())!;
        // Outside the record: a workspace folder the kept folder links to.
        const outside = NodePath.join(h.cwd, "outside");
        await NodeFSP.mkdir(outside);
        await NodeFSP.writeFile(NodePath.join(outside, "valuable.tex"), "valuable\n");
        const kept = await folderVersion(h, helper, kind, { "inner/b.tex": "kept b\n" });
        await NodeFSP.symlink(outside, NodePath.join(kept.copy, "link"));
        await markDiscard(kind, kept);
        expect(await goesOn(h, helper)).toContain(kept.versionId);
        expect(await NodeFSP.readFile(NodePath.join(outside, "valuable.tex"), "utf8")).toBe(
          "valuable\n",
        );
        expect(await NodeFSP.readFile(NodePath.join(kept.copy, "inner", "b.tex"), "utf8")).toBe(
          "kept b\n",
        );
        expect(await exists(NodePath.join(kept.copy, "link"))).toBe(true);
        // Emptied, the next settlement finishes the discard.
        await NodeFSP.rm(NodePath.join(kept.copy, "inner"), { recursive: true });
        await NodeFSP.unlink(NodePath.join(kept.copy, "link"));
        expect(await goesOn(h, helper)).not.toContain(kept.versionId);
        expect(await exists(kept.copy)).toBe(false);
        expect(await NodeFSP.readFile(NodePath.join(outside, "valuable.tex"), "utf8")).toBe(
          "valuable\n",
        );
      }),
  );

  it.live.each(kinds)(
    "removes a marked kept copy of a %s record that became a link as a name only",
    (kind) =>
      fixture(async (h) => {
        const helper = (await filePublicationTestHelper())!;
        const outside = NodePath.join(h.cwd, "outside");
        await NodeFSP.mkdir(outside);
        await NodeFSP.writeFile(NodePath.join(outside, "valuable.tex"), "valuable\n");
        const kept = await folderVersion(h, helper, kind);
        await markDiscard(kind, kept);
        // Replaced by a link to a workspace folder after it was marked.
        await NodeFSP.rmdir(kept.copy);
        await NodeFSP.symlink(outside, kept.copy);
        expect(await goesOn(h, helper)).not.toContain(kept.versionId);
        expect(await exists(kept.copy)).toBe(false);
        expect(await NodeFSP.readFile(NodePath.join(outside, "valuable.tex"), "utf8")).toBe(
          "valuable\n",
        );
      }),
  );
});

describe.skipIf(!canPublish || !diskImages)("a discard beside a mounted volume", () => {
  it.live.each(kinds)(
    "never removes anything on a volume mounted in a marked kept folder of a %s record",
    (kind) =>
      fixture(async (h) => {
        const helper = (await filePublicationTestHelper())!;
        const kept = await folderVersion(h, helper, kind);
        const image = NodePath.join(h.root, "volume.dmg"),
          volume = NodePath.join(kept.copy, "volume");
        NodeChildProcess.execFileSync("/usr/bin/hdiutil", [
          "create",
          "-quiet",
          "-size",
          "8m",
          "-fs",
          "HFS+",
          "-volname",
          "SCTKEPT",
          image,
        ]);
        await NodeFSP.mkdir(volume);
        NodeChildProcess.execFileSync("/usr/bin/hdiutil", [
          "attach",
          "-quiet",
          "-nobrowse",
          "-mountpoint",
          volume,
          image,
        ]);
        try {
          await NodeFSP.writeFile(NodePath.join(volume, "external.tex"), "external\n");
          await markDiscard(kind, kept);
          expect(await goesOn(h, helper)).toContain(kept.versionId);
          expect(await NodeFSP.readFile(NodePath.join(volume, "external.tex"), "utf8")).toBe(
            "external\n",
          );
          await NodeFSP.writeFile(NodePath.join(volume, "later.tex"), "later\n");
          await goesOn(h, helper);
          expect(await NodeFSP.readFile(NodePath.join(volume, "later.tex"), "utf8")).toBe(
            "later\n",
          );
        } finally {
          NodeChildProcess.execFileSync("/usr/bin/hdiutil", ["detach", "-force", "-quiet", volume]);
        }
      }),
  );
});
