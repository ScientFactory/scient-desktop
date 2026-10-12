import { describe, expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  WS_METHODS,
  ProjectWriteFileError,
  ProjectReadFileError,
  type ProjectWriteFileInput,
  type ProjectWriteFileResult,
  type ProjectRenameFileResult,
  type ProjectDeleteFileResult,
  type ProjectReadFileInput,
  type ProjectReadFileResult,
  type ProjectFileWatchEvent,
  AuthFilesystemReadScope,
  AuthFilesystemWriteScope,
  ProjectId,
  ThreadId,
  type AuthSessionState,
  type ScopedProjectRef,
} from "@t3tools/contracts";
import { vi } from "vite-plus/test";
import * as Crypto from "effect/Crypto";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { Atom, AtomRegistry, AsyncResult } from "effect/reactivity";
import { RpcClientError } from "effect/rpc";
import * as Socket from "effect/socket/Socket";
import * as Queue from "effect/Queue";

import {
  AVAILABLE_CONNECTION_STATE,
  PrimaryConnectionTarget,
  type NetworkStatus,
  type PreparedConnection,
} from "../connection/model.ts";
import type { ConnectionCatalogEntry } from "../connection/catalog.ts";
import { EnvironmentRegistry } from "../connection/registry.ts";
import { EnvironmentSupervisor } from "../connection/supervisor.ts";
import type { WsRpcProtocolClient } from "../rpc/protocol.ts";
import type { RpcSession } from "../rpc/session.ts";
import type { EnvironmentProject } from "./models.ts";
import { createProjectEnvironmentAtoms, projectFileOperationKey } from "./projectCommands.ts";
const ENVIRONMENT_ID = EnvironmentId.make("environment-1");
vi.mock("./session.ts", () => ({
  createEnvironmentSessionAtoms: () => ({ sessionStateAtom: sessions }),
}));
const sessions = Atom.family((_id: EnvironmentId) =>
  Atom.make<AsyncResult.AsyncResult<AuthSessionState>>(
    AsyncResult.success({
      authenticated: true,
      auth: {
        policy: "remote-reachable" as const,
        bootstrapMethods: [],
        sessionMethods: [],
        sessionCookieName: "test",
      },
      scopes: [AuthFilesystemReadScope, AuthFilesystemWriteScope],
      permissions: [AuthFilesystemReadScope, AuthFilesystemWriteScope],
    }),
  ),
);
const PROJECT_ID = ProjectId.make("scratch");
const PROJECT = {
  id: PROJECT_ID,
  environmentId: ENVIRONMENT_ID,
  workspaceRoot: "/scratch",
} as EnvironmentProject;

const makeMetadataHarness = Effect.fn("TestProjectCommands.makeMetadataHarness")(function* () {
  const metadataRequests: string[][] = [];
  const file = { byteLength: 5, path: "/repo/foo" };
  const fileEvents = yield* Queue.unbounded<ProjectFileWatchEvent>();
  const readResponse = { wait: Effect.void as Effect.Effect<void> };
  const supervisor = EnvironmentSupervisor.of({
    target: { environmentId: ENVIRONMENT_ID },
    session: yield* SubscriptionRef.make(
      Option.some({
        client: {
          [WS_METHODS.projectsEnsureScratch]: () => Effect.succeed({ projectId: PROJECT_ID }),
          [WS_METHODS.projectsReadFile]: () =>
            Effect.gen(function* () {
              const byteLength = file.byteLength;
              yield* readResponse.wait;
              return { relativePath: "foo", byteLength, contents: "old", truncated: false };
            }),
          [WS_METHODS.projectsWriteFile]: () =>
            Effect.sync(() => {
              file.byteLength = 10;
              return { relativePath: "foo" };
            }),
          [WS_METHODS.projectsRenameFile]: (input: {
            cwd: string;
            destinationRelativePath: string;
          }) =>
            Effect.sync(() => {
              file.path = `${input.cwd}/${input.destinationRelativePath}`;
              return {
                relativePath: "foo",
                destinationRelativePath: input.destinationRelativePath,
              };
            }),
          [WS_METHODS.projectsSubscribeFileChanges]: () => Stream.fromQueue(fileEvents),
          [WS_METHODS.filesystemGetMetadata]: (input: { paths: string[] }) =>
            Effect.sync(() => {
              metadataRequests.push(input.paths);
              return {
                entries: input.paths.map((path) =>
                  path === file.path || path === "/repo/./foo"
                    ? { kind: "file" as const, byteLength: file.byteLength }
                    : null,
                ),
              };
            }),
        },
      } as unknown as RpcSession),
    ),
    state: yield* SubscriptionRef.make({
      ...AVAILABLE_CONNECTION_STATE,
      phase: "connected" as const,
    }),
  } as EnvironmentSupervisor["Service"]);
  const runtime = Atom.runtime(
    Layer.mergeAll(
      Layer.succeed(EnvironmentRegistry, {
        run: (_environmentId, effect) =>
          Effect.provideService(effect, EnvironmentSupervisor, supervisor),
        followStream: (_environmentId, stream) =>
          Stream.provideService(stream, EnvironmentSupervisor, supervisor),
      } as EnvironmentRegistry["Service"]),
      Layer.succeed(
        Crypto.Crypto,
        Crypto.make({
          randomBytes: (size) => new Uint8Array(size),
          digest: (_algorithm, data) => Effect.succeed(data),
        }),
      ),
    ),
  );
  const storedProject = Atom.make<EnvironmentProject | null>(null);
  const commands = createProjectEnvironmentAtoms(runtime, {
    projectAtom: (ref: ScopedProjectRef) =>
      ref.environmentId === ENVIRONMENT_ID && ref.projectId === PROJECT_ID
        ? storedProject
        : Atom.make(null),
  });
  const registry = AtomRegistry.make();
  yield* Effect.addFinalizer(() => Effect.sync(() => registry.dispose()));
  registry.set(
    sessions(ENVIRONMENT_ID),
    AsyncResult.success({
      authenticated: true,
      auth: {
        policy: "remote-reachable" as const,
        bootstrapMethods: [],
        sessionMethods: [],
        sessionCookieName: "test",
      },
      scopes: [AuthFilesystemReadScope, AuthFilesystemWriteScope],
      permissions: [AuthFilesystemReadScope, AuthFilesystemWriteScope],
    }),
  );
  const openScratch = Effect.promise(() =>
    commands.openScratch.run(registry, { environmentId: ENVIRONMENT_ID, input: {} }),
  );
  return {
    registry,
    storedProject,
    openScratch,
    commands,
    metadataRequests,
    readResponse,
    file,
    fileEvents,
  };
});

describe("writeFile metadata", () => {
  it.effect("reuses a current file read without another metadata request", () =>
    Effect.gen(function* () {
      const h = yield* makeMetadataHarness();
      yield* AtomRegistry.getResult(
        h.registry,
        h.commands.readFile({
          environmentId: ENVIRONMENT_ID,
          input: { cwd: "/repo", relativePath: "foo" },
        }),
        { suspendOnWaiting: true },
      );
      const metadata = h.commands.fileMetadata({
        environmentId: ENVIRONMENT_ID,
        input: { path: "/repo/foo" },
      });
      expect(
        yield* AtomRegistry.getResult(h.registry, metadata, { suspendOnWaiting: true }),
      ).toEqual({ kind: "file", byteLength: 5 });
      expect(h.metadataRequests).toHaveLength(0);
    }).pipe(Effect.scoped),
  );

  it.effect("does not restore old metadata from a read completed after a write", () =>
    Effect.gen(function* () {
      const h = yield* makeMetadataHarness();
      const threadId = ThreadId.make("stale-read-thread");
      h.registry.mount(h.commands.fileMetadataThread({ environmentId: ENVIRONMENT_ID, threadId }));
      const metadata = h.commands.fileMetadata({
        environmentId: ENVIRONMENT_ID,
        input: { path: "/repo/foo", threadId },
      });
      h.registry.mount(metadata);
      const readMetadata = () =>
        AtomRegistry.getResult(h.registry, metadata, { suspendOnWaiting: true });
      yield* readMetadata();
      const started = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      h.readResponse.wait = Deferred.succeed(started, undefined).pipe(
        Effect.andThen(Deferred.await(release)),
      );
      const fileRead = yield* AtomRegistry.getResult(
        h.registry,
        h.commands.readFile({
          environmentId: ENVIRONMENT_ID,
          input: { cwd: "/repo", relativePath: "foo" },
        }),
        { suspendOnWaiting: true },
      ).pipe(Effect.forkChild);
      yield* Deferred.await(started);
      const write = yield* Effect.promise(() =>
        h.commands.writeFile.run(h.registry, {
          environmentId: ENVIRONMENT_ID,
          input: { cwd: "/repo", relativePath: "foo", contents: "new" },
        }),
      );
      expect(write._tag).toBe("Success");
      expect(yield* readMetadata()).toEqual({ kind: "file", byteLength: 10 });
      yield* Deferred.succeed(release, undefined);
      expect((yield* Fiber.join(fileRead)).byteLength).toBe(5);
      h.registry.refresh(metadata);
      expect(yield* readMetadata()).toEqual({ kind: "file", byteLength: 10 });
      expect(h.metadataRequests).toHaveLength(2);
    }).pipe(Effect.scoped),
  );

  it.effect("refreshes retained canonical and original paths after an aliased write", () =>
    Effect.gen(function* () {
      const h = yield* makeMetadataHarness();
      const threadId = ThreadId.make("write-metadata-thread");
      h.registry.mount(h.commands.fileMetadataThread({ environmentId: ENVIRONMENT_ID, threadId }));
      const atoms = ["/repo/foo", "/repo/./foo"].map((path) =>
        h.commands.fileMetadata({ environmentId: ENVIRONMENT_ID, input: { path, threadId } }),
      );
      for (const atom of atoms) h.registry.mount(atom);
      const read = () =>
        Effect.forEach(
          atoms,
          (atom) => AtomRegistry.getResult(h.registry, atom, { suspendOnWaiting: true }),
          { concurrency: "unbounded" },
        );
      expect(yield* read()).toEqual([
        { kind: "file", byteLength: 5 },
        { kind: "file", byteLength: 5 },
      ]);
      const result = yield* Effect.promise(() =>
        h.commands.writeFile.run(h.registry, {
          environmentId: ENVIRONMENT_ID,
          input: { cwd: "/repo", relativePath: "./foo", contents: "new" },
        }),
      );
      expect(result).toMatchObject({ _tag: "Success", value: { relativePath: "foo" } });
      expect(yield* read()).toEqual([
        { kind: "file", byteLength: 10 },
        { kind: "file", byteLength: 10 },
      ]);
      expect(h.metadataRequests.flat()).toEqual([
        "/repo/foo",
        "/repo/./foo",
        "/repo/foo",
        "/repo/./foo",
      ]);
    }).pipe(Effect.scoped),
  );

  it.effect("refreshes the old and negatively cached destination paths after renaming a file", () =>
    Effect.gen(function* () {
      const h = yield* makeMetadataHarness();
      const threadId = ThreadId.make("rename-metadata");
      h.registry.mount(h.commands.fileMetadataThread({ environmentId: ENVIRONMENT_ID, threadId }));
      const oldPath = h.commands.fileMetadata({
        environmentId: ENVIRONMENT_ID,
        input: { path: "/repo/foo", threadId },
      });
      const destination = h.commands.fileMetadata({
        environmentId: ENVIRONMENT_ID,
        input: { path: "/repo/bar", threadId },
      });
      h.registry.mount(oldPath);
      h.registry.mount(destination);
      expect(
        yield* AtomRegistry.getResult(h.registry, oldPath, { suspendOnWaiting: true }),
      ).toEqual({ kind: "file", byteLength: 5 });
      expect(
        yield* AtomRegistry.getResult(h.registry, destination, { suspendOnWaiting: true }),
      ).toBeNull();

      const renamed = yield* Effect.promise(() =>
        h.commands.renameFile.run(h.registry, {
          environmentId: ENVIRONMENT_ID,
          input: {
            cwd: "/repo",
            relativePath: "foo",
            destinationRelativePath: "bar",
            expectedRevision: "synthetic-source-revision",
          },
        }),
      );
      expect(renamed).toMatchObject({
        _tag: "Success",
        value: { relativePath: "foo", destinationRelativePath: "bar" },
      });
      expect(
        yield* AtomRegistry.getResult(h.registry, oldPath, { suspendOnWaiting: true }),
      ).toBeNull();
      expect(
        yield* AtomRegistry.getResult(h.registry, destination, { suspendOnWaiting: true }),
      ).toEqual({ kind: "file", byteLength: 5 });
    }).pipe(Effect.scoped),
  );

  it.effect("refreshes retained metadata when a watcher starts and reports external edits", () =>
    Effect.gen(function* () {
      const h = yield* makeMetadataHarness();
      const threadId = ThreadId.make("external-metadata");
      h.registry.mount(h.commands.fileMetadataThread({ environmentId: ENVIRONMENT_ID, threadId }));
      const metadata = h.commands.fileMetadata({
        environmentId: ENVIRONMENT_ID,
        input: { path: "/repo/foo", threadId },
      });
      h.registry.mount(metadata);
      expect(
        yield* AtomRegistry.getResult(h.registry, metadata, { suspendOnWaiting: true }),
      ).toEqual({ kind: "file", byteLength: 5 });
      const changes = h.commands.fileChanges({
        environmentId: ENVIRONMENT_ID,
        input: { cwd: "/repo", relativePath: "foo" },
      });
      h.registry.mount(changes);
      for (const [tag, byteLength] of [
        ["watch-ready", 7],
        ["file-changed", 11],
      ] as const) {
        h.file.byteLength = byteLength;
        yield* Queue.offer(h.fileEvents, { _tag: tag, relativePath: "foo" });
        const observed = yield* AtomRegistry.toStream(h.registry, metadata).pipe(
          Stream.filter(
            (result) => AsyncResult.isSuccess(result) && result.value?.byteLength === byteLength,
          ),
          Stream.runHead,
        );
        expect(Option.getOrThrow(observed)).toMatchObject({
          _tag: "Success",
          value: { kind: "file", byteLength },
        });
      }
    }).pipe(Effect.scoped),
  );
});

describe("openScratch", () => {
  it.effect("resolves once the created project reaches the client store", () =>
    Effect.gen(function* () {
      const { registry, storedProject, openScratch } = yield* makeMetadataHarness();
      const opening = yield* Effect.forkChild(openScratch);
      yield* Effect.yieldNow;
      registry.set(storedProject, PROJECT);
      const result = yield* Fiber.join(opening);
      expect(result).toMatchObject({ _tag: "Success", value: PROJECT });
    }).pipe(Effect.scoped),
  );
});

const target = {
  environmentId: EnvironmentId.make("test-environment"),
  input: { cwd: "/workspace", relativePath: "notes.md" },
};

type ConcreteFileMethods = {
  [
    K in
      | typeof WS_METHODS.projectsReadFile
      | typeof WS_METHODS.projectsWriteFile
      | typeof WS_METHODS.projectsRenameFile
      | typeof WS_METHODS.projectsDeleteFile
      | typeof WS_METHODS.projectsListFileVersions
      | typeof WS_METHODS.projectsDiscardFileVersion
      | typeof WS_METHODS.projectsResolveFileMutation
  ]: (
    ...args: Parameters<WsRpcProtocolClient[K]>
  ) => Effect.Effect<
    Exclude<Effect.Success<ReturnType<WsRpcProtocolClient[K]>>, void>,
    Effect.Error<ReturnType<WsRpcProtocolClient[K]>>,
    Effect.Services<ReturnType<WsRpcProtocolClient[K]>>
  >;
};

const makeHarness = Effect.fn("ProjectCommandsTest.makeHarness")(function* (
  methods: Pick<
    ConcreteFileMethods,
    typeof WS_METHODS.projectsReadFile | typeof WS_METHODS.projectsWriteFile
  > &
    Partial<
      Pick<
        ConcreteFileMethods,
        | typeof WS_METHODS.projectsRenameFile
        | typeof WS_METHODS.projectsDeleteFile
        | typeof WS_METHODS.projectsListFileVersions
        | typeof WS_METHODS.projectsDiscardFileVersion
        | typeof WS_METHODS.projectsResolveFileMutation
      >
    >,
) {
  const client = methods as unknown as WsRpcProtocolClient;
  const session: RpcSession = {
    client,
    initialConfig: Effect.never,
    subscribeServerConfig: (input) => client.subscribeServerConfig(input),
    ready: Effect.void,
    probe: Effect.void,
    closed: Effect.never,
  };
  const state = yield* SubscriptionRef.make(AVAILABLE_CONNECTION_STATE);
  const supervisor = EnvironmentSupervisor.of({
    target: new PrimaryConnectionTarget({
      environmentId: target.environmentId,
      label: "Test environment",
      httpBaseUrl: "https://environment.example.test",
      wsBaseUrl: "wss://environment.example.test",
    }),
    state,
    session: yield* SubscriptionRef.make(Option.some(session)),
    prepared: yield* SubscriptionRef.make(Option.none<PreparedConnection>()),
    connect: Effect.void,
    disconnect: Effect.void,
    retryNow: Effect.void,
  });
  const run: EnvironmentRegistry["Service"]["run"] = (_environmentId, effect) =>
    Effect.provideService(effect, EnvironmentSupervisor, supervisor);
  const followStream: EnvironmentRegistry["Service"]["followStream"] = (_environmentId, stream) =>
    Stream.provideService(stream, EnvironmentSupervisor, supervisor);
  const environmentRegistry = EnvironmentRegistry.of({
    entries: yield* SubscriptionRef.make<ReadonlyMap<EnvironmentId, ConnectionCatalogEntry>>(
      new Map(),
    ),
    networkStatus: yield* SubscriptionRef.make<NetworkStatus>("online"),
    start: Effect.void,
    register: () => Effect.void,
    registerPlatform: () => Effect.void,
    reconcilePlatform: () => Effect.void,
    remove: () => Effect.void,
    removeRoute: () => Effect.void,
    reorderRoutes: () => Effect.void,
    removeRelayEnvironments: () => Effect.void,
    setEnabled: () => Effect.die("Unexpected environment toggle"),
    setCompatibility: () => Effect.die("Unexpected compatibility update"),
    retryNow: () => Effect.void,
    state: () => SubscriptionRef.get(state),
    stateChanges: () => SubscriptionRef.changes(state),
    run,
    runStream: followStream,
    followStream,
  });
  let randomSequence = 0;
  const runtime = Atom.runtime(
    Layer.mergeAll(
      Layer.succeed(EnvironmentRegistry, environmentRegistry),
      Layer.succeed(
        Crypto.Crypto,
        Crypto.make({
          randomBytes: (size) => new Uint8Array(size).fill(++randomSequence),
          digest: (_algorithm, data) => Effect.succeed(data),
        }),
      ),
    ),
  );
  return {
    commands: createProjectEnvironmentAtoms(runtime, { projectAtom: () => Atom.make(null) }),
    registry: AtomRegistry.make(),
  };
});

describe("ordered project file commands", () => {
  it.effect("retries committed rename and delete intents without repeating namespace changes", () =>
    Effect.gen(function* () {
      const disconnected = new RpcClientError.RpcClientError({
        reason: new Socket.SocketCloseError({ code: 1006 }),
      });
      const files = new Set(["notes.md", "other.md"]);
      const renames = new Map<string, ProjectRenameFileResult>();
      const deletes = new Map<string, ProjectDeleteFileResult>();
      let renamePublications = 0;
      let deletePublications = 0;
      const { commands, registry } = yield* makeHarness({
        [WS_METHODS.projectsReadFile]: () => Effect.die("unused"),
        [WS_METHODS.projectsWriteFile]: () => Effect.die("unused"),
        [WS_METHODS.projectsRenameFile]: Effect.fn(function* (input) {
          const receipt = renames.get(input.mutationId!);
          if (receipt) return receipt;
          if (!files.delete(input.relativePath)) return yield* Effect.die("Source is gone");
          files.add(input.destinationRelativePath);
          const result = {
            relativePath: input.relativePath,
            destinationRelativePath: input.destinationRelativePath,
            revision: `rename-${++renamePublications}`,
            mutationId: input.mutationId,
          };
          renames.set(input.mutationId!, result);
          if (renamePublications === 1) return yield* disconnected;
          return result;
        }),
        [WS_METHODS.projectsDeleteFile]: Effect.fn(function* (input) {
          const receipt = deletes.get(input.mutationId!);
          if (receipt) return receipt;
          if (!files.delete(input.relativePath)) return yield* Effect.die("File is gone");
          const result = { relativePath: input.relativePath, mutationId: input.mutationId };
          deletes.set(input.mutationId!, result);
          if (++deletePublications === 1) return yield* disconnected;
          return result;
        }),
      });
      try {
        const rename = {
          ...target,
          input: {
            ...target.input,
            destinationRelativePath: "renamed.md",
            mutationId: "owned-rename",
          },
        };
        const lostRename = yield* Effect.promise(() => commands.renameFile.run(registry, rename));
        expect(lostRename._tag).toBe("Failure");
        expect(files).toEqual(new Set(["other.md", "renamed.md"]));
        expect(
          yield* Effect.promise(() => commands.renameFile.run(registry, rename)),
        ).toMatchObject({
          _tag: "Success",
          value: { revision: "rename-1", mutationId: "owned-rename" },
        });
        expect(renamePublications).toBe(1);

        const remove = {
          ...target,
          input: {
            ...target.input,
            relativePath: "renamed.md",
            expectedRevision: "rename-1",
            mutationId: "owned-delete",
          },
        };
        const lostDelete = yield* Effect.promise(() => commands.deleteFile.run(registry, remove));
        expect(lostDelete._tag).toBe("Failure");
        expect(files).toEqual(new Set(["other.md"]));
        expect(
          yield* Effect.promise(() => commands.deleteFile.run(registry, remove)),
        ).toMatchObject({
          _tag: "Success",
          value: { relativePath: "renamed.md", mutationId: "owned-delete" },
        });
        expect(deletePublications).toBe(1);

        const generatedRename = yield* Effect.promise(() =>
          commands.renameFile.run(registry, {
            ...target,
            input: {
              ...target.input,
              relativePath: "other.md",
              destinationRelativePath: "final.md",
            },
          }),
        );
        const generatedDelete = yield* Effect.promise(() =>
          commands.deleteFile.run(registry, {
            ...target,
            input: { ...target.input, relativePath: "final.md", expectedRevision: "rename-2" },
          }),
        );
        expect(generatedRename).toMatchObject({ _tag: "Success", value: { revision: "rename-2" } });
        expect(generatedDelete._tag).toBe("Success");
        if (generatedRename._tag === "Success" && generatedDelete._tag === "Success") {
          expect(generatedRename.value.mutationId).toMatch(/^[0-9a-f-]{36}$/u);
          expect(generatedDelete.value.mutationId).toMatch(/^[0-9a-f-]{36}$/u);
          expect(generatedDelete.value.mutationId).not.toBe(generatedRename.value.mutationId);
        }
        expect(files).toEqual(new Set());
      } finally {
        registry.dispose();
      }
    }),
  );

  it.effect("retries a lost write receipt by owned identity, not by matching text", () =>
    Effect.gen(function* () {
      const disconnected = new RpcClientError.RpcClientError({
        reason: new Socket.SocketCloseError({ code: 1006 }),
      });
      const receipts = new Map<string, ProjectWriteFileResult>();
      let publications = 0;
      let diskContents = "";
      const { commands, registry } = yield* makeHarness({
        [WS_METHODS.projectsReadFile]: () => Effect.die("unused"),
        [WS_METHODS.projectsWriteFile]: Effect.fn(function* (input) {
          const receipt = receipts.get(input.mutationId!);
          if (receipt) return receipt;
          diskContents = input.contents;
          const result = {
            relativePath: input.relativePath,
            revision: `revision-${++publications}`,
            mutationId: input.mutationId,
          };
          receipts.set(input.mutationId!, result);
          if (publications === 1) return yield* disconnected;
          return result;
        }),
      });
      try {
        const owned = {
          ...target,
          input: { ...target.input, contents: "saved", mutationId: "owned-write" },
        };
        const lost = yield* Effect.promise(() => commands.writeFile.run(registry, owned));
        expect(lost._tag).toBe("Failure");
        if (lost._tag === "Failure") expect(Cause.squash(lost.cause)).toBe(disconnected);
        expect(diskContents).toBe("saved");
        expect(publications).toBe(1);
        expect(yield* Effect.promise(() => commands.writeFile.run(registry, owned))).toMatchObject({
          _tag: "Success",
          value: { revision: "revision-1", mutationId: "owned-write" },
        });
        expect(publications).toBe(1);

        const input: ProjectWriteFileInput = { ...target.input, contents: "saved" };
        const first = yield* Effect.promise(() =>
          commands.writeFile.run(registry, { ...target, input }),
        );
        const second = yield* Effect.promise(() =>
          commands.writeFile.run(registry, { ...target, input }),
        );
        expect(first).toMatchObject({ _tag: "Success", value: { revision: "revision-2" } });
        expect(second).toMatchObject({ _tag: "Success", value: { revision: "revision-3" } });
        if (first._tag === "Success" && second._tag === "Success") {
          expect(first.value.mutationId).toMatch(/^[0-9a-f-]{36}$/u);
          expect(second.value.mutationId).not.toBe(first.value.mutationId);
        }
        expect(publications).toBe(3);
        expect(input).not.toHaveProperty("mutationId");
      } finally {
        registry.dispose();
      }
    }),
  );
  it.effect.each(
    (["write", "rename", "delete"] as const).flatMap((mutation) =>
      (["success", "failure"] as const).map((outcome) => ({
        caseTitle: `starts a same-file read only after a held ${mutation} settles with ${outcome}`,
        mutation,
        outcome,
      })),
    ),
  )("$caseTitle", ({ mutation, outcome }) =>
    Effect.gen(function* () {
      const entered = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      const events: string[] = [];
      const settle = Effect.fn(function* (relativePath: string) {
        events.push(`${mutation}:${relativePath}`);
        entered.resolve();
        yield* Effect.promise(() => release.promise);
        events.push(`settled:${outcome}`);
        if (outcome === "failure") return yield* Effect.interrupt;
      });
      const { commands, registry } = yield* makeHarness({
        [WS_METHODS.projectsWriteFile]: Effect.fn(function* (input) {
          yield* settle(input.relativePath);
          return { relativePath: input.relativePath, revision: "revision-written" };
        }),
        [WS_METHODS.projectsRenameFile]: Effect.fn(function* (input) {
          yield* settle(input.relativePath);
          return {
            relativePath: input.relativePath,
            destinationRelativePath: input.destinationRelativePath,
            revision: "revision-renamed",
          };
        }),
        [WS_METHODS.projectsDeleteFile]: Effect.fn(function* (input) {
          yield* settle(input.relativePath);
          return { relativePath: input.relativePath };
        }),
        [WS_METHODS.projectsReadFile]: (input) =>
          Effect.sync(() => {
            events.push(`read:${input.relativePath}`);
            return {
              ...input,
              contents: "saved",
              revision: "revision-written",
              byteLength: 5,
              truncated: false,
            };
          }),
      });
      try {
        const pendingMutation =
          mutation === "write"
            ? commands.writeFile.run(registry, {
                ...target,
                input: { ...target.input, contents: "saved" },
              })
            : mutation === "rename"
              ? commands.renameFile.run(registry, {
                  ...target,
                  input: { ...target.input, destinationRelativePath: "renamed.md" },
                })
              : commands.deleteFile.run(registry, {
                  ...target,
                  input: { ...target.input, expectedRevision: "revision-original" },
                });
        yield* Effect.promise(() => entered.promise);
        const read = commands.readFileOrdered.run(registry, target);
        // A different path makes progress while the same-file read stays queued.
        yield* Effect.promise(() =>
          commands.readFileOrdered.run(registry, {
            ...target,
            input: { ...target.input, relativePath: "other.md" },
          }),
        );
        expect(events).toEqual([`${mutation}:notes.md`, "read:other.md"]);

        release.resolve();
        expect(
          (yield* Effect.promise<Awaited<typeof pendingMutation>>(() => pendingMutation))._tag,
        ).toBe(outcome === "success" ? "Success" : "Failure");
        expect(yield* Effect.promise(() => read)).toMatchObject({
          _tag: "Success",
          value: { contents: "saved" },
        });
        expect(events).toEqual([
          `${mutation}:notes.md`,
          "read:other.md",
          `settled:${outcome}`,
          "read:notes.md",
        ]);
      } finally {
        release.resolve();
        registry.dispose();
      }
    }),
  );

  it.effect("does not serialize unrelated workspaces or environments", () =>
    Effect.gen(function* () {
      const entered = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      const reads: string[] = [];
      const { commands, registry } = yield* makeHarness({
        [WS_METHODS.projectsWriteFile]: Effect.fn(function* (input) {
          entered.resolve();
          yield* Effect.promise(() => release.promise);
          return { relativePath: input.relativePath, revision: "written" };
        }),
        [WS_METHODS.projectsReadFile]: (input) =>
          Effect.sync(() => {
            reads.push(input.cwd);
            return { ...input, contents: "", revision: "read", byteLength: 0, truncated: false };
          }),
      });
      try {
        const write = commands.writeFile.run(registry, {
          ...target,
          input: { ...target.input, contents: "saved" },
        });
        yield* Effect.promise(() => entered.promise);
        yield* Effect.promise(() =>
          Promise.all([
            commands.readFileOrdered.run(registry, {
              ...target,
              input: { ...target.input, cwd: "/another-workspace" },
            }),
            commands.readFileOrdered.run(registry, {
              ...target,
              environmentId: EnvironmentId.make("another-environment"),
            }),
          ]),
        );
        expect(reads).toEqual(["/another-workspace", "/workspace"]);
        release.resolve();
        yield* Effect.promise(() => write);
      } finally {
        release.resolve();
        registry.dispose();
      }
    }),
  );

  it.effect.each(["revision-current", null])(
    "keeps attention after discard and orders confirmation behind resolution of %s",
    (currentRevision) =>
      Effect.gen(function* () {
        const attention = {
          recoveryId: "recovery-1",
          mutationId: "owned-write",
          retainedPaths: ["/workspace/.scient/retained/one"],
          message: "Review the retained publication.",
        };
        let unresolved = true;
        let retained = true;
        let attemptedWrites = 0;
        const entered = Promise.withResolvers<void>();
        const release = Promise.withResolvers<void>();
        const events: string[] = [];
        const { commands, registry } = yield* makeHarness({
          [WS_METHODS.projectsWriteFile]: (input) => {
            attemptedWrites++;
            return Effect.fail(
              new ProjectWriteFileError({
                ...input,
                failure: "recovery_required",
                mutationId: attention.mutationId,
                publicationOutcome: "retained-attention",
                recoveryId: attention.recoveryId,
                retainedPaths: attention.retainedPaths,
              }),
            );
          },
          [WS_METHODS.projectsListFileVersions]: () =>
            Effect.sync(() => ({
              versions: retained
                ? [
                    {
                      versionId: "version-1",
                      mutationId: attention.mutationId,
                      retainedPath: attention.retainedPaths[0]!,
                      revision: "revision-retained",
                      byteLength: 5,
                      retainedAt: 123,
                    },
                  ]
                : [],
              retainedBytes: retained ? 5 : 0,
              limitBytes: null,
              attention: unresolved ? attention : null,
            })),
          [WS_METHODS.projectsDiscardFileVersion]: (input) =>
            Effect.sync(() => {
              retained = false;
              return { versionId: input.versionId };
            }),
          [WS_METHODS.projectsResolveFileMutation]: Effect.fn(function* (input) {
            events.push("resolve-start");
            entered.resolve();
            yield* Effect.promise(() => release.promise);
            if (
              input.recoveryId !== attention.recoveryId ||
              input.currentRevision !== currentRevision
            ) {
              return yield* new ProjectWriteFileError({
                cwd: input.cwd,
                relativePath: input.relativePath,
                failure: "target_changed",
              });
            }
            unresolved = false;
            events.push("resolve-settled");
            return { recoveryId: input.recoveryId, revision: currentRevision };
          }),
          [WS_METHODS.projectsReadFile]: (input) =>
            Effect.suspend(() => {
              events.push(`read:${input.relativePath}`);
              if (currentRevision === null && input.relativePath === target.input.relativePath) {
                return Effect.fail(
                  new ProjectReadFileError({
                    cwd: input.cwd,
                    relativePath: input.relativePath,
                    failure: "operation_failed",
                    reason: "not_found",
                    currentMissing: true,
                    ...(unresolved
                      ? {
                          recoveryId: attention.recoveryId,
                          retainedPaths: attention.retainedPaths,
                        }
                      : {}),
                  }),
                );
              }
              return Effect.succeed({
                ...input,
                contents: "current",
                revision: "revision-current",
                byteLength: 7,
                truncated: false,
                ...(unresolved && input.relativePath === target.input.relativePath
                  ? { publicationAttention: attention }
                  : {}),
              });
            }),
        });
        try {
          const failed = yield* Effect.promise(() =>
            commands.writeFile.run(registry, {
              ...target,
              input: { ...target.input, contents: "draft", mutationId: "owned-write" },
            }),
          );
          expect(failed._tag).toBe("Failure");
          if (failed._tag === "Failure") {
            expect(Cause.squash(failed.cause)).toMatchObject({
              _tag: "ProjectWriteFileError",
              failure: "recovery_required",
              mutationId: "owned-write",
              publicationOutcome: "retained-attention",
              recoveryId: attention.recoveryId,
              retainedPaths: attention.retainedPaths,
            });
          }
          yield* Effect.promise(() =>
            commands.discardFileVersion.run(registry, {
              ...target,
              input: { ...target.input, versionId: "version-1" },
            }),
          );
          expect(
            yield* Effect.promise(() => commands.listFileVersions.run(registry, target)),
          ).toMatchObject({
            _tag: "Success",
            value: { versions: [], attention },
          });
          const reviewed = yield* Effect.promise(() =>
            commands.readFileOrdered.run(registry, target),
          );
          if (currentRevision === null) {
            expect(reviewed._tag).toBe("Failure");
            if (reviewed._tag === "Failure")
              expect(Cause.squash(reviewed.cause)).toMatchObject({
                _tag: "ProjectReadFileError",
                reason: "not_found",
                currentMissing: true,
                cwd: target.input.cwd,
                relativePath: target.input.relativePath,
                recoveryId: attention.recoveryId,
              });
          } else {
            expect(reviewed).toMatchObject({
              _tag: "Success",
              value: { publicationAttention: attention },
            });
          }
          expect(attemptedWrites).toBe(1);
          events.length = 0;

          const resolution = commands.resolveFileMutation.run(registry, {
            ...target,
            input: {
              ...target.input,
              recoveryId: "recovery-1",
              currentRevision,
              choice: "accept-current",
            },
          });
          yield* Effect.promise(() => entered.promise);
          const confirmation = commands.readFileOrdered.run(registry, target);
          yield* Effect.promise(() =>
            commands.readFileOrdered.run(registry, {
              ...target,
              input: { ...target.input, relativePath: "other.md" },
            }),
          );
          expect(events).toEqual(["resolve-start", "read:other.md"]);
          release.resolve();
          expect(yield* Effect.promise(() => resolution)).toMatchObject({
            _tag: "Success",
            value: { recoveryId: "recovery-1", revision: currentRevision },
          });
          const confirmed = yield* Effect.promise(() => confirmation);
          if (currentRevision === null) {
            expect(confirmed._tag).toBe("Failure");
            if (confirmed._tag === "Failure") {
              const failure = Cause.squash(confirmed.cause);
              expect(failure).toMatchObject({
                _tag: "ProjectReadFileError",
                failure: "operation_failed",
                reason: "not_found",
                currentMissing: true,
                cwd: target.input.cwd,
                relativePath: target.input.relativePath,
              });
              expect(failure).not.toHaveProperty("recoveryId");
            }
          } else {
            expect(confirmed).toMatchObject({
              _tag: "Success",
              value: { contents: "current", revision: currentRevision },
            });
            if (confirmed._tag === "Success")
              expect(confirmed.value).not.toHaveProperty("publicationAttention");
          }
          expect(events).toEqual([
            "resolve-start",
            "read:other.md",
            "resolve-settled",
            "read:notes.md",
          ]);
          expect(attemptedWrites).toBe(1);
        } finally {
          release.resolve();
          registry.dispose();
        }
      }),
  );
});
