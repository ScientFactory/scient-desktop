import {
  render as _fixtureRender,
  type Screen,
  fakeTimers as _fixtureFakeTimers,
  act,
} from "../../../test/render";
import {
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderRuntimeOperation,
  type ServerProvider,
} from "@t3tools/contracts";
import { useLayoutEffect } from "react";

import { Atom, AtomRegistry } from "effect/reactivity";
import { describe, expect, it, vi } from "vite-plus/test";

interface TestPresentation {
  readonly connection: { readonly phase: string };
  readonly serverConfig: object | null;
}

const testState = vi.hoisted(() => ({
  readRegistry: (): AtomRegistry.AtomRegistry | undefined => undefined,
  environments: [] as Array<{
    environmentId: EnvironmentId;
    label: string;
    connection: { phase: string };
    serverConfig: object | null;
  }>,
  providers: undefined as Atom.Writable<ReadonlyArray<ServerProvider>> | undefined,
  presentations: new Map<string, Atom.Writable<TestPresentation | null>>(),
  startRuntimeAction: vi.fn<(input: unknown) => Promise<ServerProvider>>(),
  toasts: [] as Array<{ type: string; title: string }>,
}));

vi.mock("@effect/atom-react", () => ({
  useAtomValue: (atom: Atom.Atom<unknown>) => testState.readRegistry()!.get(atom),
}));
vi.mock("~/rpc/atomRegistry", () => ({
  appAtomRegistry: {
    get: (atom: Atom.Atom<unknown>) => testState.readRegistry()!.get(atom),
    update: <R, W>(atom: Atom.Writable<R, W>, f: (value: R) => W) =>
      testState.readRegistry()!.update(atom, f),
    subscribe: <A,>(
      atom: Atom.Atom<A>,
      f: (value: A) => void,
      options?: { readonly immediate?: boolean },
    ) => testState.readRegistry()!.subscribe(atom, f, options),
  },
}));
vi.mock("~/state/environments", () => ({
  useEnvironments: () => ({ environments: testState.environments }),
  useEnvironmentProviders: () =>
    new Map([[lab, testState.readRegistry()!.get(testState.providers!)]]),
}));
vi.mock("~/state/server", () => ({
  serverEnvironment: { providersValueAtom: () => testState.providers! },
}));
vi.mock("~/state/presentation", () => ({
  environmentPresentations: {
    presentationAtom: (id: string) => testState.presentations.get(id)!,
  },
}));
vi.mock("~/components/ui/toast", () => ({
  hiddenToastActionProps: { children: null },
  stackedThreadToast: (options: object) => options,
  toastManager: {
    add: (options: { type: string; title: string }) => {
      testState.toasts.push({ type: options.type, title: options.title });
      return `toast-${testState.toasts.length}`;
    },
    update: () => {},
    close: () => {},
  },
}));
vi.mock("./useProviderLifecycleController", () => ({
  useStartProviderRuntimeAction: () => testState.startRuntimeAction,
}));

import { ENVIRONMENT_CONTACT_GRACE_MS } from "./environmentUpdateWatch";
import {
  connectedProviderEnvironments,
  managedRuntimeProviderMachines,
  managedRuntimeRunOutcomes,
  managedRuntimeRunsOn,
  useManagedRuntimeUpdates,
} from "./useManagedRuntimeUpdates";

const lab = EnvironmentId.make("lab");
type Runs = Awaited<ReturnType<ReturnType<typeof useManagedRuntimeUpdates>["update"]>>;

function codex(
  patch: {
    readonly managedVersion?: string;
    readonly operation?: Partial<ProviderRuntimeOperation> | null;
    readonly updateState?: ServerProvider["updateState"];
  } = {},
): ServerProvider {
  return {
    instanceId: ProviderInstanceId.make("codex"),
    driver: ProviderDriverKind.make("codex"),
    enabled: true,
    installed: true,
    version: patch.managedVersion ?? "0.157.0",
    status: "ready",
    auth: { status: "authenticated", required: true },
    checkedAt: "2026-10-18T10:00:00.000Z",
    models: [],
    slashCommands: [],
    skills: [],
    ...(patch.updateState ? { updateState: patch.updateState } : {}),
    connection: {
      methods: [],
      canDisconnect: true,
      operation: null,
      runtime: {
        source: "scient_managed",
        supportTier: "fully_assisted",
        target: "linux-x64",
        actions: ["update", "repair", "remove"],
        managedVersion: patch.managedVersion ?? "0.157.0",
        availableManagedVersion: "0.157.1",
        previousManagedVersion: null,
        message: "Managed Codex.",
        operation: patch.operation
          ? {
              operationId: "op-1",
              action: "update",
              status: "downloading",
              startedAt: "2026-10-18T10:00:00.000Z",
              finishedAt: null,
              message: "Downloading.",
              ...patch.operation,
            }
          : null,
      },
    },
  };
}

function Probe({ _fixture }: { _fixture: _Fixture }) {
  const value = useManagedRuntimeUpdates();
  useLayoutEffect(() => {
    _fixture.publishCurrent(value);
  });
  return null;
}

function publish(
  presentation: (TestPresentation & { readonly providers?: ReadonlyArray<ServerProvider> }) | null,
) {
  const previous = testState.readRegistry()!.get(testState.presentations.get(lab)!);
  if (presentation?.providers)
    testState.readRegistry()!.set(testState.providers!, presentation.providers);
  // Provider pushes no longer replace the environment presentation.
  if (
    presentation?.connection.phase !== previous?.connection.phase ||
    (presentation?.serverConfig === null) !== (previous?.serverConfig === null)
  ) {
    testState.readRegistry()!.set(testState.presentations.get(lab)!, presentation);
  }
}
const connected = (providers: ServerProvider[]) => ({
  connection: { phase: "connected" },
  serverConfig: {},
  providers,
});

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
  testState.toasts = [];
  testState.environments = [
    {
      environmentId: lab,
      label: "lab",
      connection: { phase: "connected" },
      serverConfig: {},
    },
  ];
  testState.providers = Atom.make<ReadonlyArray<ServerProvider>>([codex()]);
  testState.presentations = new Map([
    [lab, Atom.make<TestPresentation | null>(connected([codex()]))],
  ]);
  testState.startRuntimeAction
    .mockReset()
    .mockResolvedValue(codex({ operation: { status: "preparing" } }));
  _fixture.publishCurrent(undefined);
  await act(async () => {
    _fixture.root0 = _fixture.stack.use(
      await _fixtureRender(null, { container: document.createElement("div"), router: false }),
    );
    await _fixture.root0.rerender(<Probe _fixture={_fixture} />);
  });
}

async function _cleanupFixture1(_fixture: _Fixture) {
  vi.useRealTimers();
  await act(async () => await _fixture.root0?.unmount());
}

describe("useManagedRuntimeUpdates", () => {
  it("offers one runtime per connected machine and driver", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    expect(_fixture.current!.targets).toEqual([
      {
        environmentId: lab,
        environmentLabel: "lab",
        instanceId: "codex",
        driver: "codex",
        availableVersion: "0.157.1",
      },
    ]);
  });

  it("hands off a staged runtime, then reports its later failure", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    let handedOff = false;
    let runs: Runs = [];
    await act(async () => {
      void _fixture.current!.update(_fixture.current!.targets, { inPass: true }).then((result) => {
        handedOff = true;
        runs = result;
      });
    });
    expect(testState.startRuntimeAction).toHaveBeenCalledWith({
      environmentId: lab,
      instanceId: "codex",
      action: "update",
    });
    expect(handedOff).toBe(false);

    await act(async () => {
      publish(
        connected([
          codex({
            operation: {
              status: "activating",
              waitingForIdle: true,
              message: "Waiting for a turn.",
            },
          }),
        ]),
      );
    });
    expect(handedOff).toBe(true);
    expect(runs[0]).toMatchObject({
      outcome: { status: "pending" },
      waitingMessage: "Waiting for a turn.",
    });

    await act(async () => {
      publish(connected([codex({ operation: { status: "failed", message: "Test failed." } })]));
    });
    await act(async () => await _fixture.root0!.rerender(<Probe _fixture={_fixture} />));
    expect([..._fixture.current!.runs.values()][0]).toMatchObject({
      outcome: { status: "failed", message: "Test failed." },
    });
    // The pass summarizes what settled before the handoff; this one is reported on its own.
    expect(testState.toasts.at(-1)).toMatchObject({ type: "error" });
  });

  it("joins an update already starting instead of resolving early", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    let finishStart = (_provider: ServerProvider) => {};
    testState.startRuntimeAction.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishStart = resolve;
        }),
    );
    const settled: string[] = [];
    await act(async () => {
      void _fixture.current!.update(_fixture.current!.targets).then(() => settled.push("row"));
      void _fixture
        .current!.update(_fixture.current!.targets, { inPass: true })
        .then(() => settled.push("pass"));
    });
    expect(testState.startRuntimeAction).toHaveBeenCalledOnce();
    expect(settled).toEqual([]);

    await act(async () => finishStart(codex({ operation: { status: "preparing" } })));
    expect(settled).toEqual([]);
    await act(async () => {
      publish(
        connected([codex({ managedVersion: "0.157.1", operation: { status: "succeeded" } })]),
      );
    });
    expect(settled.toSorted()).toEqual(["pass", "row"]);
    expect(testState.toasts.at(-1)).toMatchObject({ type: "success" });
  });

  it("exposes a machine's runs to the server busy rule", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    await act(async () => {
      void _fixture.current!.update(_fixture.current!.targets);
    });
    expect(managedRuntimeRunsOn(lab)).toMatchObject([{ outcome: { status: "pending" } }]);
    expect(managedRuntimeRunsOn(EnvironmentId.make("elsewhere"))).toEqual([]);
    await act(async () => publish(null));
  });

  it("fails an update whose machine is removed", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    let runs: Runs = [];
    await act(async () => {
      void _fixture.current!.update(_fixture.current!.targets).then((result) => {
        runs = result;
      });
    });
    await act(async () => publish(null));
    expect(runs).toMatchObject([{ outcome: { status: "failed" } }]);
  });

  it("waits out a short disconnection and fails one that lasts", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    _fixture.stack.use(_fixtureFakeTimers());
    let runs: Runs = [];
    await act(async () => {
      void _fixture.current!.update(_fixture.current!.targets).then((result) => {
        runs = result;
      });
    });
    await act(async () => publish({ connection: { phase: "reconnecting" }, serverConfig: null }));
    await act(async () => vi.advanceTimersByTime(ENVIRONMENT_CONTACT_GRACE_MS - 1));
    await act(async () => publish(connected([codex({ operation: { status: "installing" } })])));
    await act(async () => vi.advanceTimersByTime(ENVIRONMENT_CONTACT_GRACE_MS));
    expect(runs).toEqual([]);

    await act(async () => publish({ connection: { phase: "offline" }, serverConfig: null }));
    await act(async () => vi.advanceTimersByTime(ENVIRONMENT_CONTACT_GRACE_MS));
    expect(runs).toMatchObject([{ outcome: { status: "failed" } }]);
  });

  it("settles a failed start without following it", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    testState.startRuntimeAction.mockRejectedValueOnce(new Error("No catalog."));
    let runs: Runs = [];
    await act(async () => {
      runs = await _fixture.current!.update(_fixture.current!.targets);
    });
    expect(runs).toMatchObject([{ outcome: { status: "failed", message: "No catalog." } }]);
    expect(managedRuntimeRunOutcomes(runs)).toEqual([
      { status: "failed", line: "lab · Codex: No catalog." },
    ]);
  });
});

describe("managed runtime pass helpers", () => {
  it("counts a staged runtime as neither updated nor failed", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    const target = {
      environmentId: lab,
      environmentLabel: "lab",
      instanceId: ProviderInstanceId.make("codex"),
      driver: ProviderDriverKind.make("codex"),
      availableVersion: "0.157.1",
    };
    const run = (outcome: { status: "pending" } | { status: "succeeded"; version: string }) => ({
      target,
      operationId: "op",
      observed: true,
      outcome,
      waitingMessage: null,
    });
    expect(
      managedRuntimeRunOutcomes([
        run({ status: "pending" }),
        run({ status: "succeeded", version: "1" }),
      ]),
    ).toEqual([{ status: "updated" }]);
    expect(
      managedRuntimeProviderMachines([
        target,
        { ...target, driver: ProviderDriverKind.make("omp") },
      ]),
    ).toMatchObject([
      { environmentId: lab, label: "lab", providers: ["Codex", expect.any(String)] },
    ]);
  });

  it("reads only connected machines", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    expect(
      connectedProviderEnvironments(
        [
          {
            environmentId: lab,
            label: "lab",
            connection: { phase: "connected" },
            serverConfig: {},
          },
          {
            environmentId: EnvironmentId.make("away"),
            label: "away",
            connection: { phase: "offline" },
            serverConfig: {},
          },
        ],
        new Map(),
      ),
    ).toEqual([{ environmentId: lab, label: "lab", providers: [] }]);
  });
});

function _createFixture() {
  let _published_current = undefined! as ReturnType<typeof useManagedRuntimeUpdates> | undefined;

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
