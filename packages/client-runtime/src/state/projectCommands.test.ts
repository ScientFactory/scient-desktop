import { describe, expect, it } from "@effect/vitest";
import {
  type ProjectReadFileInput,
  type ProjectReadFileResult,
  type ProjectWriteFileInput,
  type ProjectWriteFileResult,
  type ProjectFileWatchEvent,
  AuthFilesystemReadScope,
  AuthFilesystemWriteScope,
  EnvironmentId,
  ProjectId,
  ThreadId,
  type AuthSessionState,
  type ScopedProjectRef,
  WS_METHODS,
} from "@t3tools/contracts";
import { vi } from "vite-plus/test";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as Queue from "effect/Queue";
import { Atom, AtomRegistry, AsyncResult } from "effect/reactivity";

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
          input: { cwd: "/repo", relativePath: "foo", destinationRelativePath: "bar" },
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

const makeHarness = Effect.fn("ProjectCommandsTest.makeHarness")(function* (methods: {
  [WS_METHODS.projectsReadFile]: (
    input: ProjectReadFileInput,
  ) => Effect.Effect<ProjectReadFileResult>;
  [WS_METHODS.projectsWriteFile]: (
    input: ProjectWriteFileInput,
  ) => Effect.Effect<ProjectWriteFileResult>;
}) {
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
  const runtime = Atom.runtime(
    Layer.mergeAll(
      Layer.succeed(EnvironmentRegistry, environmentRegistry),
      Layer.succeed(
        Crypto.Crypto,
        Crypto.make({
          randomBytes: (size) => new Uint8Array(size),
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
  it.effect.each(
    (["success", "failure"] as const).map((outcome) => ({
      caseTitle: `starts a same-file read only after a held write settles with ${outcome}`,
      outcome,
    })),
  )("$caseTitle", ({ outcome }) =>
    Effect.gen(function* () {
      const entered = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      const events: string[] = [];
      const { commands, registry } = yield* makeHarness({
        [WS_METHODS.projectsWriteFile]: Effect.fn(function* (input) {
          events.push(`write:${input.relativePath}`);
          entered.resolve();
          yield* Effect.promise(() => release.promise);
          events.push(`settled:${outcome}`);
          if (outcome === "failure") return yield* Effect.interrupt;
          return { relativePath: input.relativePath, revision: "revision-written" };
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
        const write = commands.writeFile.run(registry, {
          ...target,
          input: { ...target.input, contents: "saved" },
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
        expect(events).toEqual(["write:notes.md", "read:other.md"]);

        release.resolve();
        expect((yield* Effect.promise(() => write))._tag).toBe(
          outcome === "success" ? "Success" : "Failure",
        );
        expect(yield* Effect.promise(() => read)).toMatchObject({
          _tag: "Success",
          value: { contents: "saved" },
        });
        expect(events).toEqual([
          "write:notes.md",
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

  it.effect("executes every ordered read rather than returning a cached snapshot", () =>
    Effect.gen(function* () {
      let revision = 0;
      const { commands, registry } = yield* makeHarness({
        [WS_METHODS.projectsWriteFile]: () => Effect.die("unused"),
        [WS_METHODS.projectsReadFile]: (input) =>
          Effect.sync(() => ({
            ...input,
            contents: "",
            revision: String(++revision),
            byteLength: 0,
            truncated: false,
          })),
      });
      try {
        expect(
          yield* Effect.promise(() => commands.readFileOrdered.run(registry, target)),
        ).toMatchObject({
          _tag: "Success",
          value: { revision: "1" },
        });
        expect(
          yield* Effect.promise(() => commands.readFileOrdered.run(registry, target)),
        ).toMatchObject({
          _tag: "Success",
          value: { revision: "2" },
        });
      } finally {
        registry.dispose();
      }
    }),
  );

  it("shares an exact tuple key without adding an independent path normalization", () => {
    const input = { environmentId: target.environmentId, ...target.input };
    expect(projectFileOperationKey(input)).toBe(
      JSON.stringify([target.environmentId, target.input.cwd, target.input.relativePath]),
    );
    expect(projectFileOperationKey({ ...input, relativePath: "./notes.md" })).not.toBe(
      projectFileOperationKey(input),
    );
    expect(projectFileOperationKey({ ...input, cwd: "/workspace/" })).not.toBe(
      projectFileOperationKey(input),
    );
  });
});
