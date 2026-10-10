import {
  EnvironmentId,
  ThreadId,
  WS_METHODS,
  type ScientDocumentHostStreamEvent,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";
import { vi } from "vite-plus/test";

import {
  AVAILABLE_CONNECTION_STATE,
  PrimaryConnectionTarget,
  type PreparedConnection,
} from "../connection/model.ts";
import * as EnvironmentRegistry from "../connection/registry.ts";
import * as EnvironmentSupervisor from "../connection/supervisor.ts";
import type { WsRpcProtocolClient } from "../rpc/protocol.ts";
import type { RpcSession } from "../rpc/session.ts";
import { createScientDocumentPdfEnvironmentAtoms } from "./scientDocumentPdf.ts";

const TARGET = new PrimaryConnectionTarget({
  environmentId: EnvironmentId.make("documents-environment"),
  label: "Test environment",
  httpBaseUrl: "https://environment.example.test",
  wsBaseUrl: "wss://environment.example.test",
});

const connected = (connectionId: string): ScientDocumentHostStreamEvent => ({
  type: "connected",
  connectionId,
});
const request = (requestId: string, connectionId: string): ScientDocumentHostStreamEvent => ({
  type: "request",
  connectionId,
  request: {
    requestId,
    threadId: ThreadId.make("thread-1"),
    operation: "documentLatexPresent",
    input: { rootSourcePath: "papers/main.tex" },
    timeoutMs: 15_000,
  },
});

/** Runs the host-request atom against fake server streams, one per subscription. */
const observeHostRequests = Effect.fn("TestScientDocumentPdf.observeHostRequests")(function* (
  serverStreams: ReadonlyArray<Stream.Stream<ScientDocumentHostStreamEvent>>,
) {
  let subscriptions = 0;
  const client = {
    [WS_METHODS.documentsHostConnect]: () =>
      serverStreams[Math.min(subscriptions++, serverStreams.length - 1)]!,
  } as unknown as WsRpcProtocolClient;
  const session: RpcSession = {
    client,
    initialConfig: Effect.never,
    subscribeServerConfig: () => Stream.never,
    ready: Effect.void,
    probe: Effect.void,
    closed: Effect.never,
  };
  const supervisor = EnvironmentSupervisor.EnvironmentSupervisor.of({
    target: TARGET,
    state: yield* SubscriptionRef.make(AVAILABLE_CONNECTION_STATE),
    session: yield* SubscriptionRef.make(Option.some(session)),
    prepared: yield* SubscriptionRef.make(Option.none<PreparedConnection>()),
    connect: Effect.void,
    disconnect: Effect.void,
    retryNow: Effect.void,
  } satisfies EnvironmentSupervisor.EnvironmentSupervisor["Service"]);
  const environmentRegistry = EnvironmentRegistry.EnvironmentRegistry.of({
    followStream: (_environmentId: EnvironmentId, stream: Stream.Stream<unknown>) =>
      Stream.provideService(stream, EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
  } as unknown as EnvironmentRegistry.EnvironmentRegistry["Service"]);
  const atoms = createScientDocumentPdfEnvironmentAtoms(
    Atom.runtime(Layer.succeed(EnvironmentRegistry.EnvironmentRegistry, environmentRegistry)),
  );
  const atom = atoms.hostRequests({
    environmentId: TARGET.environmentId,
    input: {
      clientId: "client-1",
      environmentId: TARGET.environmentId,
      supportedOperations: ["documentLatexPresent"],
    },
  });
  const registry = yield* Effect.acquireRelease(Effect.sync(AtomRegistry.make), (registry) =>
    Effect.sync(() => registry.dispose()),
  );
  const events: ScientDocumentHostStreamEvent[] = [];
  const unsubscribe = registry.subscribe(
    atom,
    (result) => {
      if (AsyncResult.isSuccess(result)) events.push(result.value);
    },
    { immediate: true },
  );
  yield* Effect.addFinalizer(() => Effect.sync(unsubscribe));
  return { events, subscriptions: () => subscriptions };
});

describe("document host requests", () => {
  it.effect("delivers every event of a batch the server sends together", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const host = yield* observeHostRequests([
          Stream.concat(
            Stream.make(connected("c1"), request("r1", "c1"), request("r2", "c1")),
            Stream.never,
          ),
        ]);

        yield* Effect.promise(() => vi.waitFor(() => expect(host.events).toHaveLength(3)));
        expect(host.events).toEqual([connected("c1"), request("r1", "c1"), request("r2", "c1")]);
      }),
    ),
  );

  it.effect("reconnects after the server ends the host stream", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const host = yield* observeHostRequests([
          Stream.make(connected("evicted")),
          Stream.concat(Stream.make(connected("replacement")), Stream.never),
        ]);

        yield* Effect.promise(() =>
          vi.waitFor(() => expect(host.events.at(-1)).toEqual(connected("replacement")), {
            timeout: 5_000,
          }),
        );
        expect(host.subscriptions()).toBe(2);
        expect(host.events.map((event) => event.connectionId)).toEqual(["evicted", "replacement"]);
      }),
    ),
  );
});
