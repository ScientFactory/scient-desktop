// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { WorkspaceFileSystem } from "../../workspace/WorkspaceFileSystem.ts";
import { type RetainedMutationHooks } from "../workspace/RetainedFileMutation.ts";
import {
  make,
  type ApplierHooks,
  type WorkspaceApplyPlan,
  type WorkspaceApplyResult,
} from "./WorkspaceApplier.ts";
import { filePublicationTestHelper } from "../workspace/fileExchange.testkit.ts";
import { makeApplierFiles } from "./WorkspaceApplier.files.testkit.ts";
const helper = await filePublicationTestHelper();

export const fixture = Effect.fnUntraced(
  function* (
    body: (h: {
      run: <A, E>(effect: Effect.Effect<A, E>) => Promise<A>;
      root: string;
      cwd: string;
      owner: string;
      files: WorkspaceFileSystem["Service"];
      restart: () => Promise<void>;
      apply: (id: string, plan?: WorkspaceApplyPlan) => Promise<WorkspaceApplyResult>;
    }) => Promise<void>,
    hooks: ApplierHooks = {},
    retainedHooks: RetainedMutationHooks = {},
  ) {
    const context = yield* Effect.context<FileSystem.FileSystem | Path.Path>();
    const run = Effect.runPromiseWith(context);
    const fileSystem = yield* FileSystem.FileSystem;
    const created = yield* fileSystem.makeTempDirectoryScoped({ prefix: "scient-applier-" });
    const root = yield* Effect.promise(() => NodeFSP.realpath(created));
    const cwd = NodePath.join(root, "paper"),
      owner = NodePath.join(root, "records");
    yield* Effect.promise(() => NodeFSP.mkdir(cwd));
    const createFiles = () => makeApplierFiles({ root, helper, retainedHooks });
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
        apply: (id, p) =>
          run(
            applier.apply({
              cwd,
              applicationDirectory: owner,
              id,
              ...(p ? { plan: p } : {}),
            }),
          ),
      }),
    );
  },
  Effect.scoped,
  Effect.provide(NodeServices.layer),
);
