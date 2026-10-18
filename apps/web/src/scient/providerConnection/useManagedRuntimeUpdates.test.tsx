import {
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderRuntimeOperation,
  type ServerProvider,
} from "@t3tools/contracts";
import { act, useLayoutEffect } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { Atom, AtomRegistry } from "effect/reactivity";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

interface TestPresentation {
  readonly connection: { readonly phase: string };
  readonly serverConfig: { readonly providers: ServerProvider[] } | null;
}

const testState = vi.hoisted(() => ({
  registry: undefined as AtomRegistry.AtomRegistry | undefined,
  environments: [] as Array<{
    environmentId: EnvironmentId;
    label: string;
    connection: { phase: string };
    serverConfig: { providers: ServerProvider[] } | null;
  }>,
  presentations: new Map<string, Atom.Writable<TestPresentation | null>>(),
  startRuntimeAction: vi.fn<(input: unknown) => Promise<ServerProvider>>(),
  toasts: [] as Array<{ type: string; title: string }>,
}));

vi.mock("@effect/atom-react", () => ({
  useAtomValue: (atom: Atom.Atom<unknown>) => testState.registry!.get(atom),
}));
vi.mock("~/rpc/atomRegistry", () => ({
  appAtomRegistry: {
    get: (atom: Atom.Atom<unknown>) => testState.registry!.get(atom),
    update: <R, W>(atom: Atom.Writable<R, W>, f: (value: R) => W) =>
      testState.registry!.update(atom, f),
    subscribe: <A,>(
      atom: Atom.Atom<A>,
      f: (value: A) => void,
      options?: { readonly immediate?: boolean },
    ) => testState.registry!.subscribe(atom, f, options),
  },
}));
vi.mock("~/state/environments", () => ({
  useEnvironments: () => ({ environments: testState.environments }),
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
  useManagedRuntimeUpdates,
  waitForMachineUpdatesToSettle,
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

let renderer: ReactTestRenderer | undefined;
let current: ReturnType<typeof useManagedRuntimeUpdates> | undefined;
function Probe() {
  const value = useManagedRuntimeUpdates();
  useLayoutEffect(() => {
    current = value;
  });
  return null;
}

function publish(presentation: TestPresentation | null) {
  testState.registry!.set(testState.presentations.get(lab)!, presentation);
}
const connected = (providers: ServerProvider[]): TestPresentation => ({
  connection: { phase: "connected" },
  serverConfig: { providers },
});

beforeEach(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  testState.registry = AtomRegistry.make();
  testState.toasts = [];
  testState.environments = [
    {
      environmentId: lab,
      label: "lab",
      connection: { phase: "connected" },
      serverConfig: { providers: [codex()] },
    },
  ];
  testState.presentations = new Map([
    [lab, Atom.make<TestPresentation | null>(connected([codex()]))],
  ]);
  testState.startRuntimeAction
    .mockReset()
    .mockResolvedValue(codex({ operation: { status: "preparing" } }));
  current = undefined;
  await act(() => {
    renderer = create(<Probe />);
  });
});

afterEach(async () => {
  vi.useRealTimers();
  await act(() => renderer?.unmount());
  testState.registry?.dispose();
  vi.unstubAllGlobals();
});

describe("useManagedRuntimeUpdates", () => {
  it("offers one runtime per connected machine and driver", () => {
    expect(current!.targets).toEqual([
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
    let handedOff = false;
    let runs: Runs = [];
    await act(async () => {
      void current!.update(current!.targets, { inPass: true }).then((result) => {
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
    await act(() => renderer!.update(<Probe />));
    expect([...current!.runs.values()][0]).toMatchObject({
      outcome: { status: "failed", message: "Test failed." },
    });
    // The pass summarizes what settled before the handoff; this one is reported on its own.
    expect(testState.toasts.at(-1)).toMatchObject({ type: "error" });
  });

  it("joins an update already starting instead of resolving early", async () => {
    let finishStart = (_provider: ServerProvider) => {};
    testState.startRuntimeAction.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishStart = resolve;
        }),
    );
    const settled: string[] = [];
    await act(async () => {
      void current!.update(current!.targets).then(() => settled.push("row"));
      void current!.update(current!.targets, { inPass: true }).then(() => settled.push("pass"));
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

  it("fails an update whose machine is removed", async () => {
    let runs: Runs = [];
    await act(async () => {
      void current!.update(current!.targets).then((result) => {
        runs = result;
      });
    });
    await act(async () => publish(null));
    expect(runs).toMatchObject([{ outcome: { status: "failed" } }]);
  });

  it("waits out a short disconnection and fails one that lasts", async () => {
    vi.useFakeTimers();
    let runs: Runs = [];
    await act(async () => {
      void current!.update(current!.targets).then((result) => {
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
    testState.startRuntimeAction.mockRejectedValueOnce(new Error("No catalog."));
    let runs: Runs = [];
    await act(async () => {
      runs = await current!.update(current!.targets);
    });
    expect(runs).toMatchObject([{ outcome: { status: "failed", message: "No catalog." } }]);
    expect(managedRuntimeRunOutcomes(runs)).toEqual([
      { status: "failed", line: "lab · Codex: No catalog." },
    ]);
  });
});

describe("waitForMachineUpdatesToSettle", () => {
  it("holds a server restart until the machine's provider updates finish or hand off", async () => {
    publish(
      connected([
        codex({
          updateState: {
            status: "running",
            startedAt: null,
            finishedAt: null,
            message: null,
            output: null,
          },
        }),
      ]),
    );
    let ready = false;
    await act(async () => {
      void waitForMachineUpdatesToSettle(lab).then(() => {
        ready = true;
      });
    });
    expect(ready).toBe(false);
    await act(async () => publish(connected([codex({ operation: { status: "downloading" } })])));
    expect(ready).toBe(false);
    await act(async () =>
      publish(connected([codex({ operation: { status: "activating", waitingForIdle: true } })])),
    );
    expect(ready).toBe(true);
  });

  it("does not wait for a removed machine", async () => {
    publish(null);
    await expect(waitForMachineUpdatesToSettle(lab)).resolves.toBeUndefined();
  });
});

describe("managed runtime pass helpers", () => {
  it("counts a staged runtime as neither updated nor failed", () => {
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

  it("reads only connected machines", () => {
    expect(
      connectedProviderEnvironments([
        {
          environmentId: lab,
          label: "lab",
          connection: { phase: "connected" },
          serverConfig: { providers: [] },
        },
        {
          environmentId: EnvironmentId.make("away"),
          label: "away",
          connection: { phase: "offline" },
          serverConfig: { providers: [] },
        },
      ]),
    ).toEqual([{ environmentId: lab, label: "lab", providers: [] }]);
  });
});
