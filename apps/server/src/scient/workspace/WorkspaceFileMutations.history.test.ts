// @effect-diagnostics nodeBuiltinImport:off -- Real helper on real folders.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import { describe, expect, it } from "@effect/vitest";

import { bytesRevision } from "./RetainedFileMutation.ts";
import { fileMutationFixture, nativePublicationHost } from "./fileExchange.testkit.ts";

const native = await nativePublicationHost();
const revision = (text: string) => bytesRevision(Buffer.from(text));

it.live("keeps the exact preceding notebook bytes after an immediate guarded save", () =>
  fileMutationFixture(async (h) => {
    const files = await h.restart({ nativeSaves: false });
    const target = { cwd: h.cwd, relativePath: "study.ipynb" };
    const original = Buffer.from("before autosave");
    const edited = Buffer.from("current notebook with saved outputs\r\n");
    await NodeFSP.writeFile(NodePath.join(h.cwd, target.relativePath), original);
    await h.run(
      files.writeBinaryFile({
        ...target,
        bytes: edited,
        expectedRevision: bytesRevision(original),
      }),
    );
    await h.run(
      files.writeBinaryFile({
        ...target,
        bytes: Buffer.from("fresh notebook outputs"),
        expectedRevision: bytesRevision(edited),
        keepPreviousVersion: true,
      }),
    );
    const { versions } = await h.run(files.listFileVersions(target));
    const recovery = versions.find((entry) => entry.revision === bytesRevision(edited));
    expect(recovery).toBeDefined();
    expect(await NodeFSP.readFile(recovery!.retainedPath)).toEqual(edited);
  }),
);

describe.skipIf(!native)("file history on plain saves", () => {
  it.live("keeps what a sync wrote when the editor saves over it at once", () =>
    fileMutationFixture(async (h) => {
      const files = await h.restart({ nativeSaves: false });
      await NodeFSP.writeFile(NodePath.join(h.cwd, "main.tex"), "base");
      const retentionDirectory = await h.run(
        files.prepareRetainedDirectory({
          cwd: h.cwd,
          retentionDirectory: NodePath.join(h.retentionRoot, "sync"),
        }),
      );
      await h.run(
        files.replaceFileRetained({
          cwd: h.cwd,
          relativePath: "main.tex",
          retentionDirectory,
          id: "step-0",
          expectedRevision: revision("base"),
          bytes: Buffer.from("synced"),
        }),
      );
      await h.run(
        files.writeFile({
          cwd: h.cwd,
          relativePath: "main.tex",
          contents: "edited",
          expectedRevision: revision("synced"),
        }),
      );
      const { versions } = await h.run(
        files.listFileVersions({ cwd: h.cwd, relativePath: "main.tex" }),
      );
      expect(versions.map((version) => version.revision)).toContain(revision("synced"));
    }),
  );
});
