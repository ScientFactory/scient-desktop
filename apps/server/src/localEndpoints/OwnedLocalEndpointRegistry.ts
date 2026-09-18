// @effect-diagnostics nodeBuiltinImport:off -- this service owns loopback TCP reservations.
import * as NodeNet from "node:net";

import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Semaphore from "effect/Semaphore";

const LOOPBACK_HOST = "127.0.0.1";
const PROBE_PERMITS = 1_024;

export class OwnedLocalEndpointError extends Data.TaggedError("OwnedLocalEndpointError")<{
  readonly operation: "reserve" | "handoff";
  readonly message: string;
  readonly cause?: unknown;
}> {}

export interface OwnedLocalEndpointSnapshot {
  /** Changes whenever the protected endpoint set changes. */
  readonly revision: number;
  readonly protectedLoopbackTcpPorts: ReadonlySet<number>;
}

export interface ProtectedLoopbackTcpLease {
  readonly ports: ReadonlyArray<number>;
  /**
   * Releases the temporary sockets so the intended protocol can bind them.
   * Protection remains registered until `release` is called.
   */
  readonly handoff: Effect.Effect<void, OwnedLocalEndpointError>;
  /** Ends both the reservation and the endpoint protection. Idempotent. */
  readonly release: Effect.Effect<void>;
}

export type LocalEndpointProbeResult<A> =
  | { readonly _tag: "protected" }
  | { readonly _tag: "probed"; readonly value: A };

export class OwnedLocalEndpointRegistry extends Context.Service<
  OwnedLocalEndpointRegistry,
  {
    readonly snapshot: Effect.Effect<OwnedLocalEndpointSnapshot>;
    /**
     * Runs a web-protocol probe only while endpoint ownership is stable.
     * Reservations take every permit before registration and handoff, so a
     * probe admitted before protection finishes against the reservation
     * socket; one admitted afterward never sends bytes to the private port.
     */
    readonly runLoopbackTcpProbe: <A, E, R>(
      port: number,
      probe: Effect.Effect<A, E, R>,
    ) => Effect.Effect<LocalEndpointProbeResult<A>, E, R>;
    readonly reserveProtectedLoopbackTcpPorts: (input: {
      readonly owner: string;
      readonly purpose: string;
      readonly count: number;
    }) => Effect.Effect<ProtectedLoopbackTcpLease, OwnedLocalEndpointError>;
  }
>()("t3/localEndpoints/OwnedLocalEndpointRegistry") {}

interface RegistryState {
  readonly revision: number;
  readonly leaseIdsByPort: ReadonlyMap<number, ReadonlySet<number>>;
}

export interface OwnedLocalEndpointRegistryMakeOptions {
  /** Test seam for deterministically exercising the pre-registration race. */
  readonly afterReservationsOpened?: (ports: ReadonlyArray<number>) => Effect.Effect<void>;
}

const endpointError = (
  operation: OwnedLocalEndpointError["operation"],
  message: string,
  cause?: unknown,
): OwnedLocalEndpointError =>
  new OwnedLocalEndpointError({
    operation,
    message,
    ...(cause === undefined ? {} : { cause }),
  });

const openReservation = (): Effect.Effect<NodeNet.Server, OwnedLocalEndpointError> =>
  Effect.callback<NodeNet.Server, OwnedLocalEndpointError>((resume) => {
    // Connections can only arrive from another local process during the tiny
    // reservation window. Destroy them without reading: these sockets exist to
    // hold an address, never to impersonate the eventual protocol.
    const server = NodeNet.createServer((socket) => socket.destroy());
    let settled = false;
    const finish = (effect: Effect.Effect<NodeNet.Server, OwnedLocalEndpointError>) => {
      if (settled) return;
      settled = true;
      resume(effect);
    };
    server.unref();
    server.once("error", (cause) => {
      finish(
        Effect.fail(endpointError("reserve", "Unable to reserve a loopback endpoint.", cause)),
      );
    });
    server.listen({ host: LOOPBACK_HOST, port: 0, exclusive: true }, () => {
      finish(Effect.succeed(server));
    });
    return Effect.sync(() => {
      if (server.listening) server.close();
    });
  });

const closeReservation = (server: NodeNet.Server): Effect.Effect<void, OwnedLocalEndpointError> =>
  Effect.callback<void, OwnedLocalEndpointError>((resume) => {
    if (!server.listening) {
      resume(Effect.void);
      return;
    }
    server.close((cause) => {
      if (cause) {
        resume(
          Effect.fail(
            endpointError("handoff", "Unable to release a reserved loopback endpoint.", cause),
          ),
        );
        return;
      }
      resume(Effect.void);
    });
  });

const closeReservations = (servers: ReadonlyArray<NodeNet.Server>) =>
  Effect.forEach(servers, closeReservation, { discard: true });

const closeReservationsIgnoringErrors = (servers: ReadonlyArray<NodeNet.Server>) =>
  closeReservations(servers).pipe(Effect.ignore);

/** @public Service construction is part of the canonical Effect module API. */
export const make = Effect.fn("OwnedLocalEndpointRegistry.make")(function* (
  options: OwnedLocalEndpointRegistryMakeOptions = {},
) {
  const stateRef = yield* Ref.make<RegistryState>({
    revision: 0,
    leaseIdsByPort: new Map(),
  });
  const registryGate = yield* Semaphore.make(1);
  const probeGate = yield* Semaphore.make(PROBE_PERMITS);
  let nextLeaseId = 1;

  const snapshot = Ref.get(stateRef).pipe(
    Effect.map((state): OwnedLocalEndpointSnapshot => ({
      revision: state.revision,
      protectedLoopbackTcpPorts: new Set(state.leaseIdsByPort.keys()),
    })),
  );

  const runLoopbackTcpProbe = <A, E, R>(
    port: number,
    probe: Effect.Effect<A, E, R>,
  ): Effect.Effect<LocalEndpointProbeResult<A>, E, R> =>
    probeGate.withPermits(1)(
      Effect.gen(function* () {
        const current = yield* snapshot;
        if (current.protectedLoopbackTcpPorts.has(port)) {
          return { _tag: "protected" } as const;
        }
        return { _tag: "probed", value: yield* probe } as const;
      }),
    );

  const unregisterLease = (leaseId: number, ports: ReadonlyArray<number>) =>
    probeGate.withPermits(PROBE_PERMITS)(
      registryGate.withPermit(
        Ref.update(stateRef, (state) => {
          const leaseIdsByPort = new Map(state.leaseIdsByPort);
          let changed = false;
          for (const port of ports) {
            const owners = new Set(leaseIdsByPort.get(port) ?? []);
            if (!owners.delete(leaseId)) continue;
            changed = true;
            if (owners.size === 0) leaseIdsByPort.delete(port);
            else leaseIdsByPort.set(port, owners);
          }
          return changed ? { revision: state.revision + 1, leaseIdsByPort } : state;
        }),
      ),
    );

  const reserveProtectedLoopbackTcpPorts: OwnedLocalEndpointRegistry["Service"]["reserveProtectedLoopbackTcpPorts"] =
    Effect.fn("OwnedLocalEndpointRegistry.reserveProtectedLoopbackTcpPorts")((input) =>
      Effect.uninterruptible(
        Effect.gen(function* () {
          if (!Number.isInteger(input.count) || input.count <= 0 || input.count > 32) {
            return yield* endpointError(
              "reserve",
              "The endpoint reservation count must be an integer between 1 and 32.",
            );
          }

          const servers: NodeNet.Server[] = [];
          let registeredLeaseId: number | null = null;
          let registeredPorts: ReadonlyArray<number> = [];
          let transferred = false;

          const acquire = Effect.gen(function* () {
            for (let index = 0; index < input.count; index += 1) {
              servers.push(yield* openReservation());
            }

            const ports: number[] = [];
            for (const server of servers) {
              const address = server.address();
              if (typeof address !== "object" || address === null || address.port <= 0) {
                return yield* endpointError(
                  "reserve",
                  "A loopback reservation did not report its port.",
                );
              }
              ports.push(address.port);
            }
            yield* options.afterReservationsOpened?.(ports) ?? Effect.void;

            const leaseId = yield* probeGate.withPermits(PROBE_PERMITS)(
              registryGate.withPermit(
                Effect.gen(function* () {
                  const id = nextLeaseId++;
                  yield* Ref.update(stateRef, (state) => {
                    const leaseIdsByPort = new Map(state.leaseIdsByPort);
                    for (const port of ports) {
                      const owners = new Set(leaseIdsByPort.get(port) ?? []);
                      owners.add(id);
                      leaseIdsByPort.set(port, owners);
                    }
                    return { revision: state.revision + 1, leaseIdsByPort };
                  });
                  return id;
                }),
              ),
            );
            registeredLeaseId = leaseId;
            registeredPorts = ports;

            let reservationOpen = true;
            let released = false;
            const leaseGate = yield* Semaphore.make(1);

            const handoff = leaseGate.withPermit(
              Effect.suspend(() => {
                if (!reservationOpen) return Effect.void;
                return closeReservations(servers).pipe(
                  Effect.andThen(
                    Effect.sync(() => {
                      reservationOpen = false;
                    }),
                  ),
                );
              }),
            );

            const release = leaseGate.withPermit(
              Effect.suspend(() => {
                if (released) return Effect.void;
                return closeReservationsIgnoringErrors(servers).pipe(
                  Effect.andThen(unregisterLease(leaseId, ports)),
                  Effect.andThen(
                    Effect.sync(() => {
                      reservationOpen = false;
                      released = true;
                    }),
                  ),
                );
              }),
            );

            yield* Effect.logDebug("reserved protected local endpoints", {
              owner: input.owner,
              purpose: input.purpose,
              endpointCount: ports.length,
            });
            transferred = true;
            return { ports, handoff, release } satisfies ProtectedLoopbackTcpLease;
          });

          return yield* acquire.pipe(
            Effect.ensuring(
              Effect.suspend(() => {
                if (transferred) return Effect.void;
                const leaseId = registeredLeaseId;
                return closeReservationsIgnoringErrors(servers).pipe(
                  Effect.andThen(
                    leaseId === null ? Effect.void : unregisterLease(leaseId, registeredPorts),
                  ),
                );
              }),
            ),
          );
        }),
      ),
    );

  return OwnedLocalEndpointRegistry.of({
    snapshot,
    runLoopbackTcpProbe,
    reserveProtectedLoopbackTcpPorts,
  });
});

export const layer = Layer.effect(OwnedLocalEndpointRegistry, make());
