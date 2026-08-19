// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { layer as managedTreeLayer, ManagedTree } from "./ManagedTree.ts";
import { OverleafGitExecutor } from "./OverleafGitExecutor.ts";
import { OverleafStateStore } from "./OverleafStateStore.ts";

const temporaryDirectory = Effect.acquireRelease(
  Effect.promise(() => NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "overleaf-tree-"))),
  (root) => Effect.promise(() => NodeFSP.rm(root, { recursive: true, force: true })),
);

function testLayer(stateRoot: string, listed: string) {
  const executor = OverleafGitExecutor.of({
    gitExecutable: "git",
    execute: (input) =>
      Effect.succeed({
        exitCode: 0,
        stdout: input.args.includes("ls-files") ? listed : "",
        stdoutBytes: new TextEncoder().encode(input.args.includes("ls-files") ? listed : ""),
        stderr: "",
      }),
  });
  const state = OverleafStateStore.of({
    operationDirectory: (operationId: string) => NodePath.join(stateRoot, operationId),
  } as OverleafStateStore["Service"]);
  return managedTreeLayer.pipe(
    Layer.provide(Layer.succeed(OverleafGitExecutor, executor)),
    Layer.provide(Layer.succeed(OverleafStateStore, state)),
    Layer.provide(Layer.succeed(HostProcessPlatform, "win32")),
    Layer.provideMerge(NodeServices.layer),
  );
}

describe("ManagedTree", () => {
  it.effect("does not traverse ignored symlinks or unmanaged directories", () =>
    Effect.gen(function* () {
      const root = yield* temporaryDirectory;
      const outside = yield* temporaryDirectory;
      yield* Effect.promise(async () => {
        await NodeFSP.writeFile(NodePath.join(root, ".gitignore"), "ignored/\n");
        await NodeFSP.writeFile(NodePath.join(root, "main.tex"), "safe\n");
        await NodeFSP.mkdir(NodePath.join(root, "ignored"));
        await NodeFSP.symlink(outside, NodePath.join(root, "ignored", "outside"), "junction");
      });
      const tree = yield* ManagedTree;
      const result = yield* tree.scan({ operationId: "scan", root });
      expect(result.files.map((file) => file.path)).toEqual([".gitignore", "main.tex"]);
    }).pipe(
      Effect.provide(
        testLayer(NodePath.join(NodeOS.tmpdir(), "overleaf-tree-state"), ".gitignore\0main.tex\0"),
      ),
      Effect.scoped,
    ),
  );

  it.effect("rejects a junction selected as a managed path", () =>
    Effect.gen(function* () {
      const root = yield* temporaryDirectory;
      const outside = yield* temporaryDirectory;
      yield* Effect.promise(async () => {
        await NodeFSP.writeFile(NodePath.join(outside, "secret.tex"), "secret\n");
        await NodeFSP.symlink(outside, NodePath.join(root, "linked"), "junction");
      });
      const tree = yield* ManagedTree;
      const failure = yield* tree.scan({ operationId: "scan", root }).pipe(Effect.flip);
      expect(failure.code).toBe("unsafe_tree");
    }).pipe(
      Effect.provide(
        testLayer(NodePath.join(NodeOS.tmpdir(), "overleaf-tree-state"), "linked/secret.tex\0"),
      ),
      Effect.scoped,
    ),
  );
});
