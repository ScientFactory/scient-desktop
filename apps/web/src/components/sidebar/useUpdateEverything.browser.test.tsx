import { render as _fixtureRender, type Screen, act } from "../../../test/render";
import { useLayoutEffect, useSyncExternalStore } from "react";

import {
  EnvironmentId,
  type AuthSessionState,
  type ServerSelfUpdateCapability,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Option from "effect/Option";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";
import { describe, expect, it, vi } from "vite-plus/test";

import type { ServerUpdateOutcome, ServerUpdateTarget } from "../ServerUpdateAction";
import {
  failedUpdateRunServer,
  serverRetryTarget,
} from "~/scient/desktopUpdate/otherUpdates.logic";
import { retryUpdateRunServer } from "~/scient/desktopUpdate/updateRunServers";
import type { UpdateEverythingMachine, UpdateRunMachine } from "./updateEverything.logic";

type TestEnvironment = {
  environmentId: EnvironmentId;
  label: string;
  serverConfig: NonNullable<UpdateEverythingMachine["serverConfig"]>;
  connection: { phase: "connected" | "offline" };
  entry: { target: { _tag: "SshConnectionTarget" } };
};

const testState = vi.hoisted(() => ({
  readRegistry: (): AtomRegistry.AtomRegistry | undefined => undefined,
  environments: [] as TestEnvironment[],
  sessions: new Map<string, Atom.Writable<AsyncResult.AsyncResult<AuthSessionState, never>>>(),
  updateStateAtom: undefined as Atom.Atom<{ status: "idle" }> | undefined,
  availability: undefined as AsyncResult.AsyncResult<boolean, string> | undefined,
  updateProviders: vi.fn<() => Promise<ReadonlyArray<never>>>(),
  // Atoms the run module writes with `set`, so a test can subscribe to them like a component.
  publishedAtoms: new Set<Atom.Writable<unknown, unknown>>(),
  setRun: vi.fn<(typeof import("./updateEverythingRun"))["setUpdateEverythingRun"]>(),
  settleMachine:
    vi.fn<
      (
        environmentId: EnvironmentId,
        failure: string | null,
        options?: { readonly serverUpdated?: boolean; readonly providerFailure?: string | null },
      ) => void
    >(),
  // The real run module, so a Retry runs against what the hook last published.
  runModule: undefined as typeof import("./updateEverythingRun") | undefined,
  showResult: vi.fn<(result: { readonly failures: ReadonlyArray<string> }) => void>(),
  updateServer:
    vi.fn<
      (request: {
        environmentId: EnvironmentId;
        input: { targetVersion: string };
      }) => Promise<AsyncResult.AsyncResult<{ targetVersion: string }, never>>
    >(),
}));

vi.mock("~/branding", () => ({ APP_VERSION: "0.6.2" }));
vi.mock("~/env", () => ({ isElectron: true }));
vi.mock("@effect/atom-react", () => ({
  useAtomValue: (atom: Atom.Atom<unknown>) => testState.readRegistry()!.get(atom),
}));
vi.mock("~/state/environments", () => ({
  useEnvironments: () => ({ environments: testState.environments }),
  useEnvironmentProviders: () => new Map(),
}));
vi.mock("~/state/session", async () => {
  const { environmentAtomList } = await import("~/state/environmentAtomList");
  return {
    environmentSession: { sessionStateAtom: (id: string) => testState.sessions.get(id)! },
    environmentSessionStatesAtom: environmentAtomList("test-session-states", (id) =>
      testState.sessions.get(id)!,
    ),
  };
});
vi.mock("~/rpc/atomRegistry", () => ({
  appAtomRegistry: {
    get: (atom: Atom.Atom<unknown>) => testState.readRegistry()!.get(atom),
    update: <R, W>(atom: Atom.Writable<R, W>, f: (value: R) => W) =>
      testState.readRegistry()!.update(atom, f),
    set: <R, W>(atom: Atom.Writable<R, W>, value: W) => {
      testState.publishedAtoms.add(atom as Atom.Writable<unknown, unknown>);
      testState.readRegistry()!.set(atom, value);
    },
  },
}));
vi.mock("~/state/server", async () => {
  const { environmentAtomList } = await import("~/state/environmentAtomList");
  return {
    environmentUpdateStatesAtom: environmentAtomList(
      "test-update-states",
      () => testState.updateStateAtom!,
    ),
    serverEnvironment: {
      updateStateAtom: () => testState.updateStateAtom!,
      updateServer: Symbol("update-server"),
      providersValueAtom: (id: string) => Atom.make(() => machineProviders.get(id) ?? []),
    },
    updateOutdatedServer: Symbol("update-outdated-server"),
  };
});
vi.mock("~/state/use-atom-command", () => ({
  useAtomCommand: () => testState.updateServer,
}));
vi.mock("~/state/threads", () => ({
  environmentThreadShells: { environmentThreadsAtom: () => Atom.make([]) },
}));
vi.mock("~/hooks/useSettings", () => ({ useEnvironmentSettings: () => false }));
vi.mock("~/hooks/useCopyToClipboard", () => ({ useCopyToClipboard: () => ({}) }));
vi.mock("../ProviderUpdatesAction", () => ({
  useProviderUpdates: () => ({ machines: [], updateAll: testState.updateProviders }),
}));
vi.mock("~/scient/desktopUpdate/serverReleaseAvailability", async (importOriginal) => {
  const original =
    await importOriginal<typeof import("~/scient/desktopUpdate/serverReleaseAvailability")>();
  return {
    ...original,
    useScientServerReleasePublished: () =>
      original.isCurrentScientServerReleasePublished(testState.availability!),
  };
});
// SCIENT-FORK:START — managed runtimes are part of the pass.
const managedState = vi.hoisted(() => ({
  targets: [] as Array<
    import("~/scient/providerConnection/ManagedRuntimeUpdateNotification.logic").ManagedRuntimeUpdateTarget
  >,
  update:
    vi.fn<
      (
        targets: ReadonlyArray<unknown>,
      ) => Promise<
        Array<
          import("~/scient/providerConnection/ManagedRuntimeUpdateNotification.logic").ManagedRuntimeUpdateRun
        >
      >
    >(),
}));
// A machine's current providers, which the server busy rule reads at dispatch.
const machineProviders = vi.hoisted(() => new Map<string, ReadonlyArray<unknown>>());
vi.mock("~/scient/providerConnection/environmentUpdateWatch", () => ({
  watchEnvironmentProviders: vi.fn(),
}));
vi.mock("~/scient/providerConnection/useProviderLifecycleController", () => ({
  useStartProviderRuntimeAction: vi.fn(),
}));
vi.mock("~/scient/providerConnection/useManagedRuntimeUpdates", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("~/scient/providerConnection/useManagedRuntimeUpdates")
  >()),
  useManagedRuntimeUpdates: () => ({
    candidates: [],
    targets: managedState.targets,
    runs: new Map(),
    update: managedState.update,
  }),
}));
// SCIENT-FORK:END
vi.mock("../ui/toast", () => ({
  hiddenToastActionProps: { children: null },
  toastManager: { add: vi.fn() },
  stackedThreadToast: vi.fn(),
}));
vi.mock("./updateEverythingRun", async (importOriginal) => {
  const original = await importOriginal<typeof import("./updateEverythingRun")>();
  testState.runModule = original;
  return {
    ...original,
    setUpdateEverythingRun: testState.setRun,
    settleUpdateRunMachine: testState.settleMachine,
    showUpdateEverythingResult: testState.showResult,
    saveUpdateEverythingResult: () => {},
    clearSavedUpdateEverythingResult: () => {},
    // No server restarts into its update here, so each hands off when its update finishes.
    waitForServerUpdateHandoff: (_environmentId: EnvironmentId, finished: Promise<unknown>) =>
      finished.then(
        () => {},
        () => {},
      ),
    waitForUpdateRestart: async () => false,
    publishQualifiedUpdateRunServers: original.publishQualifiedUpdateRunServers,
  };
});

import { useUpdateEverything } from "./useUpdateEverything";

const session: AuthSessionState = {
  authenticated: true,
  scopes: ["environment:maintain"],
  auth: {
    policy: "remote-reachable",
    bootstrapMethods: ["one-time-token"],
    sessionMethods: ["bearer-access-token"],
    sessionCookieName: "t3_session",
    serverUpdateScope: "environment:maintain",
  },
};

function environment(id: string, selfUpdate: ServerSelfUpdateCapability): TestEnvironment {
  return {
    environmentId: EnvironmentId.make(id),
    label: id,
    serverConfig: {
      environment: {
        environmentId: EnvironmentId.make(id),
        label: id,
        platform: { os: "linux", arch: "x64" },
        serverVersion: "0.6.1",
        capabilities: {
          repositoryIdentity: true,
          serverSelfUpdate: selfUpdate,
          ...(selfUpdate === "desktop-managed" ? { desktopAppUpdate: true } : {}),
          threadRestartContinuation: true,
          serverUpdateThreadContinuation: true,
        },
      },
      settings: { continueThreadsAfterServerUpdate: true },
    },
    connection: { phase: "connected" },
    entry: { target: { _tag: "SshConnectionTarget" } },
  };
}

function Probe({ _fixture, version = null }: { version?: string | null } & { _fixture: _Fixture }) {
  const value = useUpdateEverything(version);
  useLayoutEffect(() => {
    _fixture.publishCurrent(value);
  });
  return null;
}

async function _setupFixture0(_fixture: _Fixture) {
  const registry = AtomRegistry.make();
  testState.readRegistry = () => registry;
  _fixture.stack.defer(() => {
    try {
      registry.dispose();
    } finally {
      testState.readRegistry = () => undefined;
    }
  });
  testState.environments = [
    environment("service", "boot-service"),
    environment("desktop", "desktop-managed"),
  ];
  testState.sessions = new Map(
    ["service", "desktop", "new-machine"].map(
      (id) =>
        [
          id,
          Atom.make<AsyncResult.AsyncResult<AuthSessionState, never>>(AsyncResult.success(session)),
        ] as const,
    ),
  );
  testState.updateStateAtom = Atom.make({ status: "idle" as const });
  testState.availability = AsyncResult.success(true);
  testState.updateProviders.mockReset().mockResolvedValue([]);
  // SCIENT-FORK:START — managed runtimes are part of the pass.
  managedState.targets = [];
  machineProviders.clear();
  managedState.update.mockReset().mockResolvedValue([]);
  // SCIENT-FORK:END
  testState.settleMachine.mockReset();
  testState.setRun.mockReset();
  testState.publishedAtoms.clear();
  testState.showResult.mockReset();
  testState.updateServer
    .mockReset()
    .mockImplementation(async ({ input }) =>
      AsyncResult.success({ targetVersion: input.targetVersion }),
    );
  _fixture.publishCurrent(undefined);
}

async function _cleanupFixture1(_fixture: _Fixture) {
  await act(async () => await _fixture.root0?.unmount());
  _fixture.root0 = undefined;
}

async function holdPass(_fixture: _Fixture) {
  let finishProviders = () => {};
  testState.updateProviders.mockImplementationOnce(
    () =>
      new Promise<ReadonlyArray<never>>((resolve) => {
        finishProviders = () => resolve([]);
      }),
  );
  await act(async () => {
    _fixture.root0 = _fixture.stack.use(
      await _fixtureRender(null, { container: document.createElement("div"), router: false }),
    );
    await _fixture.root0.rerender(<Probe _fixture={_fixture} />);
  });
  let run: Promise<void> | undefined;
  await act(() => {
    run = _fixture.current!.run({});
  });
  expect(testState.updateProviders).toHaveBeenCalledOnce();
  expect(testState.updateServer).not.toHaveBeenCalled();
  return {
    finish: async () =>
      await act(async () => {
        finishProviders();
        await run;
      }),
  };
}

it.each(["failure", "refresh"] as const)(
  "withdraws a held exact-service target on current %s, preserving remote desktop and recovery",
  async (phase) => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    const pass = await holdPass(_fixture);
    const previous = AsyncResult.success(true);
    testState.availability =
      phase === "failure"
        ? AsyncResult.failureWithPrevious(Cause.fail("403"), { previous: Option.some(previous) })
        : AsyncResult.waiting(previous);
    await act(async () => await _fixture.root0!.rerender(<Probe _fixture={_fixture} />));
    await pass.finish();
    expect(testState.updateServer.mock.calls).toMatchObject([
      [{ environmentId: "desktop", input: { targetVersion: "0.6.2" } }],
    ]);

    testState.availability = AsyncResult.success(true);
    await act(async () => await _fixture.root0!.rerender(<Probe _fixture={_fixture} />));
    testState.updateServer.mockClear();
    await act(async () => {
      await _fixture.current!.run({});
    });
    expect(testState.updateServer.mock.calls.map(([request]) => request.environmentId)).toEqual([
      "service",
      "desktop",
    ]);
  },
);

it.each(["scope", "offline", "channel", "capability", "mechanism", "current"] as const)(
  "does not admit a changed %s target or a newly eligible machine into a confirmed pass",
  async (change) => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    const pass = await holdPass(_fixture);
    const first = testState.environments[0]!;
    if (change === "scope") {
      testState
        .readRegistry()!
        .set(testState.sessions.get("service")!, AsyncResult.success({ ...session, scopes: [] }));
    }
    const capabilities = { ...first.serverConfig.environment.capabilities };
    if (change === "capability") delete capabilities.serverSelfUpdate;
    if (change === "mechanism") {
      capabilities.serverSelfUpdate = "desktop-managed";
      capabilities.desktopAppUpdate = true;
    }
    testState.environments = [
      {
        ...first,
        ...(change === "offline" ? { connection: { phase: "offline" as const } } : {}),
        serverConfig: {
          ...first.serverConfig,
          environment: {
            ...first.serverConfig.environment,
            capabilities,
            serverVersion:
              change === "channel"
                ? "0.6.1-beta.20261013.1"
                : change === "current"
                  ? "0.6.2"
                  : "0.6.1",
          },
        },
      },
      testState.environments[1]!,
      environment("new-machine", "boot-service"),
    ];
    await act(async () => await _fixture.root0!.rerender(<Probe _fixture={_fixture} />));
    await pass.finish();
    expect(testState.updateServer.mock.calls.map(([request]) => request.environmentId)).toEqual([
      "desktop",
    ]);
  },
);

it("does not change the confirmed version during a held provider step", async () => {
  await using _fixture = _createFixture();
  _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
  await _setupFixture0(_fixture);

  const pass = await holdPass(_fixture);
  await act(
    async () => await _fixture.root0!.rerender(<Probe _fixture={_fixture} version="0.6.3" />),
  );
  await pass.finish();
  expect(testState.updateServer).not.toHaveBeenCalled();
});

it("retires an unmounted held pass without disabling a newly confirmed pass", async () => {
  await using _fixture = _createFixture();
  _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
  await _setupFixture0(_fixture);

  const pass = await holdPass(_fixture);
  await act(async () => await _fixture.root0!.unmount());
  _fixture.root0 = undefined;
  testState.availability = AsyncResult.failureWithPrevious(Cause.fail("403"), {
    previous: Option.some(AsyncResult.success(true)),
  });
  await act(async () => {
    _fixture.root0 = _fixture.stack.use(
      await _fixtureRender(null, { container: document.createElement("div"), router: false }),
    );
    await _fixture.root0.rerender(<Probe _fixture={_fixture} />);
  });
  await pass.finish();
  expect(testState.updateServer).not.toHaveBeenCalled();
  // The withdrawn servers settle and are named in the summary instead of waiting forever.
  const withdrawn = "Not updated; it was no longer eligible when servers updated.";
  expect(testState.settleMachine.mock.calls).toEqual([
    ["service", withdrawn, { providerFailure: null }],
    ["desktop", withdrawn, { providerFailure: null }],
  ]);
  expect(testState.showResult.mock.calls[0]?.[0].failures).toEqual([
    "service: Not updated; it was no longer eligible when servers updated.",
    "desktop: Not updated; it was no longer eligible when servers updated.",
  ]);

  testState.availability = AsyncResult.success(true);
  await act(async () => await _fixture.root0!.rerender(<Probe _fixture={_fixture} />));
  await act(async () => {
    await _fixture.current!.run({});
  });
  expect(testState.updateServer.mock.calls.map(([request]) => request.environmentId)).toEqual([
    "service",
    "desktop",
  ]);
});

/** Whether the sidebar circle offers Retry for a server the pass failed or withdrew. */
function circleOffersRetry(run: typeof import("./updateEverythingRun"), id: string): boolean {
  const failure = failedUpdateRunServer(run.useUpdateEverythingRun(), EnvironmentId.make(id));
  return (
    failure !== null &&
    serverRetryTarget(failure.target, run.useQualifiedUpdateRunServers()) !== null
  );
}

/** The circle's Retry for each server, letting its machine-settle wait resolve. */
async function retryFromCircle(
  run: typeof import("./updateEverythingRun"),
  ids: ReadonlyArray<string>,
  update: (
    target: ServerUpdateTarget,
    options: { readonly quiet: boolean },
  ) => Promise<ServerUpdateOutcome>,
) {
  const started: string[] = [];
  await act(async () => {
    for (const id of ids) {
      if (retryUpdateRunServer(EnvironmentId.make(id), run.useQualifiedUpdateRunServers(), update))
        started.push(id);
    }
  });
  await vi.waitFor(() => {
    for (const id of started) {
      expect(
        run.useUpdateEverythingRun()?.machines.find((machine) => machine.environmentId === id)
          ?.result,
      ).not.toBe(null);
    }
  });
}

function failedRunMachine(target: ServerUpdateTarget): UpdateRunMachine {
  return {
    environmentId: target.environmentId,
    label: target.serverLabel,
    updatesProviders: false,
    server: target,
    handedOffVersion: null,
    startedAt: 0,
    result: "failed",
    failure: "Server update failed",
    providerFailure: null,
  };
}

it.each(["availability", "scope", "version", "mechanism", "owner"] as const)(
  "does not retry a failed server whose target lost its %s, and still retries an eligible one",
  async (change) => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    const run = testState.runModule!;
    testState.setRun.mockImplementation(run.setUpdateEverythingRun);
    testState.settleMachine.mockImplementation(run.settleUpdateRunMachine);
    await act(async () => {
      _fixture.root0 = _fixture.stack.use(
        await _fixtureRender(null, { container: document.createElement("div"), router: false }),
      );
      await _fixture.root0.rerender(<Probe _fixture={_fixture} />);
    });
    const confirmed = (id: string, selfUpdate: ServerSelfUpdateCapability): ServerUpdateTarget => ({
      environmentId: EnvironmentId.make(id),
      serverLabel: id,
      selfUpdate,
      targetVersion: "0.6.2",
    });
    const service = confirmed("service", "boot-service");
    const desktop = confirmed("desktop", "desktop-managed");
    const savedService =
      change === "version"
        ? { ...service, targetVersion: "0.6.3" }
        : change === "mechanism"
          ? { ...service, selfUpdate: "desktop-managed" as const }
          : service;
    run.setUpdateEverythingRun(() => ({
      localVersion: null,
      phase: "servers",
      restartAt: null,
      machines: [failedRunMachine(savedService), failedRunMachine(desktop)],
    }));
    if (change === "availability") {
      testState.availability = AsyncResult.failureWithPrevious(Cause.fail("403"), {
        previous: Option.some(AsyncResult.success(true)),
      });
    }
    if (change === "scope") {
      testState
        .readRegistry()!
        .set(testState.sessions.get("service")!, AsyncResult.success({ ...session, scopes: [] }));
    }
    if (change === "owner") {
      await act(async () => await _fixture.root0!.unmount());
      _fixture.root0 = undefined;
    } else {
      await act(async () => await _fixture.root0!.rerender(<Probe _fixture={_fixture} />));
    }

    const update = vi.fn<(target: ServerUpdateTarget) => Promise<ServerUpdateOutcome>>(
      async () => ({ status: "updated" }),
    );
    await retryFromCircle(run, ["service", "desktop"], update);

    if (change === "owner") {
      expect(update).not.toHaveBeenCalled();
    } else {
      // The eligible retry keeps its confirmed version and mechanism.
      expect(update.mock.calls).toEqual([
        [
          expect.objectContaining({
            environmentId: "desktop",
            selfUpdate: "desktop-managed",
            targetVersion: "0.6.2",
          }),
          { quiet: false },
        ],
      ]);
    }
    const machines = run.useUpdateEverythingRun()?.machines ?? [];
    // The ineligible server keeps its confirmed target and failure, without Retry.
    expect(machines.find((machine) => machine.environmentId === "service")).toMatchObject({
      server: savedService,
      result: "failed",
      failure: "Server update failed",
    });
    expect(circleOffersRetry(run, "service")).toBe(false);
  },
);

// SCIENT-FORK:START — eligibility readers hear only real changes, not every owner render.
it("does not notify eligibility readers when its owner re-renders unchanged", async () => {
  await using _fixture = _createFixture();
  _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
  await _setupFixture0(_fixture);

  await act(async () => {
    _fixture.root0 = _fixture.stack.use(
      await _fixtureRender(null, { container: document.createElement("div"), router: false }),
    );
    await _fixture.root0.rerender(<Probe _fixture={_fixture} />);
  });
  expect(testState.publishedAtoms.size).toBe(1);
  const [qualified] = testState.publishedAtoms;
  let notifications = 0;
  const unsubscribe = testState.readRegistry()!.subscribe(qualified!, () => {
    notifications += 1;
  });
  const readerRendered = vi.fn();
  function Reader() {
    readerRendered();
    useSyncExternalStore(
      (onChange) => testState.readRegistry()!.subscribe(qualified!, onChange),
      () => testState.readRegistry()!.get(qualified!),
    );
    return null;
  }
  let reader: Screen | undefined;
  await act(async () => {
    reader = _fixture.stack.use(
      await _fixtureRender(null, { container: document.createElement("div"), router: false }),
    );
    await reader.rerender(<Reader />);
  });
  const rendersBefore = readerRendered.mock.calls.length;
  await act(async () => await _fixture.root0!.rerender(<Probe _fixture={_fixture} />));
  await act(async () => await _fixture.root0!.rerender(<Probe _fixture={_fixture} />));
  expect(notifications).toBe(0);
  expect(readerRendered).toHaveBeenCalledTimes(rendersBefore);

  // A real eligibility change still reaches readers once.
  testState.environments = [testState.environments[1]!];
  await act(async () => await _fixture.root0!.rerender(<Probe _fixture={_fixture} />));
  expect(notifications).toBe(1);
  expect(readerRendered).toHaveBeenCalledTimes(rendersBefore + 1);
  unsubscribe();
  await act(async () => await reader!.unmount());
});
// SCIENT-FORK:END

// SCIENT-FORK:START — a withdrawn server keeps its confirmed target, so the circle offers Retry once
// that target is eligible again, and never sends a stale one.
describe("a server withdrawn when its step starts", () => {
  /** Runs a pass whose service goes offline during the provider step, recording the real run. */
  async function passWithOfflineService(_fixture: _Fixture) {
    const run = testState.runModule!;
    testState.setRun.mockImplementation(run.setUpdateEverythingRun);
    testState.settleMachine.mockImplementation(run.settleUpdateRunMachine);
    const pass = await holdPass(_fixture);
    const [service, desktop] = testState.environments;
    testState.environments = [{ ...service!, connection: { phase: "offline" } }, desktop!];
    await act(async () => await _fixture.root0!.rerender(<Probe _fixture={_fixture} />));
    await pass.finish();
    expect(testState.updateServer.mock.calls.map(([request]) => request.environmentId)).toEqual([
      "desktop",
    ]);
    testState.updateServer.mockClear();
    return { run, service: service! };
  }

  it("offers Retry once it is back online and retries its current eligible target", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    const { run, service } = await passWithOfflineService(_fixture);
    expect(run.useUpdateEverythingRun()?.machines).toMatchObject([
      {
        environmentId: "service",
        result: "failed",
        failure: "Not updated; it was no longer eligible when servers updated.",
        server: { environmentId: "service", targetVersion: "0.6.2", selfUpdate: "boot-service" },
      },
      { environmentId: "desktop", result: "done", server: null },
    ]);
    // While it stays offline, nothing is retried.
    expect(circleOffersRetry(run, "service")).toBe(false);
    const update = vi.fn<(target: ServerUpdateTarget) => Promise<ServerUpdateOutcome>>(
      async () => ({ status: "updated" }),
    );
    await retryFromCircle(run, ["service"], update);
    expect(update).not.toHaveBeenCalled();
    expect(run.useUpdateEverythingRun()?.machines[0]).toMatchObject({
      result: "failed",
      failure: "Not updated; it was no longer eligible when servers updated.",
      server: { environmentId: "service", targetVersion: "0.6.2" },
    });
    expect(circleOffersRetry(run, "service")).toBe(false);

    // Back online: Retry returns and takes its current target.
    testState.environments = [service, testState.environments[1]!];
    await act(async () => await _fixture.root0!.rerender(<Probe _fixture={_fixture} />));
    expect(circleOffersRetry(run, "service")).toBe(true);
    await retryFromCircle(run, ["service"], update);
    expect(update.mock.calls).toEqual([
      [
        expect.objectContaining({
          environmentId: "service",
          selfUpdate: "boot-service",
          targetVersion: "0.6.2",
        }),
        { quiet: false },
      ],
    ]);
  });

  it.each(["version", "mechanism"] as const)(
    "never retries a target whose confirmed %s was replaced",
    async (change) => {
      await using _fixture = _createFixture();
      _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
      await _setupFixture0(_fixture);

      const { run, service } = await passWithOfflineService(_fixture);
      const capabilities = { ...service.serverConfig.environment.capabilities };
      if (change === "mechanism") {
        capabilities.serverSelfUpdate = "desktop-managed";
        capabilities.desktopAppUpdate = true;
      }
      testState.environments = [
        {
          ...service,
          serverConfig: {
            ...service.serverConfig,
            environment: { ...service.serverConfig.environment, capabilities },
          },
        },
        testState.environments[1]!,
      ];
      // Online and behind again, but for a different version or mechanism than confirmed.
      await act(
        async () =>
          await _fixture.root0!.rerender(
            <Probe _fixture={_fixture} version={change === "version" ? "0.6.3" : null} />,
          ),
      );
      expect(run.useQualifiedUpdateRunServers()).toContainEqual(
        expect.objectContaining({ environmentId: "service" }),
      );
      expect(circleOffersRetry(run, "service")).toBe(false);
      const update = vi.fn<(target: ServerUpdateTarget) => Promise<ServerUpdateOutcome>>(
        async () => ({ status: "updated" }),
      );
      await retryFromCircle(run, ["service"], update);
      expect(update).not.toHaveBeenCalled();
    },
  );
});
// SCIENT-FORK:END

// SCIENT-FORK:START — managed runtimes are part of the pass; SSH package remotes follow this app.
describe("Scient-managed runtimes and self-updating remotes", () => {
  const lab = EnvironmentId.make("lab");
  const managedTarget = {
    environmentId: lab,
    environmentLabel: "lab",
    instanceId: "codex" as never,
    driver: "codex" as never,
    availableVersion: "0.157.1",
  };
  function managedRun(
    outcome: import("~/scient/providerConnection/ManagedRuntimeUpdateNotification.logic").ManagedRuntimeUpdateOutcome,
    waitingMessage: string | null = null,
  ) {
    return { target: managedTarget, operationId: "op-1", observed: true, outcome, waitingMessage };
  }

  it("offers and describes a managed runtime update when nothing else is behind", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    testState.environments = [];
    managedState.targets = [managedTarget];
    await act(async () => {
      _fixture.root0 = _fixture.stack.use(
        await _fixtureRender(null, { container: document.createElement("div"), router: false }),
      );
      await _fixture.root0.rerender(<Probe _fixture={_fixture} />);
    });
    expect(_fixture.current!.hasUpdates).toBe(true);
    expect(_fixture.current!.summary).toBe("Update 1 provider");
    expect(_fixture.current!.rows).toMatchObject([{ label: "lab", providers: ["Codex"] }]);
  });

  it("updates managed runtimes before servers and hands off a staged one", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    managedState.targets = [managedTarget];
    let finishManaged = (_runs: ReturnType<typeof managedRun>[]) => {};
    managedState.update.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishManaged = resolve;
        }),
    );
    await act(async () => {
      _fixture.root0 = _fixture.stack.use(
        await _fixtureRender(null, { container: document.createElement("div"), router: false }),
      );
      await _fixture.root0.rerender(<Probe _fixture={_fixture} />);
    });
    let run: Promise<void> | undefined;
    await act(() => {
      run = _fixture.current!.run({});
    });
    expect(managedState.update).toHaveBeenCalledWith([managedTarget], { inPass: true });
    expect(testState.updateServer).not.toHaveBeenCalled();
    await act(async () => {
      finishManaged([managedRun({ status: "pending" }, "Waiting for 1 running turn.")]);
      await run;
    });
    expect(testState.updateServer).toHaveBeenCalledTimes(2);
    expect(testState.showResult).toHaveBeenCalledWith(
      expect.objectContaining({ updatedProviders: 0, failures: [] }),
    );
  });

  it("reports a managed runtime failure in the pass summary", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    managedState.targets = [managedTarget];
    managedState.update.mockResolvedValueOnce([
      managedRun({ status: "failed", message: "Checksum mismatch." }),
    ]);
    await act(async () => {
      _fixture.root0 = _fixture.stack.use(
        await _fixtureRender(null, { container: document.createElement("div"), router: false }),
      );
      await _fixture.root0.rerender(<Probe _fixture={_fixture} />);
    });
    await act(async () => {
      await _fixture.current!.run({});
    });
    expect(testState.showResult).toHaveBeenCalledWith(
      expect.objectContaining({ failures: ["lab · Codex: Checksum mismatch."] }),
    );
  });

  it("does not list an SSH package remote as needing a manual update", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    const manual = (id: string, tag: string): TestEnvironment => {
      const base = environment(id, "boot-service");
      const { serverSelfUpdate: _omitted, ...capabilities } =
        base.serverConfig.environment.capabilities;
      return {
        ...base,
        entry: { target: { _tag: tag, connectionId: id } } as TestEnvironment["entry"],
        serverConfig: {
          ...base.serverConfig,
          environment: { ...base.serverConfig.environment, capabilities },
        },
      };
    };
    testState.environments = [
      manual("ssh", "SshConnectionTarget"),
      manual("bearer", "BearerConnectionTarget"),
    ];
    testState.sessions.set(
      "bearer",
      Atom.make<AsyncResult.AsyncResult<AuthSessionState, never>>(AsyncResult.success(session)),
    );
    testState.sessions.set(
      "ssh",
      Atom.make<AsyncResult.AsyncResult<AuthSessionState, never>>(AsyncResult.success(session)),
    );
    await act(async () => {
      _fixture.root0 = _fixture.stack.use(
        await _fixtureRender(null, { container: document.createElement("div"), router: false }),
      );
      await _fixture.root0.rerender(<Probe _fixture={_fixture} />);
    });
    expect(_fixture.current!.rows.filter((row) => row.skipped !== null)).toMatchObject([
      { environmentId: "bearer", label: "bearer", skipped: "needs a manual update" },
    ]);
  });
});
// SCIENT-FORK:END

// SCIENT-FORK:START — a server is not restarted while its machine updates a provider.
describe("servers on machines still updating providers", () => {
  const updatingProvider = {
    instanceId: "codex",
    driver: "codex",
    enabled: true,
    updateState: {
      status: "running",
      startedAt: null,
      finishedAt: null,
      message: null,
      output: null,
    },
  };

  async function runPass(
    _fixture: _Fixture,
    options: Parameters<ReturnType<typeof useUpdateEverything>["run"]>[0],
  ) {
    const run = testState.runModule!;
    testState.setRun.mockImplementation(run.setUpdateEverythingRun);
    testState.settleMachine.mockImplementation(run.settleUpdateRunMachine);
    await act(async () => {
      _fixture.root0 = _fixture.stack.use(
        await _fixtureRender(null, { container: document.createElement("div"), router: false }),
      );
      await _fixture.root0.rerender(<Probe _fixture={_fixture} />);
    });
    await act(async () => {
      await _fixture.current!.run(options);
    });
    return run;
  }

  it("leaves a busy machine's server to the circle and updates the rest", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    machineProviders.set("service", [updatingProvider]);
    const run = await runPass(_fixture, {});
    expect(testState.updateServer.mock.calls.map(([request]) => request.environmentId)).toEqual([
      "desktop",
    ]);
    // Neither failed nor updated: the circle offers it again once the machine is idle.
    expect(testState.showResult).toHaveBeenCalledWith(
      expect.objectContaining({ updatedServers: 1, failures: [] }),
    );
    expect(run.useUpdateEverythingRun()).toBeNull();
  });

  it("does not hold a server for a runtime staged to switch when idle", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    machineProviders.set("service", [
      {
        instanceId: "codex",
        driver: "codex",
        enabled: true,
        connection: {
          runtime: {
            operation: {
              operationId: "op",
              action: "update",
              status: "activating",
              waitingForIdle: true,
            },
          },
        },
      },
    ]);
    await runPass(_fixture, {});
    expect(testState.updateServer.mock.calls.map(([request]) => request.environmentId)).toEqual([
      "service",
      "desktop",
    ]);
  });

  it("asks the caller again for each server when its restart is due", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    await runPass(_fixture, { admitServer: (target) => target.environmentId !== "desktop" });
    expect(testState.updateServer.mock.calls.map(([request]) => request.environmentId)).toEqual([
      "service",
    ]);
    expect(testState.showResult).toHaveBeenCalledWith(
      expect.objectContaining({ updatedServers: 1, failures: [] }),
    );
  });
});
// SCIENT-FORK:END

function _createFixture() {
  let _published_current = undefined! as ReturnType<typeof useUpdateEverything> | undefined;

  const stack = new AsyncDisposableStack();
  const cleanup = new AsyncDisposableStack();
  return {
    get current() {
      return _published_current;
    },
    publishCurrent(next: typeof _published_current) {
      _published_current = next;
    },

    stack,
    cleanup,
    root0: undefined! as Screen | undefined,
    async [Symbol.asyncDispose]() {
      try {
        await cleanup.disposeAsync();
      } finally {
        await stack.disposeAsync();
      }
    },
  };
}
type _Fixture = ReturnType<typeof _createFixture>;
