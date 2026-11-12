// @effect-diagnostics nodeBuiltinImport:off -- The guard is tested against a real project folder.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { describe, expect, it } from "@effect/vitest";

import { resolveScientProjectFile } from "./projectFiles.ts";

describe("resolveScientProjectFile", () => {
  it("refuses .scient paths, however they are written or linked, unless storage is allowed", async () => {
    const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "scient-project-files-"));
    try {
      await NodeFSP.mkdir(NodePath.join(root, ".scient"));
      await NodeFSP.mkdir(NodePath.join(root, "notes"));
      await NodeFSP.writeFile(NodePath.join(root, ".scient", "private.bib"), "");
      await NodeFSP.symlink(
        NodePath.join(root, ".scient"),
        NodePath.join(root, "alias"),
        "junction",
      );
      const options = { extensions: [".bib"], description: "bibliography file" };

      for (const path of [
        ".scient/private.bib",
        "notes/../.SCIENT/private.bib",
        "alias/private.bib",
      ]) {
        await expect(resolveScientProjectFile(root, path, options)).rejects.toThrow(
          "outside .scient",
        );
      }
      await expect(
        resolveScientProjectFile(root, "alias/private.bib", {
          ...options,
          allowScientStorage: true,
        }),
      ).resolves.toMatchObject({ relativePath: ".scient/private.bib" });
    } finally {
      await NodeFSP.rm(root, { recursive: true, force: true });
    }
  });
});
