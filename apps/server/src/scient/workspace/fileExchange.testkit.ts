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
import * as Queue from "effect/Queue";
import * as WorkspacePaths from "../../workspace/WorkspacePaths.ts";
import * as WorkspaceEntries from "../../workspace/WorkspaceEntries.ts";
import {
  WorkspaceBinaryFileError,
  WorkspaceFileSystemOperationError,
  type WorkspaceFileSystem,
} from "../../workspace/WorkspaceFileSystem.ts";
import {
  makeWorkspaceFileMutations,
  type WorkspacePublicationEvent,
} from "./WorkspaceFileMutations.ts";
import {
  bytesRevision,
  directoryIdentity,
  type RetainedMutationHooks,
} from "./RetainedFileMutation.ts";
import { buildFilePublicationHelper, builtFromThisCheckout } from "./filePublicationTestBuild.ts";
import { platformFileIdentity } from "./PlatformFileIdentity.ts";
import {
  closeNativeHelperServers,
  ensureNativePrivateRetentionDirectory,
  nativeFilePublicationCapabilities,
  hasNativeFileAuthority,
} from "./NativeFilePublication.ts";

const compiled = new Map<boolean, Promise<string | undefined>>();
const PROVIDED = {
  false: "SCIENT_FILE_PUBLICATION_HELPER",
  true: "SCIENT_FILE_PUBLICATION_PROBE_HELPER",
} as const;
/**
 * The shipped boundary, compiled once per test file; a CI job passes its one build in the
 * environment. Never a developer's binary, a pathname fallback or a build of older sources.
 */
export function filePublicationTestHelper() {
  return compileFilePublicationTestHelper(false);
}

/** Probe-only lock receipts keep real subprocess contention tests independent of a clock. */
export function filePublicationProbeHelper() {
  return compileFilePublicationTestHelper(true);
}

function compileFilePublicationTestHelper(probe: boolean) {
  const cached = compiled.get(probe);
  if (cached) return cached;
  const building = (async () => {
    const platform = HostProcess.Platform.defaultValue();
    if (platform !== "darwin" && platform !== "linux" && platform !== "win32") return undefined;
    const provided = process.env[PROVIDED[`${probe}`]];
    let helper: string;
    if (provided !== undefined && builtFromThisCheckout(provided, probe)) {
      helper = provided;
      afterAll(closeNativeHelperServers);
    } else {
      const directory = await NodeFSP.realpath(
        await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "scient-publication-helper-")),
      );
      // A running helper locks its binary on Windows.
      afterAll(async () => {
        await closeNativeHelperServers();
        await NodeFSP.rm(directory, { recursive: true, force: true });
      });
      helper = buildFilePublicationHelper(directory, probe);
    }
    if (platform === "win32" && !probe) {
      process.env.SCIENT_FILE_PUBLICATION_HELPER = helper;
      // Windows Server defaults elevated creations to Administrators; fixtures exercise user-owned files.
      const bootstrap = await compileFilePublicationTestHelper(true);
      const owner = JSON.parse(
        NodeChildProcess.execFileSync(
          bootstrap!,
          ["--windows=1", "default-owner", String(process.pid)],
          { encoding: "utf8" },
        ),
      );
      if (owner.code !== 0) throw new Error(`Fixture default-owner setup refused (${owner.code}).`);
    }
    return helper;
  })();
  compiled.set(probe, building);
  return building;
}

/** Whether the compiled helper gives this host native publication authority. */
export async function nativePublicationHost() {
  const helper = await filePublicationTestHelper();
  if (helper === undefined) return false;
  const capabilities = await nativeFilePublicationCapabilities(helper);
  const admitted =
    hasNativeFileAuthority(capabilities) &&
    capabilities.publicationLease &&
    capabilities.sharedPublicationLease &&
    capabilities.exclusiveMove &&
    capabilities.exclusiveLink;
  if (HostProcess.Platform.defaultValue() === "linux" && !admitted)
    throw new Error(
      "Linux publication suites must run: Landlock ABI 3 and the native helper are required.",
    );
  return admitted;
}

/**
 * Whether the helper gives what plain saves and Overleaf applies use it for here: private
 * step folders and folder identity. Linux CI must run these suites, so there it throws.
 */
export async function privateFoldersAndIdentityHost() {
  const helper = await filePublicationTestHelper();
  let admitted = false;
  if (helper !== undefined) {
    const scratch = await NodeFSP.realpath(
      await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "scient-helper-gate-")),
    );
    try {
      admitted =
        (await ensureNativePrivateRetentionDirectory(
          helper,
          NodePath.join(scratch, "private"),
        ).then(
          () => true,
          () => false,
        )) &&
        (await platformFileIdentity
          .directory(scratch, async () => "0A1B2C3D-0000-4000-8000-000000000001", helper)
          .catch(() => null)) !== null;
    } finally {
      await NodeFSP.rm(scratch, { recursive: true, force: true });
    }
  }
  if (HostProcess.Platform.defaultValue() === "linux" && !admitted)
    throw new Error(
      "Linux plain-save suites must run: the helper's private folders and folder identity are required.",
    );
  return admitted;
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
      restart: (options?: {
        readonly nativeSaves: boolean;
      }) => Promise<Effect.Success<ReturnType<typeof makeWorkspaceFileMutations>>>;
      publication: {
        claimed: (mutationId: string, holders?: number) => Promise<void>;
        waiting: (root: string) => Promise<void>;
        close: () => Promise<boolean>;
      };
      settledRead: (
        relativePath: string,
      ) => Promise<Effect.Success<ReturnType<WorkspaceFileSystem["Service"]["readFile"]>>>;
    }) => Promise<void>,
    hooks: RetainedMutationHooks = {},
    retentionLimitBytes: number | null = null,
    wrapHelper?: (helper: string) => Promise<string | undefined>,
    // A suite with its own helper tests plain saves; the others test the native publication.
    nativeSavesByDefault = wrapHelper === undefined,
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
    const workspacePaths = yield* WorkspacePaths.WorkspacePaths.pipe(
      Effect.provide(WorkspacePaths.layer),
    );
    const workspaceEntries = WorkspaceEntries.WorkspaceEntries.of({
      refresh: () => Effect.void,
      browse: () => Effect.die("unused"),
      list: () => Effect.die("unused"),
      listIgnoredFiles: () => Effect.die("unused"),
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
    const publicationEvents = yield* Effect.acquireRelease(
      Queue.unbounded<WorkspacePublicationEvent>(),
      Queue.shutdown,
    );
    const create = (nativeSaves = nativeSavesByDefault) =>
      makeWorkspaceFileMutations({
        fileSystem,
        path,
        workspacePaths,
        workspaceEntries,
        readFile,
        ...(helper === undefined ? {} : { nativePublicationHelper: helper }),
        resolveRetentionStorageDirectory: async () => retentionRoot,
        retentionLimitBytes,
        fileHistoryDirectory: NodePath.join(canonical, "file-history"),
        nativeSaves,
        retainedHooks: hooks,
        publicationEvents,
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
    // Earlier unrelated receipts must not satisfy a later ownership wait.
    const awaitPublication = Effect.fn("FileMutationFixture.awaitPublication")(function* (
      matches: (event: WorkspacePublicationEvent) => boolean,
    ) {
      for (;;) {
        const event = yield* Queue.take(publicationEvents);
        if (matches(event)) return;
      }
    });
    yield* Effect.promise(() =>
      body({
        root: canonical,
        cwd,
        retentionRoot,
        helper,
        run,
        methods,
        restart: (options) => run(create(options?.nativeSaves)),
        publication: {
          claimed: (mutationId, holders = 1) =>
            run(
              awaitPublication(
                (event) =>
                  event._tag === "Claimed" &&
                  event.mutationId === mutationId &&
                  event.holders === holders,
              ),
            ),
          waiting: (root) =>
            run(awaitPublication((event) => event._tag === "Waiting" && event.root === root)),
          close: () => run(Queue.shutdown(publicationEvents)),
        },
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
