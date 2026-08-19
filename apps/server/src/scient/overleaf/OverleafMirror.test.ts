// @effect-diagnostics nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeProcess from "node:process";
import * as NodeUtil from "node:util";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { layer as managedTreeLayer } from "./ManagedTree.ts";
import { layer as executorLayer } from "./OverleafGitExecutor.ts";
import {
  layer as mirrorLayer,
  OverleafMirror,
  parseRemoteBranchAdvertisement,
} from "./OverleafMirror.ts";
import { OverleafStateStore } from "./OverleafStateStore.ts";

const execFile = NodeUtil.promisify(NodeChildProcess.execFile);
const temporaryDirectory = Effect.acquireRelease(
  Effect.promise(() => NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "overleaf-mirror-"))),
  (root) => Effect.promise(() => NodeFSP.rm(root, { recursive: true, force: true })),
);

function liveMirrorLayer(root: string) {
  const state = OverleafStateStore.of({
    runtimeRoot: NodePath.join(root, "runtime"),
    newId: Effect.sync(() => NodeCrypto.randomUUID()),
    connectionDirectory: (connectionId: string) => NodePath.join(root, "connections", connectionId),
    operationDirectory: (operationId: string) => NodePath.join(root, "operations", operationId),
    markAccountValidated: () => Effect.void,
  } as unknown as OverleafStateStore["Service"]);
  const stateLayer = Layer.succeed(OverleafStateStore, state);
  const platformLayer = Layer.succeed(
    HostProcessPlatform,
    NodeProcess.env.OS === "Windows_NT" ? "win32" : "linux",
  );
  const gitLayer = executorLayer.pipe(
    Layer.provide(stateLayer),
    Layer.provide(platformLayer),
    Layer.provideMerge(NodeServices.layer),
  );
  const treeLayer = managedTreeLayer.pipe(
    Layer.provide(gitLayer),
    Layer.provide(stateLayer),
    Layer.provide(platformLayer),
    Layer.provideMerge(NodeServices.layer),
  );
  return mirrorLayer.pipe(
    Layer.provide(gitLayer),
    Layer.provide(treeLayer),
    Layer.provide(stateLayer),
    Layer.provideMerge(NodeServices.layer),
  );
}

async function git(cwd: string, ...args: string[]): Promise<string> {
  const result = await execFile("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "" },
  });
  return result.stdout.trim();
}

describe("OverleafMirror", () => {
  it("discovers current main and legacy master Overleaf branches", () => {
    expect(
      parseRemoteBranchAdvertisement(
        "ref: refs/heads/main\tHEAD\n0123456789abcdef0123456789abcdef01234567\tHEAD\n0123456789abcdef0123456789abcdef01234567\trefs/heads/main\n",
      ),
    ).toBe("main");
    expect(
      parseRemoteBranchAdvertisement(
        "0123456789abcdef0123456789abcdef01234567\trefs/heads/master\n",
      ),
    ).toBe("master");
    expect(
      parseRemoteBranchAdvertisement(
        "0123456789abcdef0123456789abcdef01234567\trefs/heads/main\n89abcdef0123456789abcdef0123456789abcdef\trefs/heads/master\n",
      ),
    ).toBeNull();
  });

  it.effect("rejects an existing private mirror whose origin does not match the connection", () =>
    Effect.gen(function* () {
      const root = yield* temporaryDirectory;
      const cwd = NodePath.join(root, "mirror");
      yield* Effect.promise(async () => {
        await NodeFSP.mkdir(cwd, { recursive: true });
        await git(cwd, "init", "--initial-branch=master");
        await git(cwd, "remote", "add", "origin", "https://git.overleaf.com/wrong");
      });
      const mirror = yield* OverleafMirror;
      const failure = yield* mirror
        .initialize({
          operationId: NodeCrypto.randomUUID(),
          connectionId: NodeCrypto.randomUUID(),
          cwd,
          gitUrl: "https://git.overleaf.com/0123456789abcdef01234567",
        })
        .pipe(Effect.flip);
      expect(failure.code).toBe("corrupt_state");
    }).pipe(Effect.provide(liveMirrorLayer(NodeOS.tmpdir())), Effect.scoped),
  );

  it.effect("detects a historical file revert even when the file is renamed", () =>
    Effect.gen(function* () {
      const root = yield* temporaryDirectory;
      const cwd = NodePath.join(root, "mirror");
      const oldText = `${"shared paragraph\n".repeat(20)}old conclusion\n`;
      const currentText = `${"shared paragraph\n".repeat(20)}current conclusion\n`;
      const revisions = yield* Effect.promise(async () => {
        await NodeFSP.mkdir(cwd, { recursive: true });
        await git(cwd, "init", "--initial-branch=master");
        await git(cwd, "config", "user.name", "Human Author");
        await git(cwd, "config", "user.email", "human@example.com");
        await NodeFSP.writeFile(NodePath.join(cwd, "chapter.tex"), oldText);
        await git(cwd, "add", "chapter.tex");
        await git(cwd, "commit", "-m", "old");
        await NodeFSP.writeFile(NodePath.join(cwd, "chapter.tex"), currentText);
        await git(cwd, "commit", "-am", "current");
        await git(cwd, "update-ref", "refs/remotes/origin/main", "HEAD");
        const remoteHead = await git(cwd, "rev-parse", "refs/remotes/origin/main");
        await git(cwd, "mv", "chapter.tex", "renamed.tex");
        await NodeFSP.writeFile(NodePath.join(cwd, "renamed.tex"), oldText);
        await git(cwd, "add", "-A");
        await git(cwd, "commit", "-m", "renamed revert");
        return { candidate: await git(cwd, "rev-parse", "HEAD"), remoteHead };
      });
      const mirror = yield* OverleafMirror;
      const review = yield* mirror.review({
        operationId: NodeCrypto.randomUUID(),
        cwd,
        branch: "main",
        connection: {
          connectionId: NodeCrypto.randomUUID(),
          accountId: NodeCrypto.randomUUID(),
          label: "Paper",
          workspaceRoot: root,
          relativeFolder: "",
          projectUrl: "https://www.overleaf.com/project/0123456789abcdef01234567",
          gitUrl: "https://git.overleaf.com/0123456789abcdef01234567",
          host: "git.overleaf.com",
          branch: "main",
          commitPolicy: { kind: "neutral" },
          suppressRenameWarning: true,
          state: "operation_active",
          remoteBaselineCommit: revisions.remoteHead,
          lastConvergedCommit: null,
          localAhead: false,
          localOnlyCompanions: [],
          lastSyncedAtEpochMs: null,
          workspaceBaselineManifest: { files: [], totalBytes: 0 },
          pendingRemoteCommit: null,
          activeOperationId: null,
        },
        candidateCommit: revisions.candidate,
        candidateManifest: { files: [], totalBytes: 0 },
      });
      expect(review.changes).toContainEqual({
        kind: "renamed",
        oldPath: "chapter.tex",
        path: "renamed.tex",
        similarity: expect.any(Number),
      });
      expect(review.warnings).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ kind: "historical_revert", paths: ["renamed.tex"] }),
        ]),
      );
    }).pipe(Effect.provide(liveMirrorLayer(NodeOS.tmpdir())), Effect.scoped),
  );
});
