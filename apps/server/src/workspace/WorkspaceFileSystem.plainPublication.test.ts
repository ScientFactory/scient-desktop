// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as Effect from "effect/Effect";
import { describe, expect, it } from "@effect/vitest";
import {
  fileMutationFixture,
  filePublicationHelperWithout,
} from "../scient/workspace/fileExchange.testkit.ts";
import { bytesRevision } from "../scient/workspace/RetainedFileMutation.ts";

const revision = (text: string) => bytesRevision(Buffer.from(text));
/** The Windows helper owns roots and leases but cannot replace or create a file in one step. */
const windowsLike = (helper: string) =>
  filePublicationHelperWithout(helper, [
    "atomicExchange",
    "atomicCreateMetadata",
    "atomicPublicationMetadata",
  ]);
const plain = (body: Parameters<typeof fileMutationFixture>[0]) =>
  fileMutationFixture(body, {}, null, windowsLike);
const leftovers = async (directory: string) =>
  (await NodeFSP.readdir(directory)).filter((name) => name.endsWith(".scient-tmp"));

describe("plain publication when the helper cannot publish atomically", () => {
  it.live("saves changed bytes, keeps permissions and leaves no temporary file", () =>
    plain(async (h) => {
      if (!h.helper) return;
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
      expect((await NodeFSP.stat(target)).mode & 0o777).toBe(0o640);
      expect(await leftovers(h.cwd)).toEqual([]);
      expect(await h.settledRead("main.tex")).toMatchObject({ contents: "C" });
    }),
  );

  it.live("refuses a stale revision without touching the file", () =>
    plain(async (h) => {
      if (!h.helper) return;
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

  it.live("reports a failure before the rename as unchanged, with the system's error", () =>
    plain(async (h) => {
      if (!h.helper) return;
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

  it.live("replays a retried save, converges after a restart and refuses a reused identity", () =>
    plain(async (h) => {
      if (!h.helper) return;
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
      if (!h.helper) return;
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
      if (!h.helper) return;
      await NodeFSP.writeFile(NodePath.join(h.cwd, "main.tex"), "A");
      const before = await h.run(h.methods.getMutationEpoch({ cwd: h.cwd }));
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
    }),
  );
});
