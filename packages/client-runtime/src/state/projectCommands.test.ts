import { describe, expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  WS_METHODS,
  type ProjectReadFileInput,
  type ProjectReadFileResult,
  type ProjectWriteFileInput,
  type ProjectWriteFileResult,
} from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { Atom, AtomRegistry } from "effect/unstable/reactivity";

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
import { createProjectEnvironmentAtoms, projectFileOperationKey } from "./projectCommands.ts";

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
    removeRelayEnvironments: () => Effect.void,
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
    commands: createProjectEnvironmentAtoms(runtime),
    registry: AtomRegistry.make(),
  };
});

describe("ordered project file commands", () => {
  for (const outcome of ["success", "failure"] as const) {
    it.effect(`starts a same-file read only after a held write settles with ${outcome}`, () =>
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
  }

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
