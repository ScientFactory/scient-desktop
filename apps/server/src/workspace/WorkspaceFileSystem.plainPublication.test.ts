import * as HostProcess from "@t3tools/shared/HostProcess";
// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeTimersPromises from "node:timers/promises";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import { describe, expect, it } from "@effect/vitest";
import {
  fileMutationFixture,
  filePublicationHelperWithout,
} from "../scient/workspace/fileExchange.testkit.ts";
import { bytesRevision } from "../scient/workspace/RetainedFileMutation.ts";

const revision = (text: string) => bytesRevision(Buffer.from(text));
const leftovers = async (directory: string) =>
  (await NodeFSP.readdir(directory)).filter((name) => name.endsWith(".scient-tmp"));
const posix = HostProcess.Platform.defaultValue() !== "win32";

/**
 * Plain publication in each way a host reaches it: the Windows helper (no shared leases,
 * no one-step replace or create), a native host whose volume cannot publish in one step,
 * and no helper at all. Where no helper can be compiled every mode runs without one.
 */
const modes = [
  [
    "a Windows-like helper",
    (helper: string) =>
      filePublicationHelperWithout(helper, [
        "sharedPublicationLease",
        "atomicExchange",
        "atomicCreateMetadata",
        "atomicPublicationMetadata",
      ]),
  ],
  [
    "a native helper without one-step publication",
    (helper: string) =>
      filePublicationHelperWithout(helper, [
        "atomicExchange",
        "atomicCreateMetadata",
        "atomicPublicationMetadata",
      ]),
  ],
  ["no helper", async () => undefined],
] as const;

describe.each(modes)("plain publication with %s", (_name, wrap) => {
  const plain = (body: Parameters<typeof fileMutationFixture>[0]) =>
    fileMutationFixture(body, {}, null, wrap);

  it.live("saves changed bytes, keeps permissions and leaves no temporary file", () =>
    plain(async (h) => {
      const target = NodePath.join(h.cwd, "main.tex");
      await NodeFSP.writeFile(target, "A", { mode: 0o640 });
      const saved = await h.run(
        h.methods.writeFile({
          cwd: h.cwd,
          relativePath: "main.tex",
          contents: "C",
          expectedRevision: revision("A"),
        }),
      );
      expect(saved).toMatchObject({ relativePath: "main.tex", revision: revision("C") });
      expect(await NodeFSP.readFile(target, "utf8")).toBe("C");
      if (posix) expect((await NodeFSP.stat(target)).mode & 0o777).toBe(0o640);
      expect(await leftovers(h.cwd)).toEqual([]);
      expect(await h.settledRead("main.tex")).toMatchObject({ contents: "C" });
    }),
  );

  it.live("refuses a stale revision without touching the file", () =>
    plain(async (h) => {
      const target = NodePath.join(h.cwd, "main.tex");
      await NodeFSP.writeFile(target, "outside B");
      await expect(
        h.run(
          h.methods.writeFile({
            cwd: h.cwd,
            relativePath: "main.tex",
            contents: "C",
            expectedRevision: revision("A"),
          }),
        ),
      ).rejects.toMatchObject({
        _tag: "WorkspaceFileRevisionConflictError",
        currentRevision: revision("outside B"),
      });
      expect(await NodeFSP.readFile(target, "utf8")).toBe("outside B");
      expect(await leftovers(h.cwd)).toEqual([]);
    }),
  );

  it.live.skipIf(!posix)(
    "reports a failure before the rename as unchanged, with the system's error",
    () =>
      plain(async (h) => {
        const folder = NodePath.join(h.cwd, "locked");
        await NodeFSP.mkdir(folder);
        await NodeFSP.writeFile(NodePath.join(folder, "main.tex"), "A");
        await NodeFSP.chmod(folder, 0o555);
        try {
          await expect(
            h.run(
              h.methods.writeFile({
                cwd: h.cwd,
                relativePath: "locked/main.tex",
                contents: "C",
                expectedRevision: revision("A"),
              }),
            ),
          ).rejects.toMatchObject({
            _tag: "WorkspaceFileSystemOperationError",
            publicationOutcome: "unchanged",
            cause: { code: "EACCES" },
          });
        } finally {
          await NodeFSP.chmod(folder, 0o755);
        }
        expect(await NodeFSP.readFile(NodePath.join(folder, "main.tex"), "utf8")).toBe("A");
        expect(await leftovers(folder)).toEqual([]);
      }),
  );

  it.live("keeps epochs stable between service instances and advances them on each save", () =>
    plain(async (h) => {
      await NodeFSP.writeFile(NodePath.join(h.cwd, "main.tex"), "A");
      const untouched = await h.run(h.methods.getMutationEpoch({ cwd: h.cwd }));
      let methods = await h.restart();
      // Instances in one process share the run's count, so their epochs agree.
      expect(await h.run(methods.getMutationEpoch({ cwd: h.cwd }))).toBe(untouched);
      await h.run(
        methods.writeFile({
          cwd: h.cwd,
          relativePath: "main.tex",
          contents: "B",
          expectedRevision: revision("A"),
        }),
      );
      const saved = await h.run(methods.getMutationEpoch({ cwd: h.cwd }));
      methods = await h.restart();
      await h.run(
        methods.writeFile({
          cwd: h.cwd,
          relativePath: "main.tex",
          contents: "C",
          expectedRevision: revision("B"),
        }),
      );
      // Every save advances the epoch past every earlier one.
      const later = await h.run(methods.getMutationEpoch({ cwd: h.cwd }));
      expect(later).not.toBe(saved);
      expect(later).not.toBe(untouched);
    }),
  );

  it.live.skipIf(!posix)("reports a refused read of the current file as unchanged", () =>
    plain(async (h) => {
      const target = NodePath.join(h.cwd, "main.tex");
      await NodeFSP.writeFile(target, "A");
      await NodeFSP.chmod(target, 0o000);
      try {
        await expect(
          h.run(
            h.methods.writeFile({
              cwd: h.cwd,
              relativePath: "main.tex",
              contents: "C",
              expectedRevision: revision("A"),
            }),
          ),
        ).rejects.toMatchObject({
          _tag: "WorkspaceFileSystemOperationError",
          publicationOutcome: "unchanged",
          cause: { code: "EACCES" },
        });
      } finally {
        await NodeFSP.chmod(target, 0o644);
      }
      expect(await NodeFSP.readFile(target, "utf8")).toBe("A");
    }),
  );

  it.live("replays a retried save, converges after a restart and refuses a reused identity", () =>
    plain(async (h) => {
      const target = NodePath.join(h.cwd, "main.tex");
      await NodeFSP.writeFile(target, "A");
      const input = {
        cwd: h.cwd,
        relativePath: "main.tex",
        contents: "C",
        expectedRevision: revision("A"),
        mutationId: "save",
      };
      const first = await h.run(h.methods.writeFile(input));
      expect(await h.run(h.methods.writeFile(input))).toEqual(first);
      await expect(h.run(h.methods.writeFile({ ...input, contents: "D" }))).rejects.toMatchObject({
        _tag: "WorkspaceFileMutationIntentConflictError",
      });
      // A lost reply: the bytes are already on disk, so a new server converges without writing.
      const methods = await h.restart();
      expect(await h.run(methods.writeFile(input))).toMatchObject({ revision: revision("C") });
      expect(await NodeFSP.readFile(target, "utf8")).toBe("C");
    }),
  );

  it.live("creates exclusively, including missing folders, and refuses an existing file", () =>
    plain(async (h) => {
      const created = await h.run(
        h.methods.createBinaryFile({
          cwd: h.cwd,
          relativePath: "chapters/one/intro.tex",
          bytes: Buffer.from("Intro"),
        }),
      );
      expect(created).toMatchObject({ revision: revision("Intro") });
      const target = NodePath.join(h.cwd, "chapters/one/intro.tex");
      expect(await NodeFSP.readFile(target, "utf8")).toBe("Intro");
      await expect(
        h.run(
          h.methods.writeFile({
            cwd: h.cwd,
            relativePath: "chapters/one/intro.tex",
            contents: "Other",
            createOnly: true,
          }),
        ),
      ).rejects.toMatchObject({ _tag: "WorkspaceFileExistsError" });
      expect(await NodeFSP.readFile(target, "utf8")).toBe("Intro");
      expect(await leftovers(NodePath.dirname(target))).toEqual([]);
      await h.run(
        h.methods.writeFile({ cwd: h.cwd, relativePath: "notes.md", contents: "Unguarded" }),
      );
      expect(await NodeFSP.readFile(NodePath.join(h.cwd, "notes.md"), "utf8")).toBe("Unguarded");
    }),
  );

  it.live("advances the workspace epoch so stale build fences and exports refuse", () =>
    plain(async (h) => {
      await NodeFSP.writeFile(NodePath.join(h.cwd, "main.tex"), "A");
      const before = await h.run(h.methods.getMutationEpoch({ cwd: h.cwd }));
      expect(await h.run(h.methods.getMutationEpoch({ cwd: h.cwd }))).toBe(before);
      await h.run(
        h.methods.writeFile({
          cwd: h.cwd,
          relativePath: "main.tex",
          contents: "B",
          expectedRevision: revision("A"),
        }),
      );
      const after = await h.run(h.methods.getMutationEpoch({ cwd: h.cwd }));
      expect(after).not.toBe(before);
      const artifact = NodePath.join(h.root, "artifact");
      await expect(
        h.run(
          h.methods.withWorkspacePublicationFence({ cwd: h.cwd, expectedEpoch: before }, () =>
            Effect.promise(() => NodeFSP.writeFile(artifact, "stale")),
          ),
        ),
      ).rejects.toMatchObject({ _tag: "WorkspaceFileTargetChangedError" });
      await expect(NodeFSP.lstat(artifact)).rejects.toMatchObject({ code: "ENOENT" });
      await h.run(
        h.methods.withWorkspacePublicationFence({ cwd: h.cwd, expectedEpoch: after }, () =>
          Effect.promise(() => NodeFSP.writeFile(artifact, "current")),
        ),
      );
      expect(await NodeFSP.readFile(artifact, "utf8")).toBe("current");
      const pdf = Buffer.from("%PDF-1.7\0binary");
      const exported = await h.run(
        h.methods.writeBinaryFile({
          cwd: h.cwd,
          relativePath: "main.pdf",
          bytes: pdf,
          mutationId: "pdf",
          expectedMutationEpoch: after,
        }),
      );
      expect(exported.publicationEpoch).toBe(
        await h.run(h.methods.getMutationEpoch({ cwd: h.cwd })),
      );
      expect(exported.publicationEpoch).not.toBe(after);
      expect(await NodeFSP.readFile(NodePath.join(h.cwd, "main.pdf"))).toEqual(pdf);
      await expect(
        h.run(
          h.methods.writeBinaryFile({
            cwd: h.cwd,
            relativePath: "main.pdf",
            bytes: Buffer.from("%PDF-1.7\0again"),
            mutationId: "pdf-stale",
            expectedMutationEpoch: after,
          }),
        ),
      ).rejects.toMatchObject({ _tag: "WorkspaceFileTargetChangedError" });
      // A save under a nested root advances the enclosing root's epoch too.
      await NodeFSP.mkdir(NodePath.join(h.cwd, "chapter"));
      const outer = await h.run(h.methods.getMutationEpoch({ cwd: h.cwd }));
      await h.run(
        h.methods.writeFile({
          cwd: NodePath.join(h.cwd, "chapter"),
          relativePath: "one.tex",
          contents: "One",
        }),
      );
      expect(await h.run(h.methods.getMutationEpoch({ cwd: h.cwd }))).not.toBe(outer);
    }),
  );
});

describe.each(modes.filter(([name]) => name !== "a native helper without one-step publication"))(
  "plain moves and deletes with %s",
  (_name, wrap) => {
    const plain = (body: Parameters<typeof fileMutationFixture>[0]) =>
      fileMutationFixture(body, {}, null, wrap);

    it.live("moves a file only when its revision is current and never over another file", () =>
      plain(async (h) => {
        await NodeFSP.writeFile(NodePath.join(h.cwd, "a.tex"), "A");
        await NodeFSP.writeFile(NodePath.join(h.cwd, "taken.tex"), "T");
        await expect(
          h.run(
            h.methods.renameFile({
              cwd: h.cwd,
              relativePath: "a.tex",
              destinationRelativePath: "taken.tex",
              expectedRevision: revision("A"),
            }),
          ),
        ).rejects.toMatchObject({ _tag: "WorkspaceFileExistsError" });
        await expect(
          h.run(
            h.methods.renameFile({
              cwd: h.cwd,
              relativePath: "a.tex",
              destinationRelativePath: "b.tex",
              expectedRevision: revision("stale"),
            }),
          ),
        ).rejects.toMatchObject({ _tag: "WorkspaceFileRevisionConflictError" });
        const moved = await h.run(
          h.methods.renameFile({
            cwd: h.cwd,
            relativePath: "a.tex",
            destinationRelativePath: "parts/b.tex",
            expectedRevision: revision("A"),
            mutationId: "move",
          }),
        );
        expect(moved).toMatchObject({
          destinationRelativePath: "parts/b.tex",
          revision: revision("A"),
          mutationId: "move",
        });
        await expect(NodeFSP.lstat(NodePath.join(h.cwd, "a.tex"))).rejects.toMatchObject({
          code: "ENOENT",
        });
        expect(await NodeFSP.readFile(NodePath.join(h.cwd, "parts/b.tex"), "utf8")).toBe("A");
        expect(await NodeFSP.readFile(NodePath.join(h.cwd, "taken.tex"), "utf8")).toBe("T");
      }),
    );

    it.live("lets a callback owning one workspace use another, unrelated one", () =>
      plain(async (h) => {
        const other = NodePath.join(h.root, "other");
        await NodeFSP.mkdir(other);
        const epoch = await h.run(h.methods.getMutationEpoch({ cwd: h.cwd }));
        await h.run(
          h.methods.withWorkspacePublicationFence({ cwd: h.cwd, expectedEpoch: epoch }, () =>
            Effect.gen(function* () {
              yield* h.methods.getMutationEpoch({ cwd: other });
              yield* h.methods.writeFile({ cwd: other, relativePath: "x.tex", contents: "X" });
            }),
          ),
        );
        expect(await NodeFSP.readFile(NodePath.join(other, "x.tex"), "utf8")).toBe("X");
      }),
    );

    it.live("lets a held callback take a sibling while their parent waits", () =>
      plain(async (h) => {
        const parent = NodePath.join(h.cwd, "paper");
        const a = NodePath.join(parent, "a"),
          b = NodePath.join(parent, "b");
        await NodeFSP.mkdir(a, { recursive: true });
        await NodeFSP.mkdir(b);
        const epoch = await h.run(h.methods.getMutationEpoch({ cwd: a }));
        const parentQueued = Promise.withResolvers<void>();
        const fence = h.run(
          h.methods.withWorkspacePublicationFence({ cwd: a, expectedEpoch: epoch }, () =>
            Effect.gen(function* () {
              yield* Effect.promise(() => parentQueued.promise);
              yield* h.methods.writeFile({ cwd: b, relativePath: "x.tex", contents: "B" });
            }),
          ),
        );
        await NodeTimersPromises.setTimeout(20);
        const parentSave = h.run(
          h.methods.writeFile({ cwd: parent, relativePath: "p.tex", contents: "P" }),
        );
        await NodeTimersPromises.setTimeout(20);
        parentQueued.resolve();
        await fence;
        await parentSave;
        expect(await NodeFSP.readFile(NodePath.join(b, "x.tex"), "utf8")).toBe("B");
        expect(await NodeFSP.readFile(NodePath.join(parent, "p.tex"), "utf8")).toBe("P");
      }),
    );

    it.live("refuses one mutation id used for two different saves at once", () =>
      plain(async (h) => {
        const other = NodePath.join(h.root, "other");
        await NodeFSP.mkdir(other);
        const epoch = await h.run(h.methods.getMutationEpoch({ cwd: h.cwd }));
        const gate = Promise.withResolvers<void>();
        const fence = h.run(
          h.methods.withWorkspacePublicationFence({ cwd: h.cwd, expectedEpoch: epoch }, () =>
            Effect.promise(() => gate.promise),
          ),
        );
        // The first save holds its id while it waits behind the fence.
        const waiting = h.run(
          h.methods.writeFile({
            cwd: h.cwd,
            relativePath: "a.tex",
            contents: "A",
            mutationId: "shared",
          }),
        );
        await NodeTimersPromises.setTimeout(20);
        await expect(
          h.run(
            h.methods.writeFile({
              cwd: other,
              relativePath: "b.tex",
              contents: "B",
              mutationId: "shared",
            }),
          ),
        ).rejects.toMatchObject({ _tag: "WorkspaceFileMutationIntentConflictError" });
        gate.resolve();
        await fence;
        await waiting;
        expect(await NodeFSP.readFile(NodePath.join(h.cwd, "a.tex"), "utf8")).toBe("A");
        await expect(NodeFSP.lstat(NodePath.join(other, "b.tex"))).rejects.toMatchObject({
          code: "ENOENT",
        });
      }),
    );

    it.live("keeps an id claimed while an identical retry still waits", () =>
      plain(async (h) => {
        const other = NodePath.join(h.root, "other");
        await NodeFSP.mkdir(other);
        const epoch = await h.run(h.methods.getMutationEpoch({ cwd: h.cwd }));
        const gate = Promise.withResolvers<void>();
        const fence = h.run(
          h.methods.withWorkspacePublicationFence({ cwd: h.cwd, expectedEpoch: epoch }, () =>
            Effect.promise(() => gate.promise),
          ),
        );
        const save = h.methods.writeFile({
          cwd: h.cwd,
          relativePath: "a.tex",
          contents: "A",
          mutationId: "retried",
        });
        // The original claims first and waits; its retry joins; then the original is cancelled.
        const originalWaiting = Promise.withResolvers<void>(),
          cancelNow = Promise.withResolvers<void>();
        const cancelling = h.run(
          Effect.gen(function* () {
            const original = yield* Effect.forkChild(save);
            yield* Effect.sleep("20 millis");
            originalWaiting.resolve();
            yield* Effect.promise(() => cancelNow.promise);
            yield* Fiber.interrupt(original);
          }),
        );
        await originalWaiting.promise;
        const retry = h.run(save);
        await NodeTimersPromises.setTimeout(20);
        cancelNow.resolve();
        await cancelling;
        await expect(
          h.run(
            h.methods.writeFile({
              cwd: other,
              relativePath: "b.tex",
              contents: "B",
              mutationId: "retried",
            }),
          ),
        ).rejects.toMatchObject({ _tag: "WorkspaceFileMutationIntentConflictError" });
        gate.resolve();
        await fence;
        expect(await retry).toMatchObject({ revision: revision("A") });
      }),
    );

    it.live("makes reads and epoch reads wait while a fence owns the workspace", () =>
      plain(async (h) => {
        await NodeFSP.writeFile(NodePath.join(h.cwd, "main.tex"), "A");
        const epoch = await h.run(h.methods.getMutationEpoch({ cwd: h.cwd }));
        const gate = Promise.withResolvers<void>();
        const fence = h.run(
          h.methods.withWorkspacePublicationFence({ cwd: h.cwd, expectedEpoch: epoch }, () =>
            Effect.promise(() => gate.promise),
          ),
        );
        let settled = false,
          epochRead = false;
        const read = h.settledRead("main.tex").then((value) => {
          settled = true;
          return value;
        });
        const reread = h.run(h.methods.getMutationEpoch({ cwd: h.cwd })).then((value) => {
          epochRead = true;
          return value;
        });
        await NodeTimersPromises.setTimeout(50);
        expect([settled, epochRead]).toEqual([false, false]);
        gate.resolve();
        await fence;
        expect(await read).toMatchObject({ contents: "A" });
        expect(await reread).toBe(epoch);
      }),
    );

    it.live("never runs a save cancelled while it waited for the lock", () =>
      plain(async (h) => {
        const target = NodePath.join(h.cwd, "main.tex");
        await NodeFSP.writeFile(target, "A");
        const epoch = await h.run(h.methods.getMutationEpoch({ cwd: h.cwd }));
        const gate = Promise.withResolvers<void>();
        const fence = h.run(
          h.methods.withWorkspacePublicationFence({ cwd: h.cwd, expectedEpoch: epoch }, () =>
            Effect.promise(() => gate.promise),
          ),
        );
        // Queue a save behind the held fence, then cancel it before it gets the lock.
        const cancelled = h.run(
          Effect.gen(function* () {
            const save = yield* Effect.forkChild(
              h.methods.writeFile({
                cwd: h.cwd,
                relativePath: "main.tex",
                contents: "C",
                expectedRevision: revision("A"),
              }),
            );
            yield* Effect.sleep("50 millis");
            yield* Fiber.interrupt(save);
          }),
        );
        await NodeTimersPromises.setTimeout(150);
        gate.resolve();
        await fence;
        await cancelled;
        expect(await NodeFSP.readFile(target, "utf8")).toBe("A");
      }),
    );

    it.live("deletes only the current revision and removes folders it empties", () =>
      plain(async (h) => {
        await NodeFSP.mkdir(NodePath.join(h.cwd, "old/deep"), { recursive: true });
        const target = NodePath.join(h.cwd, "old/deep/x.tex");
        await NodeFSP.writeFile(target, "X");
        await expect(
          h.run(
            h.methods.deleteFile({
              cwd: h.cwd,
              relativePath: "old/deep/x.tex",
              expectedRevision: revision("stale"),
            }),
          ),
        ).rejects.toMatchObject({ _tag: "WorkspaceFileRevisionConflictError" });
        expect(await NodeFSP.readFile(target, "utf8")).toBe("X");
        await h.run(
          h.methods.deleteFile({
            cwd: h.cwd,
            relativePath: "old/deep/x.tex",
            expectedRevision: revision("X"),
            removeEmptyFolders: true,
          }),
        );
        await expect(NodeFSP.lstat(NodePath.join(h.cwd, "old"))).rejects.toMatchObject({
          code: "ENOENT",
        });
        expect(
          await h.run(h.methods.listFileVersions({ cwd: h.cwd, relativePath: "old/deep/x.tex" })),
        ).toMatchObject({ versions: [], attention: null });
      }),
    );
  },
);

describe("plain creation on a native host", () => {
  it.live("refuses a later move or delete that reuses the creation's identity", () =>
    fileMutationFixture(
      async (h) => {
        await h.run(
          h.methods.createBinaryFile({
            cwd: h.cwd,
            relativePath: "new.tex",
            bytes: Buffer.from("N"),
            mutationId: "shared-identity",
          }),
        );
        await expect(
          h.run(
            h.methods.deleteFile({
              cwd: h.cwd,
              relativePath: "new.tex",
              expectedRevision: revision("N"),
              mutationId: "shared-identity",
            }),
          ),
        ).rejects.toMatchObject({ _tag: "WorkspaceFileMutationIntentConflictError" });
        await expect(
          h.run(
            h.methods.renameFile({
              cwd: h.cwd,
              relativePath: "new.tex",
              destinationRelativePath: "moved.tex",
              expectedRevision: revision("N"),
              mutationId: "shared-identity",
            }),
          ),
        ).rejects.toMatchObject({ _tag: "WorkspaceFileMutationIntentConflictError" });
        expect(await NodeFSP.readFile(NodePath.join(h.cwd, "new.tex"), "utf8")).toBe("N");
      },
      {},
      null,
      modes[1][1],
    ),
  );
});

describe("plain creation beside native replacement", () => {
  it.live("refuses a native save reusing an id a waiting plain creation holds", () =>
    fileMutationFixture(
      async (h) => {
        const other = NodePath.join(h.root, "other");
        await NodeFSP.mkdir(other);
        await NodeFSP.writeFile(NodePath.join(other, "b.tex"), "B");
        const epoch = await h.run(h.methods.getMutationEpoch({ cwd: h.cwd }));
        const gate = Promise.withResolvers<void>();
        const fence = h.run(
          h.methods.withWorkspacePublicationFence({ cwd: h.cwd, expectedEpoch: epoch }, () =>
            Effect.promise(() => gate.promise),
          ),
        );
        // Creation is plain on this volume and waits behind the fence, holding its id.
        const created = h.run(
          h.methods.createBinaryFile({
            cwd: h.cwd,
            relativePath: "new.tex",
            bytes: Buffer.from("N"),
            mutationId: "shared",
          }),
        );
        await NodeTimersPromises.setTimeout(50);
        await expect(
          h.run(
            h.methods.writeFile({
              cwd: other,
              relativePath: "b.tex",
              contents: "C",
              expectedRevision: revision("B"),
              mutationId: "shared",
            }),
          ),
        ).rejects.toMatchObject({ _tag: "WorkspaceFileMutationIntentConflictError" });
        expect(await NodeFSP.readFile(NodePath.join(other, "b.tex"), "utf8")).toBe("B");
        gate.resolve();
        await fence;
        expect(await created).toMatchObject({ revision: revision("N") });
      },
      {},
      null,
      (helper) => filePublicationHelperWithout(helper, ["atomicCreateMetadata"]),
    ),
  );
});
