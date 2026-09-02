import { describe, expect, it } from "@effect/vitest";
import { vi } from "vite-plus/test";
import {
  ComputeLanguageId,
  EnvironmentId,
  WS_METHODS,
  type ComputeManagedRuntimeStatus,
  type ComputeRuntimeInspection,
  type ScientificComputingSettings,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Data from "effect/Data";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { AsyncResult, Atom, AtomRegistry } from "effect/unstable/reactivity";
import {
  AVAILABLE_CONNECTION_STATE,
  PrimaryConnectionTarget,
  type SupervisorConnectionState,
  type PreparedConnection,
} from "../connection/model.ts";
import type { RpcSession } from "../rpc/session.ts";
import { EnvironmentRegistry } from "../connection/registry.ts";
import { EnvironmentSupervisor } from "../connection/supervisor.ts";
import type { WsRpcProtocolClient } from "../rpc/protocol.ts";
import { createComputeEnvironmentAtoms, withManagedRuntimePolling } from "./compute.ts";

const PYTHON = ComputeLanguageId.make("python");
class ManagedStatusUnavailable extends Data.TaggedError("ManagedStatusUnavailable")<{
  readonly message: string;
}> {}
const ENV = EnvironmentId.make("test-server");
const initialStatus: ComputeManagedRuntimeStatus = {
  installed: false,
  generationId: null,
  selection: "existing",
  runtimeVersion: null,
  toolkitRevision: null,
  updateAvailable: false,
  operation: null,
  failureMessage: null,
};
const operation = {
  operationId: "setup-1",
  action: "install",
  phase: "verifying",
  startedAt: "2026-08-31T00:00:00Z",
  downloadedBytes: null,
  totalBytes: null,
} as const;

const harness = Effect.gen(function* () {
  let status = initialStatus;
  let statusAvailable = true;
  const inspected: Array<{ environmentId: string; cwd: string | null }> = [];
  const statusTarget = { environmentId: ENV, input: { languageId: PYTHON } };
  const supervisor = EnvironmentSupervisor.of({
    target: new PrimaryConnectionTarget({
      environmentId: ENV,
      label: "Test",
      httpBaseUrl: "https://test.invalid",
      wsBaseUrl: "wss://test.invalid",
    }),
    state: yield* SubscriptionRef.make<SupervisorConnectionState>({
      ...AVAILABLE_CONNECTION_STATE,
      desired: true,
      network: "online" as const,
      phase: "connected" as const,
      attempt: 1,
      generation: 1,
    }),
    session: yield* SubscriptionRef.make<Option.Option<RpcSession>>(
      Option.some({
        client: {
          [WS_METHODS.computeManagedRuntimeStatus]: () =>
            statusAvailable
              ? Effect.succeed(status)
              : Effect.fail(
                  new ManagedStatusUnavailable({
                    message: "Managed status is unavailable on this host.",
                  }),
                ),
          [WS_METHODS.computeManageRuntime]: () =>
            Effect.sync(() => {
              status = { ...status, operation };
              return status;
            }),
          [WS_METHODS.computeCancelManagedRuntime]: () =>
            Effect.sync(() => {
              status = { ...status, operation: null };
              return status;
            }),
          [WS_METHODS.computeInspectRuntimes]: (input: { cwd: string | null }) =>
            Effect.sync(() => {
              inspected.push({ environmentId: ENV, cwd: input.cwd });
              return {
                contractVersion: 1,
                scope: input.cwd === null ? "environment" : "project",
                languages: [
                  {
                    descriptor: {
                      languageId: PYTHON,
                      displayName: "Python",
                      sourceExtensions: [".py"],
                      capabilities: [],
                    },
                    enabled: true,
                    configuredExecutable: null,
                    managedRuntime: status,
                    toolkits: [],
                    runtimes: [],
                  },
                ],
              } satisfies ComputeRuntimeInspection;
            }),
        } as unknown as WsRpcProtocolClient,
        initialConfig: Effect.never,
        subscribeServerConfig: () => Stream.never,
        ready: Effect.void,
        probe: Effect.void,
        closed: Effect.never,
      }),
    ),
    prepared: yield* SubscriptionRef.make(Option.none<PreparedConnection>()),
    connect: Effect.void,
    disconnect: Effect.void,
    retryNow: Effect.void,
  });
  const environmentRegistry = EnvironmentRegistry.of({
    run: (_id, effect) => Effect.provideService(effect, EnvironmentSupervisor, supervisor),
    followStream: (_id, stream) => Stream.provideService(stream, EnvironmentSupervisor, supervisor),
  } as EnvironmentRegistry["Service"]);
  const runtime = Atom.runtime(Layer.succeed(EnvironmentRegistry, environmentRegistry));
  const settings = Atom.make<ScientificComputingSettings | undefined>({
    schemaVersion: 1,
    languages: { [PYTHON]: { enabled: true, executable: "" } },
  });
  const atoms = createComputeEnvironmentAtoms(runtime, () => settings);
  const registry = AtomRegistry.make();
  const project = atoms.runtimes({
    environmentId: ENV,
    input: { cwd: "/project", refresh: false },
  });
  const settingsQuery = atoms.runtimes({
    environmentId: ENV,
    input: { cwd: null, refresh: false },
  });
  const read = <A, E>(atom: Atom.Atom<AsyncResult.AsyncResult<A, E>>) =>
    AtomRegistry.getResult(registry, atom, { suspendOnWaiting: true });
  const observeStatus = () =>
    Effect.gen(function* () {
      registry.refresh(atoms.managedRuntime(statusTarget));
      yield* read(atoms.managedRuntime(statusTarget));
    });
  return {
    registry,
    atoms,
    project,
    settingsQuery,
    settings,
    statusTarget,
    read,
    observeStatus,
    inspected,
    setStatus: (value: ComputeManagedRuntimeStatus) => {
      status = value;
    },
    setStatusAvailable: (available: boolean) => {
      statusAvailable = available;
    },
  };
});

describe("shared compute runtime transitions", () => {
  it.live(
    "keeps ordinary discovery working when managed status fails and recovers on refresh",
    () =>
      Effect.gen(function* () {
        const h = yield* harness;
        try {
          h.setStatusAvailable(false);
          const unmount = h.registry.mount(h.project);
          expect((yield* h.read(h.project)).languages).toHaveLength(1);
          h.setStatusAvailable(true);
          h.setStatus({
            ...initialStatus,
            installed: true,
            selection: "managed",
            generationId: "recovered",
          });
          yield* Effect.promise(() =>
            h.atoms.refreshRuntimes.run(h.registry, {
              environmentId: ENV,
              input: { cwd: "/project", refresh: true },
            }),
          );
          expect((yield* h.read(h.project)).languages[0]?.managedRuntime?.generationId).toBe(
            "recovered",
          );
          unmount();
        } finally {
          h.registry.dispose();
        }
      }),
  );

  it.live("refreshes project and settings views when setup settles after Settings unmounts", () =>
    Effect.gen(function* () {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      const h = yield* harness;
      try {
        const leaveProject = h.registry.mount(h.project);
        const leaveSettings = h.registry.mount(h.settingsQuery);
        yield* h.read(h.project);
        yield* h.read(h.settingsQuery);
        yield* Effect.promise(() =>
          h.atoms.manageRuntime.run(h.registry, {
            ...h.statusTarget,
            input: { languageId: PYTHON, action: "install" },
          }),
        );
        yield* h.read(h.atoms.managedRuntime(h.statusTarget));
        leaveSettings();
        h.setStatus({
          ...initialStatus,
          installed: true,
          selection: "managed",
          generationId: "generation-1",
        });
        yield* Effect.promise(() => vi.advanceTimersByTimeAsync(1_000));
        expect((yield* h.read(h.project)).languages[0]?.managedRuntime?.generationId).toBe(
          "generation-1",
        );
        expect((yield* h.read(h.settingsQuery)).languages[0]?.managedRuntime?.generationId).toBe(
          "generation-1",
        );
        leaveProject();
      } finally {
        h.registry.dispose();
        vi.useRealTimers();
      }
    }),
  );

  it.live("fetches a new snapshot after every compute surface was closed", () =>
    Effect.gen(function* () {
      const h = yield* harness;
      try {
        const unmount = h.registry.mount(h.project);
        yield* h.read(h.project);
        unmount();
        yield* Effect.yieldNow;
        h.setStatus({
          ...initialStatus,
          installed: true,
          selection: "managed",
          generationId: "completed-while-away",
        });
        const remount = h.registry.mount(h.project);
        expect((yield* h.read(h.project)).languages[0]?.managedRuntime?.generationId).toBe(
          "completed-while-away",
        );
        remount();
      } finally {
        h.registry.dispose();
      }
    }),
  );

  it.live("does not invalidate another server when an operation starts here", () =>
    Effect.gen(function* () {
      const h = yield* harness;
      try {
        const other = h.atoms.runtimes({
          environmentId: EnvironmentId.make("other-server"),
          input: { cwd: "/other", refresh: false },
        });
        const unmount = h.registry.mount(other);
        const before = yield* h.read(other);
        yield* Effect.promise(() =>
          h.atoms.manageRuntime.run(h.registry, {
            ...h.statusTarget,
            input: { languageId: PYTHON, action: "install" },
          }),
        );
        expect(yield* h.read(other)).toBe(before);
        unmount();
      } finally {
        h.registry.dispose();
      }
    }),
  );

  it.live(
    "detects same-version repair, removal and reinstall without requiring manual refresh",
    () =>
      Effect.gen(function* () {
        const h = yield* harness;
        try {
          const unmount = h.registry.mount(h.project);
          yield* h.read(h.project);
          for (const generationId of ["first", "repaired", null, "reinstalled"]) {
            h.setStatus({
              ...initialStatus,
              installed: generationId !== null,
              selection: generationId === null ? "existing" : "managed",
              generationId,
              runtimeVersion: "Python 3.12.13",
            });
            yield* h.observeStatus();
            expect((yield* h.read(h.project)).languages[0]?.managedRuntime?.generationId).toBe(
              generationId,
            );
          }
          unmount();
        } finally {
          h.registry.dispose();
        }
      }),
  );

  it.live("invalidates project inspection when executable/enabled settings change", () =>
    Effect.gen(function* () {
      const h = yield* harness;
      try {
        const unmount = h.registry.mount(h.project);
        yield* h.read(h.project);
        const before = h.inspected.length;
        h.registry.set(h.settings, {
          schemaVersion: 1,
          languages: { [PYTHON]: { enabled: false, executable: "/new/python" } },
        });
        yield* h.read(h.project);
        expect(h.inspected.length).toBeGreaterThan(before);
        unmount();
      } finally {
        h.registry.dispose();
      }
    }),
  );

  it.live("forwards a query refresh to inspection even when runtime identity has not changed", () =>
    Effect.gen(function* () {
      const h = yield* harness;
      try {
        const unmount = h.registry.mount(h.project);
        yield* h.read(h.project);
        const before = h.inspected.length;
        h.registry.refresh(h.project);
        yield* h.read(h.project);
        expect(h.inspected.length).toBeGreaterThan(before);
        unmount();
      } finally {
        h.registry.dispose();
      }
    }),
  );

  it.live("refreshes project inspection when setup is cancelled", () =>
    Effect.gen(function* () {
      const h = yield* harness;
      try {
        const unmount = h.registry.mount(h.project);
        yield* h.read(h.project);
        yield* Effect.promise(() =>
          h.atoms.manageRuntime.run(h.registry, {
            ...h.statusTarget,
            input: { languageId: PYTHON, action: "install" },
          }),
        );
        expect((yield* h.read(h.project)).languages[0]?.managedRuntime?.operation).not.toBeNull();
        yield* Effect.promise(() => h.atoms.cancelManagedRuntime.run(h.registry, h.statusTarget));
        expect((yield* h.read(h.project)).languages[0]?.managedRuntime).toMatchObject({
          installed: false,
          operation: null,
        });
        unmount();
      } finally {
        h.registry.dispose();
      }
    }),
  );

  it.live("does not repeat Python inspection for download progress alone", () =>
    Effect.gen(function* () {
      const h = yield* harness;
      try {
        h.setStatus({ ...initialStatus, operation });
        const unmount = h.registry.mount(h.project);
        yield* h.read(h.project);
        const before = h.inspected.length;
        h.setStatus({ ...initialStatus, operation: { ...operation, downloadedBytes: 100 } });
        yield* h.observeStatus();
        yield* h.read(h.project);
        expect(h.inspected.length).toBe(before);
        unmount();
      } finally {
        h.registry.dispose();
      }
    }),
  );

  it("polls only while an operation is running and cancels the timer on disposal", async () => {
    vi.useFakeTimers();
    const registry = AtomRegistry.make();
    let current = { ...initialStatus, operation } as ComputeManagedRuntimeStatus;
    let reads = 0;
    const source = Atom.make(() => {
      reads += 1;
      return AsyncResult.success(current);
    }).pipe(Atom.setIdleTTL(0));
    const observed = withManagedRuntimePolling(source);
    try {
      const unmount = registry.mount(observed);
      expect(reads).toBe(1);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(reads).toBe(2);
      current = { ...current, operation: null };
      await vi.advanceTimersByTimeAsync(1_000);
      const settledReads = reads;
      await vi.advanceTimersByTimeAsync(10_000);
      expect(reads).toBe(settledReads);
      current = { ...current, operation };
      registry.refresh(observed);
      unmount();
      await vi.advanceTimersByTimeAsync(10_000);
      expect(reads).toBe(settledReads + 1);
    } finally {
      registry.dispose();
      vi.useRealTimers();
    }
  });
});
