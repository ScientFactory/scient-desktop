// @effect-diagnostics nodeBuiltinImport:off -- Real helper on real folders.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import { describe, expect, it } from "@effect/vitest";

import { bytesRevision } from "./RetainedFileMutation.ts";
import { fileMutationFixture, nativePublicationHost } from "./fileExchange.testkit.ts";

const native = await nativePublicationHost();
const revision = (text: string) => bytesRevision(Buffer.from(text));

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
