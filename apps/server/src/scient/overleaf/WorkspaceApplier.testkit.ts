// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";
import * as WorkspacePaths from "../../workspace/WorkspacePaths.ts";
import * as WorkspaceEntries from "../../workspace/WorkspaceEntries.ts";
import { WorkspaceFileSystem } from "../../workspace/WorkspaceFileSystem.ts";
import { makeWorkspaceFileMutations } from "../workspace/WorkspaceFileMutations.ts";
import { bytesRevision, type RetainedMutationHooks } from "../workspace/RetainedFileMutation.ts";
import {
  make,
  type ApplierHooks,
  type WorkspaceApplyPlan,
  type WorkspaceApplyResult,
} from "./WorkspaceApplier.ts";
import { fileExchangeTestHelper } from "../workspace/fileExchange.testkit.ts";
const helper = await fileExchangeTestHelper();

export const fixture = Effect.fnUntraced(
  function* (
    body: (h: {
      run: <A, E>(effect: Effect.Effect<A, E>) => Promise<A>;
      root: string;
      cwd: string;
      owner: string;
      files: WorkspaceFileSystem["Service"];
      restart: () => Promise<void>;
      apply: (
        id: string,
        plan?: WorkspaceApplyPlan,
        native?: boolean,
      ) => Promise<WorkspaceApplyResult>;
    }) => Promise<void>,
    hooks: ApplierHooks = {},
    retainedHooks: RetainedMutationHooks = {},
  ) {
    const context = yield* Effect.context<FileSystem.FileSystem | Path.Path>();
    const run = Effect.runPromiseWith(context);
    const fileSystem = yield* FileSystem.FileSystem;
    const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "scient-applier-" });
    const cwd = NodePath.join(root, "paper"),
      owner = NodePath.join(root, "records");
    yield* Effect.promise(() => NodeFSP.mkdir(cwd));
    yield* Effect.promise(() => NodeFSP.mkdir(owner));
    const createFiles = () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem,
          pathService = yield* Path.Path,
          workspacePaths = yield* WorkspacePaths.make;
        const entries = WorkspaceEntries.WorkspaceEntries.of({
          refresh: () => Effect.void,
          browse: () => Effect.die("unused"),
          list: () => Effect.die("unused"),
          listDirectory: () => Effect.die("unused"),
          search: () => Effect.die("unused"),
          searchContents: () => Effect.die("unused"),
        });
        const readFile: WorkspaceFileSystem["Service"]["readFile"] = (input) =>
          Effect.promise(async () => {
            const content = await NodeFSP.readFile(NodePath.join(input.cwd, input.relativePath));
            return {
              relativePath: input.relativePath,
              contents: content.toString(),
              byteLength: content.length,
              truncated: false,
              revision: bytesRevision(content),
            };
          });
        const methods = yield* makeWorkspaceFileMutations({
          fileSystem,
          path: pathService,
          workspacePaths,
          workspaceEntries: entries,
          readFile,
          retainedHooks,
        });
        return WorkspaceFileSystem.of({
          ...methods,
          readFile,
          viewFile: readFile,
          watchFile: () => Stream.empty,
        });
      });
    let files = yield* createFiles();
    let applier = yield* make(hooks).pipe(Effect.provideService(WorkspaceFileSystem, files));
    yield* Effect.promise(() =>
      body({
        run,
        root,
        cwd,
        owner,
        files,
        restart: async () => {
          files = await run(createFiles());
          applier = await run(make(hooks).pipe(Effect.provideService(WorkspaceFileSystem, files)));
        },
        apply: (id, p, native = false) =>
          run(
            applier.apply({
              cwd,
              applicationDirectory: owner,
              id,
              ...(p ? { plan: p } : {}),
              ...(native && helper ? { exchangeHelper: helper } : {}),
            }),
          ),
      }),
    );
  },
  Effect.scoped,
  Effect.provide(NodeServices.layer),
);
