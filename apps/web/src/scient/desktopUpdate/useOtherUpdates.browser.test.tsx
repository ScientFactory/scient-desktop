import { render as _fixtureRender, type Screen, act } from "../../../test/render";
import {
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
} from "@t3tools/contracts";
import { useLayoutEffect } from "react";

import * as Cause from "effect/Cause";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";
import { describe, expect, it, vi } from "vite-plus/test";

import type { ServerUpdateOutcome, ServerUpdateTarget } from "~/components/ServerUpdateAction";
import type { OtherServerUpdate } from "./otherUpdates.logic";

const lab = EnvironmentId.make("lab");

const testState = vi.hoisted(() => ({
  readRegistry: (): AtomRegistry.AtomRegistry | undefined => undefined,
  environments: [] as unknown[],
  providers: new Map<string, ReadonlyArray<ServerProvider>>(),
  serverStates: new Map<string, Atom.Writable<unknown>>(),
  updateProvider: vi.fn<(request: unknown) => Promise<unknown>>(),
  updateServer: vi.fn<(target: unknown, options: unknown) => Promise<unknown>>(),
  updateManaged: vi.fn<(targets: ReadonlyArray<unknown>) => Promise<unknown[]>>(),
  threads: [] as Array<{
    activeRunId: string | null;
    activityRunStatus?: string | null;
    status: string;
  }>,
  run: null as unknown,
  setRun: vi.fn((update: (run: unknown) => unknown) => {
    testState.run = update(testState.run);
  }),
  toasts: [] as Array<{ type: string; title: string }>,
}));

vi.mock("@effect/atom-react", () => ({
  useAtomValue: (atom: Atom.Atom<unknown>) => testState.readRegistry()!.get(atom),
}));
vi.mock("~/rpc/atomRegistry", () => ({
  appAtomRegistry: {
    get: (atom: Atom.Atom<unknown>) => testState.readRegistry()!.get(atom),
    set: <R, W>(atom: Atom.Writable<R, W>, value: W) => testState.readRegistry()!.set(atom, value),
    update: <R, W>(atom: Atom.Writable<R, W>, f: (value: R) => W) =>
      testState.readRegistry()!.update(atom, f),
  },
}));
vi.mock("~/state/environments", () => ({
  useEnvironments: () => ({ environments: testState.environments }),
  useEnvironmentProviders: () =>
    new Map(
      (testState.environments as Array<ReturnType<typeof remote>>).map((environment) => [
        environment.environmentId,
        testState.providers.get(environment.environmentId) ?? environment.serverConfig.providers,
      ]),
    ),
}));
vi.mock("~/state/server", () => ({
  serverEnvironment: {
    updateProvider: Symbol("update-provider"),
    providersValueAtom: (id: string) =>
      Atom.make(
        () =>
          testState.providers.get(id) ??
          (testState.environments as Array<ReturnType<typeof remote>>).find(
            (environment) => environment.environmentId === id,
          )?.serverConfig.providers ??
          [],
      ),
    updateStateAtom: (id: string) => {
      let atom = testState.serverStates.get(id);
      if (!atom) {
        atom = Atom.make<unknown>({ status: "idle" });
        testState.serverStates.set(id, atom);
      }
      return atom;
    },
  },
}));
vi.mock("~/state/use-atom-command", () => ({
  useAtomCommand: () => testState.updateProvider,
}));
vi.mock("~/components/ServerUpdateAction", () => ({
  useServerUpdate: () => testState.updateServer,
}));
vi.mock("~/components/sidebar/updateEverythingRun", () => ({
  useUpdateEverythingRun: () => testState.run,
  useQualifiedUpdateRunServers: () => [serverTarget],
  setUpdateEverythingRun: (update: (run: unknown) => unknown) => testState.setRun(update),
  settleUpdateRunMachine: vi.fn(),
}));
vi.mock("~/state/threads", () => ({
  environmentThreadShells: {
    environmentThreadsAtom: () => Atom.make(() => testState.threads),
  },
}));
vi.mock("~/components/ui/toast", () => ({
  hiddenToastActionProps: { children: null },
  stackedThreadToast: (options: object) => options,
  toastManager: {
    add: (options: { type: string; title: string }) => {
      testState.toasts.push({ type: options.type, title: options.title });
      return "toast";
    },
  },
}));
vi.mock("~/scient/providerConnection/useManagedRuntimeUpdates", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("~/scient/providerConnection/useManagedRuntimeUpdates")
  >()),
  useManagedRuntimeUpdates: () => ({
    candidates: [],
    targets: [],
    runs: new Map(),
    update: testState.updateManaged,
  }),
}));
vi.mock("~/scient/providerConnection/environmentUpdateWatch", () => ({
  watchEnvironmentProviders: vi.fn(),
}));
vi.mock("~/scient/providerConnection/useProviderLifecycleController", () => ({
  useStartProviderRuntimeAction: vi.fn(),
}));
import { useOtherUpdates } from "./useOtherUpdates";

const serverTarget: ServerUpdateTarget = {
  environmentId: lab,
  serverLabel: "lab-gpu",
  selfUpdate: "boot-service",
  targetVersion: "0.6.21",
};
const serverUpdate: OtherServerUpdate = {
  environmentId: lab,
  label: "lab-gpu",
  app: false,
  fromVersion: "0.6.20",
  toVersion: "0.6.21",
  target: serverTarget,
};

function codexCli(): ServerProvider {
  return {
    instanceId: ProviderInstanceId.make("codex"),
    driver: ProviderDriverKind.make("codex"),
    enabled: true,
    installed: true,
    version: "1.0.0",
    status: "ready",
    auth: { status: "authenticated", required: true },
    checkedAt: "2026-10-18T10:00:00.000Z",
    models: [],
    slashCommands: [],
    skills: [],
    versionAdvisory: {
      status: "behind_latest",
      currentVersion: "1.0.0",
      latestVersion: "1.1.0",
      updateCommand: "npm i -g @openai/codex",
      canUpdate: true,
      checkedAt: null,
      message: null,
    },
  };
}

function ompManaged(): ServerProvider {
  const { versionAdvisory: _cliAdvisory, ...base } = codexCli();
  return {
    ...base,
    instanceId: ProviderInstanceId.make("omp"),
    driver: ProviderDriverKind.make("omp"),
    connection: {
      methods: [],
      canDisconnect: true,
      operation: null,
      runtime: {
        source: "scient_managed",
        supportTier: "fully_assisted",
        target: "linux-x64",
        actions: ["update"],
        managedVersion: "2.0.0",
        availableManagedVersion: "2.1.0",
        previousManagedVersion: null,
        message: "Managed.",
        operation: null,
      },
    },
  };
}

function remote(providers: ServerProvider[]) {
  return {
    environmentId: lab,
    label: "lab-gpu",
    connection: { phase: "connected" },
    entry: { target: { _tag: "BearerConnectionTarget" } },
    serverConfig: { providers },
  };
}

function Probe({
  _fixture,
  servers,
}: { servers: ReadonlyArray<OtherServerUpdate> } & { _fixture: _Fixture }) {
  const value = useOtherUpdates(servers);
  useLayoutEffect(() => {
    _fixture.publishCurrent(value);
  });
  return null;
}

async function render(_fixture: _Fixture, servers: ReadonlyArray<OtherServerUpdate> = []) {
  await act(async () => {
    _fixture.root0 ??= _fixture.stack.use(
      await _fixtureRender(null, { container: document.createElement("div"), router: false }),
    );
    await _fixture.root0.rerender(<Probe _fixture={_fixture} servers={servers} />);
  });
}

const states = (_fixture: _Fixture) =>
  _fixture.current!.rows.map(({ item, state }) => [item.name, state]);

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
  testState.serverStates = new Map();
  testState.environments = [];
  testState.providers = new Map();
  testState.updateProvider.mockReset();
  testState.updateServer.mockReset();
  testState.updateManaged.mockReset().mockResolvedValue([]);
  testState.threads = [];
  testState.run = null;
  testState.toasts = [];
  testState.setRun.mockClear();
  _fixture.publishCurrent(undefined);
}

async function _cleanupFixture1(_fixture: _Fixture) {
  await act(async () => await _fixture.root0?.unmount());
  _fixture.root0 = undefined;
}

describe("useOtherUpdates", () => {
  it.each(["queued", "running"] as const)(
    "follows a non-default instance's %s update and latest result without a presentation change",
    async (status) => {
      await using _fixture = _createFixture();
      _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
      await _setupFixture0(_fixture);

      const original = codexCli();
      const defaultProvider = {
        ...original,
        updateState: {
          status: "failed" as const,
          startedAt: null,
          finishedAt: "2026-10-18T09:00:00.000Z",
          message: "Older default failure.",
          output: null,
        },
      };
      const other = {
        ...original,
        instanceId: ProviderInstanceId.make("codex-work"),
        updateState: { ...defaultProvider.updateState, status, finishedAt: null },
      };
      testState.environments = [remote([defaultProvider])];
      testState.providers.set(lab, [defaultProvider, other]);
      await render(_fixture);
      expect(_fixture.current!.circle).toBe("updating");
      expect(_fixture.current!.rows).toMatchObject([
        { item: { instanceId: "codex" }, state: { status: "updating" } },
      ]);

      testState.providers.set(lab, [
        defaultProvider,
        {
          ...other,
          updateState: {
            ...other.updateState,
            status: "succeeded",
            finishedAt: "2026-10-18T10:00:00.000Z",
          },
        },
      ]);
      await render(_fixture);
      expect(_fixture.current!.circle).toBe("done");
      expect(_fixture.current!.rows).toMatchObject([{ state: { status: "done" } }]);

      testState.providers.set(lab, [
        defaultProvider,
        {
          ...other,
          updateState: {
            ...other.updateState,
            status: "failed",
            finishedAt: "2026-10-18T11:00:00.000Z",
            message: "New attempt failed.",
          },
        },
      ]);
      await render(_fixture);
      expect(_fixture.current!.circle).toBe("failed");
      expect(_fixture.current!.rows).toMatchObject([
        { state: { status: "failed", reason: "New attempt failed.", retry: true } },
      ]);
    },
  );

  it("updates one provider in place and offers Retry after its failure", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    testState.environments = [remote([codexCli()])];
    let finish = (_result: unknown) => {};
    testState.updateProvider.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    await render(_fixture);
    expect(_fixture.current!.circle).toBe("idle");
    await act(async () => _fixture.current!.update(_fixture.current!.rows[0]!.item));
    await render(_fixture);
    expect(testState.updateProvider).toHaveBeenCalledWith({
      environmentId: lab,
      input: { provider: "codex", instanceId: "codex" },
    });
    expect(states(_fixture)).toEqual([
      ["Codex", { status: "updating", progress: { phase: "installing" } }],
    ]);
    expect(_fixture.current!.circle).toBe("updating");

    await act(async () => finish(AsyncResult.failure(Cause.fail(new Error("npm exited 1")))));
    await render(_fixture);
    expect(states(_fixture)).toEqual([
      ["Codex", { status: "failed", reason: "npm exited 1", retry: true }],
    ]);
    expect(_fixture.current!.circle).toBe("failed");

    testState.updateProvider.mockResolvedValueOnce(AsyncResult.success({ providers: [] }));
    await act(async () => _fixture.current!.retry(_fixture.current!.rows[0]!));
    expect(testState.updateProvider).toHaveBeenCalledTimes(2);
  });

  it("hands a managed runtime to the managed runtime updates", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    testState.environments = [remote([ompManaged()])];
    await render(_fixture);
    await act(async () => _fixture.current!.update(_fixture.current!.rows[0]!.item));
    expect(testState.updateManaged).toHaveBeenCalledWith([
      expect.objectContaining({ environmentId: lab, driver: "omp", availableVersion: "2.1.0" }),
    ]);
  });

  it("reports a finished server as done until forgotten, then the circle leaves", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    testState.environments = [remote([])];
    let finish = (_outcome: ServerUpdateOutcome) => {};
    testState.updateServer.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    await render(_fixture, [serverUpdate]);
    expect(states(_fixture)).toEqual([["lab-gpu server", { status: "idle" }]]);
    await act(async () => _fixture.current!.update(_fixture.current!.rows[0]!.item));
    expect(testState.updateServer).toHaveBeenCalledWith(serverTarget);
    await act(async () => finish({ status: "updated" }));
    // Back on the new version, the server is no longer behind.
    await render(_fixture, []);
    expect(states(_fixture)).toEqual([["lab-gpu server", { status: "done" }]]);
    expect(_fixture.current!.circle).toBe("done");

    await act(async () => _fixture.current!.forget([_fixture.current!.rows[0]!.item.key]));
    await render(_fixture, []);
    expect(_fixture.current!.rows).toEqual([]);
    expect(_fixture.current!.circle).toBeNull();
  });

  it("counts the running threads a server update would stop", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    testState.environments = [remote([])];
    testState.threads = [
      // A running turn with a follow-up queued behind it.
      { activeRunId: "run-1", activityRunStatus: "running", status: "queued" },
      { activeRunId: null, activityRunStatus: null, status: "idle" },
      // An older server without activity runs.
      { activeRunId: null, status: "starting" },
    ];
    await render(_fixture, [serverUpdate]);
    expect(_fixture.current!.stoppedThreads(_fixture.current!.rows[0]!.item)).toBe(2);
    // Threads that resume after the restart are not stopped.
    await render(_fixture, [
      {
        ...serverUpdate,
        target: {
          ...serverTarget,
          threadContinuation: true,
          continueThreadsAfterServerUpdate: true,
        },
      },
    ]);
    expect(_fixture.current!.stoppedThreads(_fixture.current!.rows[0]!.item)).toBe(0);
  });

  it("holds a server while its machine updates a provider, then offers it again", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    const running = {
      ...codexCli(),
      updateState: {
        status: "running" as const,
        startedAt: null,
        finishedAt: null,
        message: null,
        output: null,
      },
    };
    testState.environments = [remote([running])];
    await render(_fixture, [serverUpdate]);
    const server = () => _fixture.current!.rows.find(({ item }) => item.kind === "server")!;
    expect(_fixture.current!.busy(server().item)).toBe(true);
    // Dispatch reads the machine at the click, so nothing restarts it now.
    await act(async () => _fixture.current!.update(server().item));
    expect(testState.updateServer).not.toHaveBeenCalled();

    testState.environments = [remote([])];
    testState.updateServer.mockResolvedValueOnce({ status: "updated" });
    await render(_fixture, [serverUpdate]);
    expect(_fixture.current!.busy(server().item)).toBe(false);
    await act(async () => _fixture.current!.update(server().item));
    expect(testState.updateServer).toHaveBeenCalledWith(serverTarget);
  });

  it("releases a server once an interrupted queued provider update ends", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    const withUpdateState = (status: "queued" | "failed") => ({
      ...codexCli(),
      updateState: {
        status,
        startedAt: null,
        finishedAt: status === "failed" ? "2026-10-18T10:05:00.000Z" : null,
        message: status === "failed" ? "Provider update was interrupted. Try again." : null,
        output: null,
      },
    });
    testState.environments = [remote([withUpdateState("queued")])];
    await render(_fixture, [serverUpdate]);
    const server = () => _fixture.current!.rows.find(({ item }) => item.kind === "server")!;
    expect(_fixture.current!.busy(server().item)).toBe(true);

    // The server records the interrupted update as failed rather than leaving it queued.
    testState.environments = [remote([withUpdateState("failed")])];
    testState.updateServer.mockResolvedValueOnce({ status: "updated" });
    await render(_fixture, [serverUpdate]);
    expect(_fixture.current!.busy(server().item)).toBe(false);
    await act(async () => _fixture.current!.update(server().item));
    expect(testState.updateServer).toHaveBeenCalledWith(serverTarget);
  });

  it("holds a server while this card starts a provider update on its machine", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    testState.environments = [remote([codexCli()])];
    testState.updateProvider.mockImplementationOnce(() => new Promise(() => {}));
    await render(_fixture, [serverUpdate]);
    const row = (kind: string) => _fixture.current!.rows.find(({ item }) => item.kind === kind)!;
    await act(async () => _fixture.current!.update(row("provider").item));
    await render(_fixture, [serverUpdate]);
    expect(_fixture.current!.busy(row("server").item)).toBe(true);
    await act(async () => _fixture.current!.update(row("server").item));
    expect(testState.updateServer).not.toHaveBeenCalled();
  });

  it("drops a removed machine's rows", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    await render(_fixture, [serverUpdate]);
    expect(_fixture.current!.rows).toEqual([]);
    expect(_fixture.current!.circle).toBeNull();
  });

  it("reports a provider update started here", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    testState.environments = [remote([codexCli()])];
    testState.updateProvider.mockResolvedValueOnce(
      AsyncResult.failure(Cause.fail(new Error("npm exited 1"))),
    );
    await render(_fixture);
    await act(async () => _fixture.current!.update(_fixture.current!.rows[0]!.item));
    expect(testState.toasts).toEqual([{ type: "error", title: "Provider update failed" }]);
  });

  it("retries a pass's withdrawn server through the pass, keeping its confirmed target", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    testState.environments = [remote([])];
    testState.run = {
      localVersion: null,
      phase: "servers",
      restartAt: null,
      machines: [
        {
          environmentId: lab,
          label: "lab-gpu",
          updatesProviders: false,
          server: serverTarget,
          handedOffVersion: null,
          startedAt: 0,
          result: "failed",
          failure: "Not updated; it was no longer eligible when servers updated.",
          providerFailure: null,
        },
      ],
    };
    testState.updateServer.mockResolvedValueOnce({ status: "updated" });
    await render(_fixture, [serverUpdate]);
    expect(_fixture.current!.rows[0]!.state).toMatchObject({ status: "failed", retry: true });
    await act(async () => _fixture.current!.retry(_fixture.current!.rows[0]!));
    expect(testState.updateServer).toHaveBeenCalledWith(serverTarget, { quiet: false });
    expect(testState.run).toMatchObject({ machines: [{ result: null, failure: null }] });
  });
});

function _createFixture() {
  let _published_current = undefined! as ReturnType<typeof useOtherUpdates> | undefined;

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
