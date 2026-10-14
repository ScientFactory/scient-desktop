import * as HostProcess from "@t3tools/shared/HostProcess";
// @effect-diagnostics nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeOS from "node:os";
import { afterAll } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as WorkspacePaths from "../../workspace/WorkspacePaths.ts";
import * as WorkspaceEntries from "../../workspace/WorkspaceEntries.ts";
import {
  WorkspaceBinaryFileError,
  WorkspaceFileSystemOperationError,
  type WorkspaceFileSystem,
} from "../../workspace/WorkspaceFileSystem.ts";
import { makeWorkspaceFileMutations } from "./WorkspaceFileMutations.ts";
import {
  bytesRevision,
  directoryIdentity,
  type RetainedMutationHooks,
} from "./RetainedFileMutation.ts";
import {
  ensureNativePrivateRetentionDirectory,
  nativeFilePublicationCapabilities,
} from "./NativeFilePublication.ts";

let compiled: Promise<string | undefined> | undefined;
/** Compile the shipped boundary, never silently reuse a developer's binary or a pathname fallback. */
export function filePublicationTestHelper() {
  return (compiled ??= (async () => {
    const platform = HostProcess.Platform.defaultValue();
    if (platform !== "darwin" && platform !== "linux") return undefined;
    const directory = await NodeFSP.mkdtemp(
      NodePath.join(NodeOS.tmpdir(), "scient-publication-helper-"),
    );
    afterAll(() => NodeFSP.rm(directory, { recursive: true, force: true }));
    const helper = NodePath.join(directory, "scient-file-publication");
    NodeChildProcess.execFileSync("cc", [
      "-O2",
      "-Wall",
      "-Wextra",
      "-Werror",
      "-fstack-protector-strong",
      NodePath.resolve(import.meta.dirname, "../../../../../native/file-exchange/publication.c"),
      NodePath.resolve(
        import.meta.dirname,
        "../../../../../native/file-exchange/publication-posix.c",
      ),
      "-o",
      helper,
    ]);
    return helper;
  })());
}

/** Whether the compiled helper gives this host native publication authority. */
export async function nativePublicationHost() {
  const helper = await filePublicationTestHelper();
  if (helper === undefined) return false;
  const capabilities = await nativeFilePublicationCapabilities(helper);
  return (
    capabilities.strictCurrentRoot &&
    capabilities.publicationLease &&
    capabilities.sharedPublicationLease &&
    capabilities.exclusiveMove &&
    capabilities.exclusiveLink
  );
}

/** Wraps the helper so it reports capabilities as unavailable, as the Windows helper does. */
export async function filePublicationHelperWithout(
  helper: string,
  capabilities: ReadonlyArray<string>,
) {
  const directory = await NodeFSP.mkdtemp(
    NodePath.join(NodeOS.tmpdir(), "scient-publication-wrapper-"),
  );
  afterAll(() => NodeFSP.rm(directory, { recursive: true, force: true }));
  const wrapper = NodePath.join(directory, "scient-file-publication");
  const edits = capabilities.map((name) => `-e 's/"${name}":true/"${name}":false/'`).join(" ");
  await NodeFSP.writeFile(
    wrapper,
    `#!/bin/sh\nif [ "$2" = capabilities ]; then "${helper}" "$@" | sed ${edits}; exit $?; fi\nexec "${helper}" "$@"\n`,
    { mode: 0o755 },
  );
  return wrapper;
}

export const fileMutationFixture = Effect.fnUntraced(
  function* (
    body: (fixture: {
      root: string;
      cwd: string;
      retentionRoot: string;
      helper: string | undefined;
      run: <A, E>(effect: Effect.Effect<A, E>) => Promise<A>;
      methods: Effect.Success<ReturnType<typeof makeWorkspaceFileMutations>>;
      restart: () => Promise<Effect.Success<ReturnType<typeof makeWorkspaceFileMutations>>>;
      settledRead: (
        relativePath: string,
      ) => Promise<Effect.Success<ReturnType<WorkspaceFileSystem["Service"]["readFile"]>>>;
    }) => Promise<void>,
    hooks: RetainedMutationHooks = {},
    retentionLimitBytes: number | null = null,
    wrapHelper?: (helper: string) => Promise<string | undefined>,
  ) {
    const compiledHelper = yield* Effect.promise(filePublicationTestHelper);
    const helper =
      compiledHelper === undefined || wrapHelper === undefined
        ? compiledHelper
        : yield* Effect.promise(() => wrapHelper(compiledHelper));
    const fileSystem = yield* FileSystem.FileSystem,
      path = yield* Path.Path;
    const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "scient-publication-" });
    const canonical = yield* Effect.promise(() => NodeFSP.realpath(root));
    const cwd = NodePath.join(canonical, "paper"),
      retentionRoot = NodePath.join(canonical, "private-retention");
    yield* Effect.promise(() => NodeFSP.mkdir(cwd));
    const workspacePaths = yield* WorkspacePaths.make;
    const workspaceEntries = WorkspaceEntries.WorkspaceEntries.of({
      refresh: () => Effect.void,
      browse: () => Effect.die("unused"),
      list: () => Effect.die("unused"),
      listDirectory: () => Effect.die("unused"),
      search: () => Effect.die("unused"),
      searchContents: () => Effect.die("unused"),
    });
    const readFile: WorkspaceFileSystem["Service"]["readFile"] = (input) =>
      Effect.gen(function* () {
        const resolvedPath = NodePath.join(input.cwd, input.relativePath);
        const file = yield* Effect.tryPromise({
          try: () => NodeFSP.readFile(resolvedPath),
          catch: (cause) =>
            new WorkspaceFileSystemOperationError({
              workspaceRoot: input.cwd,
              relativePath: input.relativePath,
              resolvedPath,
              operationPath: resolvedPath,
              operation: "read",
              cause,
            }),
        });
        const leading = file.subarray(0, 1024 * 1024);
        if (leading.includes(0))
          return yield* new WorkspaceBinaryFileError({
            workspaceRoot: input.cwd,
            relativePath: input.relativePath,
            resolvedPath,
          });
        return {
          relativePath: input.relativePath,
          contents: leading.toString("utf8"),
          byteLength: file.byteLength,
          truncated: file.byteLength > leading.byteLength,
          revision: bytesRevision(leading),
        };
      });
    const create = () =>
      makeWorkspaceFileMutations({
        fileSystem,
        path,
        workspacePaths,
        workspaceEntries,
        readFile,
        ...(helper === undefined ? {} : { nativePublicationHelper: helper }),
        retentionStorageDirectory: retentionRoot,
        retentionLimitBytes,
        retainedHooks: hooks,
        retentionDirectoryFor: async (_root, parent) => {
          if (!helper) throw new Error("Native private retention is unavailable.");
          const identity = await directoryIdentity(parent);
          await ensureNativePrivateRetentionDirectory(helper, retentionRoot);
          return ensureNativePrivateRetentionDirectory(
            helper,
            NodePath.join(retentionRoot, `${identity.dev}-${identity.ino}`),
          );
        },
      });
    const methods = yield* create(),
      context = yield* Effect.context<never>(),
      run = Effect.runPromiseWith(context);
    yield* Effect.promise(() =>
      body({
        root: canonical,
        cwd,
        retentionRoot,
        helper,
        run,
        methods,
        restart: () => run(create()),
        settledRead: (relativePath) =>
          run(
            methods.withSettledFileRead({ cwd, relativePath }, (attention) =>
              readFile({ cwd, relativePath }).pipe(
                Effect.map((result) => ({
                  ...result,
                  ...(attention ? { publicationAttention: attention } : {}),
                })),
              ),
            ),
          ),
      }),
    );
  },
  Effect.scoped,
  Effect.provide(NodeServices.layer),
);
