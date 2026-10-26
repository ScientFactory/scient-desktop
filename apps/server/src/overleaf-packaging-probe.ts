// @effect-diagnostics globalConsole:off globalConsoleInEffect:off preferSchemaOverJson:off
// @effect-diagnostics nodeBuiltinImport:off -- Installed-artifact qualification entry; no network listener.
import * as NodeAssert from "node:assert/strict";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as ServerConfig from "./config.ts";
import * as KnownWorkspaces from "./workspace/KnownWorkspaces.ts";
import * as WorkspaceEntries from "./workspace/WorkspaceEntries.ts";
import * as WorkspacePaths from "./workspace/WorkspacePaths.ts";
import * as Files from "./workspace/WorkspaceFileSystem.ts";
import { resolveNativeFilePublicationHelperPath } from "./scient/workspace/NativeFilePublication.ts";
import { platformFileIdentity } from "./scient/workspace/PlatformFileIdentity.ts";
import { CheckoutBarrier, makeCheckoutBarrier } from "./scient/workspace/CheckoutBarrier.ts";
import * as Git from "./scient/overleaf/OverleafGitExecutor.ts";
import * as Repositories from "./scient/overleaf/OverleafRepository.ts";
import * as Store from "./scient/overleaf/OverleafStateStore.ts";
import * as Coordinator from "./scient/overleaf/OverleafCoordinator.ts";
import * as Applier from "./scient/overleaf/WorkspaceApplier.ts";
import { makeOverleafConnections } from "./scient/overleaf/OverleafConnections.ts";

const [profile, phase, installedHelper] = process.argv.slice(2);
NodeAssert.ok(profile && ["connect", "restart", "refuse"].includes(phase!));
const root = await NodeFSP.realpath(profile);
const helper = await resolveNativeFilePublicationHelperPath(installedHelper);
if (phase === "refuse") {
  NodeAssert.equal(
    helper,
    undefined,
    "Missing installed helper must refuse without discovery fallback",
  );
  console.log("Overleaf helper-unavailable refusal passed.");
} else {
  NodeAssert.ok(helper, "Installed publication helper unavailable");
  if (installedHelper !== undefined)
    NodeAssert.equal(
      await resolveNativeFilePublicationHelperPath(),
      helper,
      "Bootstrap and default discovery must use the same installed helper",
    );
  const checkout = NodePath.join(root, "workspace");
  const folder = NodePath.join(checkout, "paper");
  const stateRoot = NodePath.join(root, "state/overleaf");
  const remote = NodePath.join(root, "remote.git");
  const collaborator = NodePath.join(root, "collaborator.git");
  const token = new Uint8Array();
  const volumeUuid = (path: string) => platformFileIdentity.volume(path, helper);
  const program = Effect.gen(function* () {
    const git = yield* Git.make({
      runtimeRoot: NodePath.join(root, "git-runtime"),
      allowLocalProtocols: true,
    });
    const repos = yield* Repositories.make.pipe(
      Effect.provideService(Git.OverleafGitExecutor, git),
    );
    const store = yield* Store.make({ root: stateRoot, publicationHelper: helper, volumeUuid });
    const reservations = Coordinator.makeOverleafReservations();
    const connections = yield* makeOverleafConnections({
      stateRoot,
      environmentId: "packaging",
      publicationHelper: helper,
      volumeUuid,
      reservations,
      gitUrl: () => remote,
    }).pipe(
      Effect.provideService(Store.OverleafStateStore, store),
      Effect.provideService(Repositories.OverleafRepository, repos),
    );
    const collaborate = Effect.fn("packaging.collaborate")(function* (
      contents: Record<string, string>,
    ) {
      const prior = yield* repos
        .fetch({ repo: collaborator, branch: "main", token })
        .pipe(Effect.option);
      const entries = [];
      for (const [path, content] of Object.entries(contents))
        entries.push({
          path,
          oid: yield* repos.writeBlob({ repo: collaborator, bytes: Buffer.from(content) }),
        });
      const commit = yield* repos.commit({
        repo: collaborator,
        tree: yield* repos.writeTree({ repo: collaborator, entries }),
        parents: Option.isSome(prior) ? [prior.value.commit] : [],
        message: "packaging collaborator",
      });
      NodeAssert.equal(
        (yield* repos.push({ repo: collaborator, branch: "main", token, commit }))._tag,
        "accepted",
      );
    });
    let connectionId: string;
    if (phase === "connect") {
      yield* Effect.promise(() => NodeFSP.mkdir(folder, { recursive: true }));
      yield* git.execute({ cwd: root, args: ["init", "-q", "--bare", "-b", "main", remote] });
      yield* git.execute({ cwd: checkout, args: ["init", "-q"] });
      yield* repos.initialize({ repo: collaborator, gitUrl: remote });
      yield* collaborate({ "main.tex": "baseline\n", "remote.tex": "baseline\n" });
      const connected = yield* connections.connect({
        authority: { bindingId: "packaging", authorityGeneration: 1, scopeRevision: 1 },
        checkoutRoot: checkout,
        folder: "paper",
        create: false,
        projectId: "0123456789abcdef01234567",
        token,
        requestId: "connect",
        stillAuthorized: Effect.succeed(true),
        owns: () => Effect.succeed(true),
      });
      NodeAssert.equal(connected._tag, "connected", JSON.stringify(connected));
      if (connected._tag !== "connected") throw new Error("Connection refused");
      connectionId = connected.connection.connectionId;
      yield* Effect.promise(() =>
        NodeFSP.writeFile(NodePath.join(root, "connection"), connectionId),
      );
    } else {
      connectionId = yield* Effect.promise(() =>
        NodeFSP.readFile(NodePath.join(root, "connection"), "utf8"),
      );
      const read = yield* store.readConnection(connectionId);
      NodeAssert.equal(read._tag, "ready");
      yield* Effect.promise(async () => {
        NodeAssert.equal(
          await NodeFSP.readFile(NodePath.join(folder, "main.tex"), "utf8"),
          "baseline\n",
        );
        await NodeFSP.writeFile(NodePath.join(folder, "main.tex"), "local change\n");
      });
      yield* collaborate({ "main.tex": "baseline\n", "remote.tex": "remote change\n" });
    }
    const config = ServerConfig.layerTest(checkout, NodePath.join(root, "state"), {
      filePublicationHelperPath: helper,
      filePublicationRetentionRoot: NodePath.join(root, "retention"),
    });
    const entries = WorkspaceEntries.WorkspaceEntries.of({
      refresh: Effect.fn("WorkspaceEntries.WorkspaceEntries.refresh")(() => Effect.void),
      browse: Effect.fn("WorkspaceEntries.WorkspaceEntries.browse")(() => Effect.die("unused")),
      list: Effect.fn("WorkspaceEntries.WorkspaceEntries.list")(() => Effect.die("unused")),
      listIgnoredFiles: Effect.fn("WorkspaceEntries.WorkspaceEntries.listIgnoredFiles")(() =>
        Effect.die("unused"),
      ),
      listDirectory: Effect.fn("WorkspaceEntries.WorkspaceEntries.listDirectory")(() =>
        Effect.die("unused"),
      ),
      search: Effect.fn("WorkspaceEntries.WorkspaceEntries.search")(() => Effect.die("unused")),
      searchContents: Effect.fn("WorkspaceEntries.WorkspaceEntries.searchContents")(() =>
        Effect.die("unused"),
      ),
    });
    const files = yield* Files.make.pipe(
      Effect.provide([config, WorkspacePaths.layer]),
      Effect.provideService(WorkspaceEntries.WorkspaceEntries, entries),
      Effect.provideService(KnownWorkspaces.KnownWorkspaces, {
        contains: (path) => Effect.succeed(path === checkout || path.startsWith(folder)),
        assertContains: (path) =>
          path === checkout || path.startsWith(folder)
            ? Effect.void
            : Effect.fail(new KnownWorkspaces.UnknownWorkspaceError({ cwd: path })),
      }),
    );
    const applier = yield* Applier.make().pipe(
      Effect.provideService(Files.WorkspaceFileSystem, files),
    );
    const coordinator = yield* Coordinator.make({
      stateRoot,
      publicationHelper: helper,
      volumeUuid,
      reservations,
      gitUrl: () => remote,
      fetchRemote: ({ repo }) => repos.fetch({ repo, branch: "main", token }),
      remoteHead: ({ repo }) => repos.remoteHead({ repo, branch: "main", token }),
      pushRemote: ({ repo, commit }) => repos.push({ repo, commit, branch: "main", token }),
    }).pipe(
      Effect.provideService(Store.OverleafStateStore, store),
      Effect.provideService(Repositories.OverleafRepository, repos),
      Effect.provideService(Applier.WorkspaceApplier, applier),
      Effect.provideService(CheckoutBarrier, makeCheckoutBarrier()),
    );
    const prepared = yield* coordinator.prepare({ connectionId });
    NodeAssert.equal(prepared._tag, "review", JSON.stringify(prepared));
    if (prepared._tag !== "review") throw new Error("Review refused");
    const result = yield* coordinator.confirm({
      connectionId,
      requestId: `${phase}-sync`,
      reviewId: prepared.review.id,
      digest: prepared.review.digest,
      acknowledgements: prepared.review.binding.acknowledgements,
    });
    NodeAssert.equal(result._tag, "applied", JSON.stringify(result));
    if (result._tag === "applied") {
      NodeAssert.equal(result.adopted.outcome, "complete");
      NodeAssert.equal(result.publication._tag, phase === "connect" ? "none" : "accepted");
    }
    const recorded = yield* store.readConnection(connectionId);
    NodeAssert.equal(recorded._tag, "ready");
    if (recorded._tag === "ready") {
      NodeAssert.equal(recorded.document.activeApply, null);
      NodeAssert.equal(recorded.document.completedSyncCount, phase === "connect" ? 1 : 2);
      if (phase === "restart")
        NodeAssert.ok(
          recorded.document.retention.copies.length > 0,
          "The native replacement must preserve displaced bytes",
        );
    }
    const expected =
      phase === "connect"
        ? { "main.tex": "baseline\n", "remote.tex": "baseline\n" }
        : { "main.tex": "local change\n", "remote.tex": "remote change\n" };
    const head = yield* repos.fetch({ repo: collaborator, branch: "main", token });
    for (const entry of yield* repos.readTree({ repo: collaborator, tree: head.tree })) {
      const content = yield* repos.readBlob({ repo: collaborator, oid: entry.oid, maxBytes: 1024 });
      NodeAssert.equal(
        Buffer.from(content).toString(),
        expected[entry.path as keyof typeof expected],
      );
    }
    yield* Effect.promise(async () => {
      for (const [name, content] of Object.entries(expected))
        NodeAssert.equal(await NodeFSP.readFile(NodePath.join(folder, name), "utf8"), content);
    });
    console.log(
      JSON.stringify({ overleaf: phase, helper, executable: process.execPath, passed: true }),
    );
  });
  await Effect.runPromise(program.pipe(Effect.scoped, Effect.provide(NodeServices.layer)));
}
