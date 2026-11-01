// @effect-diagnostics nodeBuiltinImport:off -- Real helper on real folders.
/**
 * A retained record belongs to one file. One that went bad must not take every
 * project's file reads down with it: a kept copy's folder can be gone for good
 * (a deleted app's data) or for now (a disk that isn't plugged in).
 */
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { fileMutationFixture, nativePublicationHost } from "./fileExchange.testkit.ts";

const native = await nativePublicationHost();

const danglingReference = async (retentionRoot: string, target: string) => {
  const folder = NodePath.join(retentionRoot, "1-2", "mutation-gone");
  await NodeFSP.mkdir(folder, { recursive: true, mode: 0o700 });
  await NodeFSP.chmod(retentionRoot, 0o700);
  await NodeFSP.chmod(NodePath.dirname(folder), 0o700);
  await NodeFSP.writeFile(
    NodePath.join(folder, "reference.json"),
    JSON.stringify({
      version: 1,
      recordDirectory: NodePath.join(retentionRoot, "gone", "files", "step-0"),
      target,
      requestedPath: target,
      mutationId: "overleaf-gone",
    }),
  );
};

describe.skipIf(!native)("a record whose folder is gone", () => {
  it.live("doesn't stop another project's file reads", () =>
    fileMutationFixture(async (h) => {
      await danglingReference(h.retentionRoot, NodePath.join(h.root, "elsewhere", "main.tex"));
      expect(
        await h.run(
          h.methods.withSettledWorkspaceRead({ cwd: h.cwd }, () => Effect.succeed("read")),
        ),
      ).toBe("read");
    }),
  );

  it.live("doesn't stop reads, or a save, in its own project", () =>
    fileMutationFixture(async (h) => {
      const target = NodePath.join(h.cwd, "main.tex");
      await NodeFSP.writeFile(target, "before");
      await danglingReference(h.retentionRoot, target);
      expect(
        await h.run(
          h.methods.withSettledWorkspaceRead({ cwd: h.cwd }, () => Effect.succeed("read")),
        ),
      ).toBe("read");
      await h.run(h.methods.writeFile({ cwd: h.cwd, relativePath: "main.tex", contents: "after" }));
      expect(await NodeFSP.readFile(target, "utf8")).toBe("after");
    }),
  );
});
